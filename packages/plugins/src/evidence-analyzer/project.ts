/**
 * Project mode for the evidence analyzers.
 *
 * Called with neither `path` nor `content`, an analyzer that declares a
 * `project` collector inspects the calling project itself instead of waiting
 * for the model to paste evidence. Collectors read manifests, lockfile names
 * and source files inside the project root, and a few run read-only
 * `git diff` / `git status` through the repository isolation environment.
 * None of them runs a project script, installs anything or writes a file.
 */
import { execFile } from 'node:child_process';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildChildEnv } from '@wrongstack/core/utils';
import { gitIsolationEnv } from '@wrongstack/primitives';
import { parse as parseYaml } from 'yaml';
import { safePath } from '../runtime/sandbox.js';

export interface EvidenceFinding {
  rule: string;
  severity: 'info' | 'warning' | 'error';
  /** Project-relative file the finding is about (project mode). */
  file?: string;
  /** 1-based line, or 0 when the finding concerns a whole file. */
  line: number;
  excerpt: string;
  advice: string;
}

export interface ProjectCollectContext {
  root: string;
  signal: AbortSignal;
  /** The plugin's `extensions.<name>` block, for collector-specific options. */
  options: Record<string, unknown>;
}

export interface ProjectCollection {
  findings: EvidenceFinding[];
  /** Project-relative files (or git commands) the collector looked at. */
  inspected: string[];
  /** Small structured facts worth returning alongside findings. */
  facts?: Record<string, unknown>;
  /** Honest scope statement for this collection. */
  limitation: string;
}

export interface ProjectCollector {
  /** One sentence for the tool description: what project mode inspects. */
  description: string;
  collect(context: ProjectCollectContext): Promise<ProjectCollection>;
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/**
 * Canonical path of `relPath` when it exists inside the project, else `null`.
 *
 * Every path a collector touches can come from a repository-controlled
 * manifest (`"workspaces": ["../x"]`, `"exports": "../../secret.ts"`) and the
 * tools run with `auto` permission, so containment is checked here, at the
 * one choke point, with symlinks and junctions resolved.
 */
function contained(root: string, relPath: string): string | null {
  return safePath(relPath, { projectRoot: root });
}

/** Read a regular file inside the project as UTF-8; `null` if absent, outside, not a file or too large. */
export async function readText(
  root: string,
  relPath: string,
  maxBytes = MAX_TEXT_BYTES,
): Promise<string | null> {
  const absolute = contained(root, relPath);
  if (absolute === null) return null;
  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.size > maxBytes) return null;
    const handle = await open(absolute, 'r');
    try {
      return (await handle.readFile()).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

/** Parse a JSON file; `undefined` when absent, `null` when present but unparsable. */
export async function readJson(
  root: string,
  relPath: string,
): Promise<JsonRecord | null | undefined> {
  const text = await readText(root, relPath);
  if (text === null) return undefined;
  try {
    return asRecord(JSON.parse(text.replace(/^﻿/, ''))) ?? null;
  } catch {
    return null;
  }
}

/** Does `relPath` exist inside the project (symlinks resolved, escapes rejected)? */
export async function exists(root: string, relPath: string): Promise<boolean> {
  // safePath resolves a missing leaf against its parent, so containment
  // alone does not prove the file is there.
  const absolute = contained(root, relPath);
  if (absolute === null) return false;
  try {
    await lstat(absolute);
    return true;
  } catch {
    return false;
  }
}

export const LOCKFILES: Readonly<Record<string, string>> = {
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'pnpm-lock.yaml': 'pnpm',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'yarn',
};

/** Lockfile names present directly in `dir` (project-relative). */
export async function lockfilesIn(root: string, dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of Object.keys(LOCKFILES)) {
    if (await exists(root, dir === '.' ? name : `${dir}/${name}`)) found.push(name);
  }
  return found;
}

/** Package manager named by `packageManager` ("pnpm@9.1.0" → "pnpm"). */
export function declaredPackageManager(pkg: JsonRecord | null | undefined): string | null {
  const value = pkg?.['packageManager'];
  if (typeof value !== 'string') return null;
  const name = value.split('@')[0]?.trim();
  return name ? name : null;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.temp_files',
  'target',
  'vendor',
]);

/** Expand workspace globs (`packages/*`, `apps/**`) to directories holding a package.json. */
async function expandWorkspaceGlob(root: string, pattern: string): Promise<string[]> {
  const segments = pattern.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..') || /^(?:[A-Za-z]:|\/|\\)/.test(pattern))
    return [];
  let current = ['.'];
  for (const segment of segments) {
    const next: string[] = [];
    for (const dir of current) {
      if (segment === '**') {
        next.push(...(await descendants(root, dir, 3)));
      } else if (segment.includes('*') || segment.includes('?')) {
        // Glob wildcards only: `*` = zero or more chars, `?` = exactly one.
        // Every other regex metacharacter stays literal. `?` must be converted
        // here — left in place it becomes a regex quantifier (or, in a segment
        // without `*`, the whole pattern was treated as a literal dir name).
        const matcher = new RegExp(
          `^${segment
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]')}$`,
        );
        for (const child of await childDirs(root, dir)) {
          if (matcher.test(child)) next.push(dir === '.' ? child : `${dir}/${child}`);
        }
      } else {
        next.push(dir === '.' ? segment : `${dir}/${segment}`);
      }
    }
    current = next;
  }
  const result: string[] = [];
  for (const dir of current) if (await exists(root, `${dir}/package.json`)) result.push(dir);
  return result;
}

