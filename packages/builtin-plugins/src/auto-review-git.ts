import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { gitIsolationEnv } from '@wrongstack/primitives';
import { statusUnderPrefix } from './git-porcelain.js';

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified';
}

export interface ChangedFileSnapshot extends ChangedFile {
  content: string;
  fingerprint: string;
}

export const MAX_SNAPSHOT_FILE_BYTES = 256 * 1024;
export const MAX_SNAPSHOT_TOTAL_BYTES = 8 * 1024 * 1024;

interface CachedGitIsolationEntry {
  mtimeMs: number;
  size: number;
  envSig: string;
  cachedAt: number;
  isolation: Record<string, string>;
}

const gitIsolationCache = new Map<string, CachedGitIsolationEntry>();
const GIT_ISOLATION_CACHE_TTL_MS = 30_000;

function computeGitEnvSignature(): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase().startsWith('GIT_') && v !== undefined) {
      parts.push(`${k}=${v}`);
    }
  }
  parts.sort();
  return parts.join('\0');
}

export async function resolveCachedGitIsolation(
  cwd: string,
): Promise<Record<string, string> | undefined> {
  const envSig = computeGitEnvSignature();
  if (!process.env['GIT_DIR'] && !process.env['GIT_WORK_TREE']) {
    try {
      const cfgStat = await fsp.stat(path.join(cwd, '.git', 'config'));
      if (cfgStat.isFile()) {
        const key = path.resolve(cwd);
        const now = Date.now();
        const hit = gitIsolationCache.get(key);
        if (
          hit &&
          now - hit.cachedAt < GIT_ISOLATION_CACHE_TTL_MS &&
          hit.mtimeMs === cfgStat.mtimeMs &&
          hit.size === cfgStat.size &&
          hit.envSig === envSig
        ) {
          return hit.isolation;
        }
        const resolved = await gitIsolationEnv(cwd);
        if (resolved) {
          if (gitIsolationCache.size >= 64) {
            const oldestKey = gitIsolationCache.keys().next().value;
            if (oldestKey !== undefined) gitIsolationCache.delete(oldestKey);
          }
          gitIsolationCache.set(key, {
            mtimeMs: cfgStat.mtimeMs,
            size: cfgStat.size,
            envSig,
            cachedAt: now,
            isolation: resolved,
          });
        }
        return resolved;
      }
    } catch {
      // Subdirectory, linked worktree, or non-git directory — delegate directly.
    }
  }
  return gitIsolationEnv(cwd);
}

export async function runGit(
  args: string[],
  cwd: string,
  preResolvedIsolation?: Record<string, string> | null,
): Promise<{ stdout: string; stderr: string; code: number }> {
  // The repository's config names programs git runs (fsmonitor, filters);
  // when they cannot be switched off, git does not run.
  const isolation =
    preResolvedIsolation !== undefined
      ? preResolvedIsolation
      : await resolveCachedGitIsolation(cwd);
  if (!isolation) return { stdout: '', stderr: 'git isolation unavailable', code: 1 };
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        env: { ...process.env, ...isolation },
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(15_000),
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    // Decode across chunks: `+= chunk` decodes each Buffer alone and turns a
    // multibyte UTF-8 character split at a pipe-chunk boundary into U+FFFD.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => {
      stdout += d;
    });
    child.stderr?.on('data', (d) => {
      stderr += d;
    });
    child.on('error', () => resolve({ stdout, stderr, code: 1 }));
    // `code` is null only when git was killed by a signal — never a success.
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await runGit(['rev-parse', '--git-dir'], cwd);
  return r.code === 0;
}

export interface ChangedFilesWithGitMeta {
  files: ChangedFile[];
  allChangedFiles: Array<{ path: string; status: string }>;
  isolation: Record<string, string>;
}

export interface ChangedSnapshotsWithGitMeta {
  snapshots: ChangedFileSnapshot[];
  allChangedFiles: Array<{ path: string; status: string }>;
  isolation: Record<string, string>;
}

