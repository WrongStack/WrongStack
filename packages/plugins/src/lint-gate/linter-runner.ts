import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isPidAlive, scriptSpawnArgs } from '@wrongstack/core/utils';
import { BoundedMap } from '../runtime/index.js';

export type Linter = 'biome' | 'eslint' | 'auto';

// ---------------------------------------------------------------------------
// Linter detection
// ---------------------------------------------------------------------------

/**
 * Detect which linter is available. "auto" tries biome first, then eslint.
 * Returns the linter command + args prefix, or null if neither is found.
 *
 * Performance: caches the detection result per cwd so repeated hook
 * invocations don't re-probe the filesystem. The cache is invalidated
 * on setup() reload.
 */
interface CommandResult {
  stdout: string;
  error: Error | null;
}

interface ResolvedLinter {
  /** Always the current Node executable; never a shell or package-manager shim. */
  cmd: string;
  /** Local package bin entry followed by linter-specific arguments. */
  args: string[];
  name: 'biome' | 'eslint';
}

/**
 * The would-be content is linted from a temp file outside the project. With
 * `vcs.useIgnoreFile: true` (what `biome init` writes in a git repository)
 * Biome panics on such a path — "path is expected to be under the root",
 * exit 101 — so every lint call failed and the gate let every write through.
 * Ignore files cannot apply to a path outside the project anyway.
 */
const BIOME_TEMP_FILE_FLAGS = ['--vcs-use-ignore-file=false'];

function hasBiomeTempFlags(args: readonly string[]): boolean {
  return BIOME_TEMP_FILE_FLAGS.some((flag) => args.includes(flag));
}

function withoutBiomeTempFlags(args: readonly string[]): string[] {
  return args.filter((arg) => !BIOME_TEMP_FILE_FLAGS.includes(arg));
}

const LINTER_PACKAGES = {
  biome: '@biomejs/biome',
  eslint: 'eslint',
} as const;

/**
 * Module-scope cache for linter detection results. Keyed by cwd.
 * Cleared on setup() to ensure fresh detection after config changes.
 *
 * @internal
 */
export const linterCache = new BoundedMap<string, ResolvedLinter | null>({
  max: 32,
  ttlMs: 300_000,
});

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Resolve a linter's project-local JavaScript bin entry from package metadata.
 * Using `node <entry>` avoids npx, shell configuration, and Windows `.cmd`
 * shims while still respecting Node's normal project-local package lookup.
 */
export function resolveLocalLinter(name: 'biome' | 'eslint', cwd: string): ResolvedLinter | null {
  try {
    const packageName = LINTER_PACKAGES[name];
    const requireFromProject = createRequire(resolve(cwd, 'package.json'));
    const packagePath = requireFromProject.resolve(`${packageName}/package.json`);
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8').replace(/^\uFEFF/, '')) as {
      bin?: string | Record<string, string>;
    };
    const relativeBin =
      typeof packageJson.bin === 'string'
        ? packageJson.bin
        : (packageJson.bin?.[name] ?? Object.values(packageJson.bin ?? {})[0]);
    if (!relativeBin || isAbsolute(relativeBin)) return null;

    const packageDir = dirname(packagePath);
    const entry = resolve(packageDir, relativeBin);
    if (!isInside(packageDir, entry)) return null;

    return {
      cmd: process.execPath,
      args:
        name === 'biome'
          ? scriptSpawnArgs(entry, ['check', '--reporter=json', ...BIOME_TEMP_FILE_FLAGS])
          : scriptSpawnArgs(entry, ['--format=json']),
      name,
    };
  } catch {
    return null;
  }
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    try {
      execFile(
        command,
        args,
        {
          encoding: 'utf-8',
          timeout: timeoutMs,
          cwd,
          windowsHide: true,
          shell: false,
          maxBuffer: 2 * 1024 * 1024,
          ...(signal ? { signal } : {}),
        },
        (error, stdout) => resolveResult({ stdout, error }),
      );
    } catch (err) {
      resolveResult({ stdout: '', error: err instanceof Error ? err : new Error(String(err)) });
    }
  });
}