async function childDirs(root: string, dir: string): Promise<string[]> {
  const absolute = dir === '.' ? root : contained(root, dir);
  if (absolute === null) return [];
  try {
    const entries = await readdir(absolute, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

async function descendants(root: string, dir: string, depth: number): Promise<string[]> {
  const out = [dir];
  if (depth === 0) return out;
  for (const child of await childDirs(root, dir)) {
    out.push(...(await descendants(root, dir === '.' ? child : `${dir}/${child}`, depth - 1)));
  }
  return out;
}

export interface WorkspaceInfo {
  /** Workspace globs as declared (package.json `workspaces` or pnpm-workspace.yaml). */
  patterns: string[];
  /** Globs that resolved to no package directory. */
  emptyPatterns: string[];
  /** Project-relative package directories, root excluded. */
  packages: string[];
}

/** Resolve declared workspace packages; empty when the project is not a workspace. */
export async function resolveWorkspaces(
  root: string,
  rootPkg: JsonRecord | null | undefined,
): Promise<WorkspaceInfo> {
  const patterns: string[] = [];
  const declared = rootPkg?.['workspaces'];
  const list = Array.isArray(declared) ? declared : asRecord(declared)?.['packages'];
  if (Array.isArray(list)) patterns.push(...list.filter((p): p is string => typeof p === 'string'));
  const pnpmYaml = await readText(root, 'pnpm-workspace.yaml');
  if (pnpmYaml) {
    try {
      const parsed = asRecord(parseYaml(pnpmYaml));
      const pkgs = parsed?.['packages'];
      if (Array.isArray(pkgs))
        patterns.push(...pkgs.filter((p): p is string => typeof p === 'string'));
    } catch {
      // A malformed pnpm-workspace.yaml is reported by the collectors that need it.
    }
  }
  const include = patterns.filter((p) => !p.startsWith('!'));
  const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  const packages = new Set<string>();
  const emptyPatterns: string[] = [];
  for (const pattern of include) {
    const dirs = (await expandWorkspaceGlob(root, pattern)).filter((d) => d !== '.');
    if (dirs.length === 0) emptyPatterns.push(pattern);
    for (const dir of dirs) packages.add(dir);
  }
  for (const pattern of exclude) {
    for (const dir of await expandWorkspaceGlob(root, pattern)) packages.delete(dir);
  }
  return { patterns, emptyPatterns, packages: [...packages].sort() };
}

export interface WalkOptions {
  extensions: ReadonlySet<string>;
  maxFiles: number;
  signal: AbortSignal;
  /** Directory names skipped in addition to the build/vendor defaults. */
  skip?: ReadonlySet<string>;
}

/** Bounded breadth-first walk returning project-relative file paths; `truncated` when maxFiles hit. */
export async function walkFiles(
  root: string,
  options: WalkOptions,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const queue = ['.'];
  while (queue.length > 0) {
    options.signal.throwIfAborted();
    const dir = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = dir === '.' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (
          !SKIP_DIRS.has(entry.name) &&
          !options.skip?.has(entry.name) &&
          !entry.name.startsWith('.')
        )
          queue.push(path);
      } else if (entry.isFile()) {
        const dot = entry.name.lastIndexOf('.');
        if (dot > 0 && options.extensions.has(entry.name.slice(dot))) {
          files.push(path);
          if (files.length >= options.maxFiles) return { files, truncated: true };
        }
      }
    }
  }
  return { files, truncated: false };
}

/**
 * Run a read-only git command in the project. Returns `null` when git is
 * missing, the directory is not a repository, or the repository's config
 * names programs that cannot be switched off (same refusal as diff-summary).
 */
export async function gitRead(
  root: string,
  args: string[],
  signal: AbortSignal,
): Promise<string | null> {
  const isolation = await gitIsolationEnv(root, { timeoutMs: 3000, baseEnv: buildChildEnv() });
  if (!isolation) return null;
  signal.throwIfAborted();
  return new Promise((resolveRun) => {
    execFile(
      'git',
      // Without quotepath=false git octal-escapes non-ASCII paths in
      // --name-only and `+++` headers, and they then match no file.
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        signal,
        env: { ...buildChildEnv(), ...isolation },
      },
      (error, stdout) => resolveRun(error ? null : stdout),
    );
  });
}

/** Files changed against HEAD (staged + unstaged) plus untracked files, deduplicated. */
export async function changedFiles(root: string, signal: AbortSignal): Promise<string[] | null> {
  const tracked = await gitRead(root, ['diff', 'HEAD', '--name-only', '--no-renames'], signal);
  if (tracked === null) return null;
  const untracked =
    (await gitRead(root, ['ls-files', '--others', '--exclude-standard'], signal)) ?? '';
  return [
    ...new Set(
      `${tracked}\n${untracked}`
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}

/** Keep at most `perRule` findings per rule; return the kept list and the full per-rule counts. */
export function capPerRule(
  findings: readonly EvidenceFinding[],
  perRule: number,
): { findings: EvidenceFinding[]; ruleCounts: Record<string, number>; suppressed: number } {
  const ruleCounts: Record<string, number> = {};
  const kept: EvidenceFinding[] = [];
  for (const finding of findings) {
    const count = (ruleCounts[finding.rule] ?? 0) + 1;
    ruleCounts[finding.rule] = count;
    if (count <= perRule) kept.push(finding);
  }
  return { findings: kept, ruleCounts, suppressed: findings.length - kept.length };
}

/** Is this a test file by common naming conventions? */
export function isTestPath(path: string): boolean {
  return (
    /(?:^|\/)(?:tests?|__tests__|spec|e2e)\//.test(path) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$/.test(path)
  );
}

export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.py',
  '.go',
  '.rs',
]);