async function resolveCwdGitPrefix(
  cwd: string,
  isolation: Record<string, string>,
): Promise<string | null> {
  // Fast path: when `.git` lives directly inside `cwd` (and no GIT_DIR /
  // GIT_WORK_TREE override redirects the worktree), `cwd` IS the repository
  // root so `--show-prefix` is guaranteed to be `""` without spawning git.exe.
  if (!process.env['GIT_DIR'] && !process.env['GIT_WORK_TREE']) {
    try {
      await fsp.access(path.join(cwd, '.git'));
      return '';
    } catch {
      // Subdirectory or bare worktree — fall back to `git rev-parse --show-prefix`.
    }
  }
  const prefixRes = await runGit(['rev-parse', '--show-prefix'], cwd, isolation);
  return prefixRes.code === 0 ? prefixRes.stdout.trim() : null;
}

export async function getChangedFilesWithMetaIfRepo(
  cwd: string,
): Promise<ChangedFilesWithGitMeta | null> {
  const isolation = await resolveCachedGitIsolation(cwd);
  if (!isolation) return null;
  // -z: line output C-quotes names with spaces/non-ASCII (`"my notes.ts"`), and a
  // quoted path fails every later read, so the file silently left the review.
  const [r, prefix] = await Promise.all([
    runGit(['status', '--porcelain', '-z'], cwd, isolation),
    resolveCwdGitPrefix(cwd, isolation),
  ]);
  if (r.code !== 0 || prefix === null) return null;
  const allChangedFiles = statusUnderPrefix(r.stdout, prefix);
  const files: ChangedFile[] = [];
  for (const { path: filePath, status } of allChangedFiles) {
    if (status === '??' || status === '!!') continue;
    if (status.includes('A')) {
      files.push({ path: filePath, status: 'added' });
    } else if (status.includes('M') || status.startsWith('R') || status.startsWith('C')) {
      files.push({ path: filePath, status: 'modified' });
    }
  }
  return { files, allChangedFiles, isolation };
}

export async function getChangedFilesIfRepo(cwd: string): Promise<ChangedFile[] | null> {
  const meta = await getChangedFilesWithMetaIfRepo(cwd);
  return meta ? meta.files : null;
}

export async function getChangedFiles(cwd: string): Promise<ChangedFile[]> {
  return (await getChangedFilesIfRepo(cwd)) ?? [];
}

export async function snapshotChangedFilesWithMetaIfRepo(
  cwd: string,
): Promise<ChangedSnapshotsWithGitMeta | null> {
  const meta = await getChangedFilesWithMetaIfRepo(cwd);
  if (!meta) return null;
  const snapshots: ChangedFileSnapshot[] = [];
  let budget = MAX_SNAPSHOT_TOTAL_BYTES;
  for (const file of meta.files) {
    if (file.path.startsWith('.wrongstack/')) continue;
    if (budget <= 0) break;
    try {
      const stat = await fsp.stat(path.join(cwd, file.path));
      if (!stat.isFile() || stat.size > MAX_SNAPSHOT_FILE_BYTES) continue;
      const content = await fsp.readFile(path.join(cwd, file.path), 'utf8');
      budget -= content.length;
      snapshots.push({
        ...file,
        content,
        fingerprint: createHash('sha256').update(content).digest('hex'),
      });
    } catch {
      // File deleted, unreadable, or not a regular UTF-8 file — skip it.
    }
  }
  return {
    snapshots,
    allChangedFiles: meta.allChangedFiles,
    isolation: meta.isolation,
  };
}

export async function snapshotChangedFilesIfRepo(
  cwd: string,
): Promise<ChangedFileSnapshot[] | null> {
  const meta = await snapshotChangedFilesWithMetaIfRepo(cwd);
  return meta ? meta.snapshots : null;
}

export async function snapshotChangedFiles(cwd: string): Promise<ChangedFileSnapshot[]> {
  return (await snapshotChangedFilesIfRepo(cwd)) ?? [];
}