export async function detectLinter(requested: Linter, cwd: string): Promise<ResolvedLinter | null> {
  // Check cache first — avoids redundant filesystem probes on every hook call.
  const cacheKey = `${requested}:${cwd}`;
  const cached = linterCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const candidates: Array<'biome' | 'eslint'> =
    requested === 'auto' ? ['biome', 'eslint'] : [requested];

  for (const name of candidates) {
    const linter = resolveLocalLinter(name, cwd);
    if (!linter) continue;
    const probe = await runCommand(linter.cmd, [linter.args[0]!, '--version'], 5_000, cwd);
    if (!probe.error) {
      linterCache.set(cacheKey, linter);
      return linter;
    }
  }

  linterCache.set(cacheKey, null);
  return null;
}

// ---------------------------------------------------------------------------
// Temp directories
// ---------------------------------------------------------------------------

/**
 * Temp dirs carry the owning process id (`lint-gate-<pid>-XXXXXX`) so a later
 * process can prove a leftover is an orphan. Dirs from before this naming have
 * no owner on record and are never swept.
 */
const OWNED_TEMP_DIR = /^lint-gate-(?:fix-)?(\d+)-[A-Za-z0-9]{6}$/;
/** A dir younger than this may belong to a process whose pid was just reused. */
export const ORPHAN_MIN_AGE_MS = 10 * 60_000;

function tempDirPrefix(kind: 'lint' | 'fix'): string {
  return join(tmpdir(), `${kind === 'fix' ? 'lint-gate-fix-' : 'lint-gate-'}${process.pid}-`);
}

/**
 * Remove temp dirs a lint-gate process left behind when it was killed between
 * `mkdtemp` and its `finally` cleanup (#363); `finally` never runs after a hard
 * termination. A dir is removed only when it is positively ours: its name
 * carries an owner pid that is no longer alive, it holds nothing but the single
 * `input.<ext>` file lint-gate writes, and it is older than
 * {@link ORPHAN_MIN_AGE_MS}. Anything else is left alone.
 *
 * @returns the removed directories
 */
export async function sweepOrphanedTempDirs(
  root: string = tmpdir(),
  now: number = Date.now(),
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const owner = OWNED_TEMP_DIR.exec(name);
    if (!owner || isPidAlive(Number(owner[1]))) continue;
    const dir = join(root, name);
    try {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || now - stat.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
      const entries = await readdir(dir, { withFileTypes: true });
      const onlyInput = entries.every((e) => e.isFile() && /^input(\.[^.]+)*$/.test(e.name));
      if (entries.length > 1 || !onlyInput) continue;
      await rm(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Another sweeper got there first, or the entry is not ours to read.
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Linter execution
// ---------------------------------------------------------------------------

export interface LintIssue {
  severity: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
  line?: number;
}

/**
 * Run the linter on a temp file and parse the output.
 * Returns the list of issues found, or null if the linter itself failed.
 */
export async function lintContent(
  content: string,
  filePath: string,
  linter: ResolvedLinter,
  timeoutMs: number,
  cwd: string,
  signal: AbortSignal,
): Promise<LintIssue[] | null> {
  // Create a temp directory and write the content with the same extension
  // as the target file so the linter applies the right rules.
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '.ts';
  let tmpDir: string | undefined;
  try {
    tmpDir = await mkdtemp(tempDirPrefix('lint'));
    const tmpFile = join(tmpDir, `input${ext}`);
    await writeFile(tmpFile, content, 'utf-8');
    const fullArgs = [...linter.args, tmpFile];
    let result = await runCommand(linter.cmd, fullArgs, timeoutMs, cwd, signal);
    // A Biome too old for the VCS flag rejects it as a usage error; retry once
    // without it rather than turn a working gate into one that always fails.
    if (result.error && !result.stdout && !signal.aborted && hasBiomeTempFlags(fullArgs)) {
      result = await runCommand(
        linter.cmd,
        withoutBiomeTempFlags(fullArgs),
        timeoutMs,
        cwd,
        signal,
      );
    }
    if (signal.aborted) throw signal.reason;
    // Linters commonly exit non-zero when findings exist; JSON remains stdout.
    if (result.error && !result.stdout) return null;
    return parseLinterOutput(result.stdout, linter.name);
  } catch {
    if (signal.aborted) throw signal.reason;
    return null;
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Run the linter with auto-fix enabled, returning the fixed content.
 * Biome: `biome check --write`. ESLint: `eslint --fix`.
 *
 * The fix runs on the SAME temp file as `lintContent`. After the
 * linter exits, the file is read back and returned. If the linter
 * fails or the content is unchanged, the original content is returned
 * (so the caller falls through to warn mode gracefully).
 *
 * @internal
 */
export async function lintAndFix(
  content: string,
  filePath: string,
  linter: ResolvedLinter,
  timeoutMs: number,
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '.ts';
  let tmpDir: string | undefined;
  try {
    tmpDir = await mkdtemp(tempDirPrefix('fix'));
    const tmpFile = join(tmpDir, `input${ext}`);
    await writeFile(tmpFile, content, 'utf-8');
    // Build the fix command: biome uses `check --write`, eslint uses `--fix`.
    const fixArgs =
      linter.name === 'biome'
        ? [linter.args[0]!, 'check', '--write', ...BIOME_TEMP_FILE_FLAGS, tmpFile]
        : [linter.args[0]!, '--fix', tmpFile];
    const fixRun = await runCommand(linter.cmd, fixArgs, timeoutMs, cwd, signal);
    // Same old-Biome fallback as lintContent. A non-zero exit can also mean
    // "unfixable findings remain", so retry only when nothing was rewritten;
    // a second fix pass is idempotent either way.
    if (
      fixRun.error &&
      !signal.aborted &&
      hasBiomeTempFlags(fixArgs) &&
      (await readFile(tmpFile, 'utf-8')) === content
    ) {
      await runCommand(linter.cmd, withoutBiomeTempFlags(fixArgs), timeoutMs, cwd, signal);
    }
    if (signal.aborted) throw signal.reason;
    // Linters may exit non-zero after partial fixes; read the temp file anyway.
    return await readFile(tmpFile, 'utf-8');
  } catch {
    if (signal.aborted) throw signal.reason;
    return content; // any error → return original
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Parse linter JSON output into a flat list of issues.
 * Biome: `{ diagnostics: [{ category, severity, description, location }] }`
 * ESLint: `[{ messages: [{ ruleId, severity, message, line }] }]`
 */
function parseLinterOutput(stdout: string, linterName: string): LintIssue[] {
  const issues: LintIssue[] = [];
  try {
    const data = JSON.parse(stdout);
    if (linterName === 'biome') {
      for (const d of data.diagnostics ?? []) {
        const cat = d.category ?? 'unknown';
        // `biome check` also reports formatting (`format`) and assists
        // (`assist/source/organizeImports`) at severity error. Neither is a
        // lint finding — format-on-save and import-organizer apply them after
        // the write — yet they flagged nearly every write a model produced.
        if (cat === 'format' || String(cat).startsWith('assist/')) continue;
        const sev =
          d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info';
        issues.push({
          severity: sev,
          rule: cat,
          // Biome 2 reports `message` and `location.start.line`; `span` is a
          // character offset, never a line number.
          message:
            typeof d.message === 'string'
              ? d.message
              : typeof d.description === 'string'
                ? d.description
                : cat,
          line: typeof d.location?.start?.line === 'number' ? d.location.start.line : undefined,
        });
      }
    } else {
      // eslint: array of file results
      for (const file of Array.isArray(data) ? data : []) {
        for (const m of file.messages ?? []) {
          const sev = m.severity === 2 ? 'error' : m.severity === 1 ? 'warning' : 'info';
          issues.push({
            severity: sev,
            rule: m.ruleId ?? 'unknown',
            message: m.message ?? '',
            line: m.line,
          });
        }
      }
    }
  } catch {
    // parse error — treat as no issues
  }
  return issues;
}
