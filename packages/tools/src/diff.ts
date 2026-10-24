import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Tool } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import { buildChildEnv } from '@wrongstack/core/utils';
import { gitIsolationEnv } from '@wrongstack/primitives';
import { mapWithConcurrency } from './_concurrency.js';
import { safeResolveReal } from './_util.js';

/**
 * Per-file cap for the line-numbered dump path. The dump reads the whole file
 * into memory, splits it into an array of lines, and returns everything to the
 * model context — unbounded, that is both an OOM vector and a context bomb.
 * Mirrors the read tool's 5 MiB guard; files over the cap are skipped with an
 * explanatory note and `truncated: true`.
 */
const MAX_FILE_DUMP_BYTES = 5 * 1024 * 1024;

export type DiffMode = 'unified' | 'side-by-side' | 'stat';

export interface DiffInput {
  path?: string | undefined;
  files?: string | string[] | undefined;
  a?: string | undefined;
  b?: string | undefined;
  staged?: boolean | undefined;
  mode?: DiffMode | undefined;
  context?: number | undefined;
}

export interface DiffOutput {
  diff: string;
  files: string[];
  truncated: boolean;
  /**
   * The format actually produced: 'unified' or 'stat' on the git path,
   * 'dump' on the files-only line-numbered dump path.
   */
  mode: string;
  note?: string | undefined;
}

export const diffTool: Tool<DiffInput, DiffOutput> = {
  name: 'diff',
  category: 'Filesystem',
  description:
    'Show file content with line numbers, staged/working-tree diffs via git, or commit/branch diffs. A safer and more structured alternative to raw `git diff` via shell.',
  usageHint:
    'USE FOR CODE REVIEW AND CHANGE INSPECTION:\n\n' +
    '- `files` + no `a`/`b` → show file content with line numbers (NOT a unified diff; no +/- prefixes). Result `mode` is "dump".\n' +
    '- `a` and/or `b` → git-style commit/branch diff (unified format, real +/- prefixes).\n' +
    '- `staged: true` → only show staged changes.\n' +
    '- `mode` only affects the git-diff path: "stat" runs `git diff --stat`; "side-by-side" is unimplemented and falls back to unified (result `mode` reports what was produced).\n' +
    '- `context` sets the unified-diff context line count on the git path (`-U<n>`); the dump path has no context notion.\n' +
    '\n' +
    'NOTE: For a true file-vs-file unified diff, supply `a` and `b` so the tool ' +
    'delegates to `git diff`. The `files`-only path is a line-numbered dump, not a diff.\n' +
    '\n' +
    'This tool has important safety guards against flag injection (see previous security findings).',
  permission: 'auto',
  mutating: false,
  maxOutputBytes: 262_144,
  capabilities: ['fs.read'],
  icon: 'diff',
  timeoutMs: 10_000,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Working directory for the diff operation (defaults to project root).',
      },
      files: {
        type: 'string',
        description: 'Files or globs to diff (e.g. "src/**/*.ts" or comma-separated list).',
      },
      a: {
        type: 'string',
        description: 'First ref/commit/branch for git diff (e.g. HEAD, main, a commit hash).',
      },
      b: {
        type: 'string',
        description: 'Second ref/commit/branch for git diff.',
      },
      staged: {
        type: 'boolean',
        description: 'If true, only show changes that are staged in git.',
      },
      mode: {
        type: 'string',
        enum: ['unified', 'side-by-side', 'stat'],
        description:
          'Output format for the git-diff path. "unified" is default; "stat" shows a summary only; ' +
          '"side-by-side" is not supported and falls back to unified. The `files`-only dump path ignores this.',
      },
      context: {
        type: 'integer',
        minimum: 0,
        description:
          'Number of context lines for git unified diffs (default: 3, passed as -U<n>). Ignored by the `files`-only dump path.',
      },
    },
  },
  async execute(input, ctx, opts) {
    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    if (input.path !== undefined) {
      if (typeof input.path !== 'string' || !input.path.trim()) {
        throw new ToolValidationError({
          message: "diff: 'path' must be a non-empty string when provided",
          field: 'path',
        });
      }
      try {
        await safeResolveReal(input.path, ctx);
      } catch (err) {
        throw new ToolValidationError({
          message: `diff: ${(err as Error).message}`,
          field: 'path',
        });
      }
    }
    if (
      input.context !== undefined &&
      (typeof input.context !== 'number' ||
        !Number.isInteger(input.context) ||
        input.context < 0 ||
        input.context > 100)
    ) {
      throw new ToolValidationError({
        message: 'diff: context must be an integer between 0 and 100',
        field: 'context',
      });
    }
    if (input.staged || input.a !== undefined || input.b !== undefined) {
      return await gitDiff(input, ctx, signal);
    }

    return await fileDiff(input, ctx, signal);
  },
};

async function gitDiff(
  input: DiffInput,
  ctx: import('@wrongstack/core/agent').Context,
  signal: AbortSignal,
): Promise<DiffOutput> {
  if (input.a !== undefined && (typeof input.a !== 'string' || !input.a.trim())) {
    throw new ToolValidationError({
      message: "diff: ref 'a' cannot be empty or whitespace-only",
      field: 'a',
    });
  }
  if (input.b !== undefined && (typeof input.b !== 'string' || !input.b.trim())) {
    throw new ToolValidationError({
      message: "diff: ref 'b' cannot be empty or whitespace-only",
      field: 'b',
    });
  }
  // Flag injection: a/b are passed as positional args BEFORE the `--`
  // separator, so a leading '-' would be parsed as a git option. The most
  // dangerous is `--output=<path>`, which makes `git diff` write to an
  // arbitrary path (outside the project root, with no confirmation since this
  // tool is permission:'auto'). Reject leading-dash refs unconditionally —
  // mirrors the guard in git.ts (validateWorktreeInput) and install.ts.
  if (typeof input.a === 'string' && input.a.trim().startsWith('-')) {
    throw new ToolValidationError({
      message: `diff: unsafe ref "${input.a}" — refs may not begin with '-' (flag injection)`,
      field: 'a',
    });
  }
  if (typeof input.b === 'string' && input.b.trim().startsWith('-')) {
    throw new ToolValidationError({
      message: `diff: unsafe ref "${input.b}" — refs may not begin with '-' (flag injection)`,
      field: 'b',
    });
  }
  // Path-shaped refs: `git diff <x> <y>` silently switches to `--no-index` when
  // either positional names a path OUTSIDE the work tree, and then diffs two
  // filesystem files — an out-of-root read from a permission:'auto' tool that
  // the sensitive-read gate never inspects (it keys on `path`-like fields).
  // Today exit status 1 happens to discard the content, which is not a control
  // anyone would preserve on purpose. A trailing `--` does not close it either:
  // with ONE ref git's prescan still sees `<ref> --` as the two paths. No real
  // revision is absolute, drive-prefixed, or has a `..` path SEGMENT (git
  // forbids those in ref names; `main..feature` ranges have no separator around
  // the dots), so refusing that shape removes nothing legitimate.
  for (const field of ['a', 'b'] as const) {
    const ref = input[field];
    if (typeof ref === 'string' && refLooksLikeOutsidePath(ref.trim())) {
      throw new ToolValidationError({
        message: `diff: unsafe ref "${ref}" — refs may not be filesystem paths (implicit --no-index)`,
        field,
      });
    }
  }

  // 'side-by-side' has no git equivalent we can safely render; fall back to
  // unified and say so — result.mode must reflect what was actually produced.
  const requestedMode = input.mode ?? 'unified';
  const statMode = requestedMode === 'stat';
  const effectiveMode = statMode ? 'stat' : 'unified';
  const sideBySideNote =
    requestedMode === 'side-by-side'
      ? 'side-by-side output is not supported; a unified diff was produced instead.'
      : undefined;

  let basePath: string;
  try {
    basePath = input.path ? await safeResolveReal(input.path, ctx) : ctx.cwd;
  } catch (err) {
    throw new ToolValidationError({
      message: `diff: ${(err as Error).message}`,
      field: 'path',
    });
  }
  // A diff that could not be produced must throw: a returned value (even with
  // a `note`) is recorded by the executor as a successful call.
  const gitDir = findGitDir(basePath, ctx.projectRoot);
  if (!gitDir) {
    throw new Error(`diff: not a git repository (or any parent up to project root): ${basePath}`);
  }

  // A diff driver or textconv the repository assigns runs on patch output.
  const args: string[] = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];
  if (statMode) args.push('--stat');
  if (!statMode && input.context !== undefined) {
    // Sanitized to a non-negative integer: `context` reaches the git argv.
    const contextLines = Math.max(0, Math.floor(input.context));
    if (Number.isFinite(contextLines)) args.push(`-U${contextLines}`);
  }
  if (input.staged) args.push('--staged');
  if (input.a) args.push(input.a.trim());
  if (input.b) args.push(input.b.trim());
  // Always terminate revisions: with both refs present git then parses them as
  // revisions only, never as the two paths of an implicit `--no-index` diff.
  // (Single-ref path shapes are refused above — `--` alone does not cover them.)
  args.push('--');
  let effectiveFiles: string[] = [];
  if (input.files) {
    const rawFiles = Array.isArray(input.files)
      ? input.files
      : typeof input.files === 'string'
        ? input.files.split(',')
        : [];
    const files = [
      ...new Set(
        rawFiles
          .filter((f): f is string => typeof f === 'string')
          .map((f) => f.trim().replace(/\\/g, '/'))
          .filter(Boolean),
      ),
    ];
    if (files.length > 0) {
      effectiveFiles = files;
      args.push('--', ...files);
    }
  }

  const result = await runGit(args, gitDir, signal);
  // `git diff` (without --exit-code) exits 0 whether or not there are
  // differences, so any non-zero exit is a real failure (bad ref, bad path…).
  if (result.exitCode !== 0) {
    throw new Error(
      `diff: git diff exited with code ${result.exitCode}: ${result.stderr.trim() || 'command failed'}`,
    );
  }
  // The whole diff. A large result reaches the model through the tool
  // executor's lossless spool (file + preview); a fixed clip here dropped the
  // tail of the change with no way to get it back.
  return {
    diff: result.stdout,
    files: effectiveFiles,
    truncated: false,
    mode: effectiveMode,
    note: sideBySideNote,
  };
}

/**
 * True when a diff "ref" is shaped like a filesystem path that git would read
 * with implicit `--no-index`: absolute (`/etc/x`, `C:\x`, `\\server\x`),
 * drive-prefixed (`C:x`), or carrying a `..` path SEGMENT (`../x`, `a/../../x`).
 * Revision ranges (`main..feature`, `..feature`, `main...`) have no separator
 * around the dots and are unaffected.
 */
export function refLooksLikeOutsidePath(ref: string): boolean {
  return (
    path.isAbsolute(ref) ||
    path.win32.isAbsolute(ref) ||
    /^[A-Za-z]:/.test(ref) ||
    /(^|[\\/])\.\.([\\/]|$)/.test(ref)
  );
}

function findGitDir(cwd: string, projectRoot: string): string | null {
  // Bounded at projectRoot like git.ts: a non-git project must not walk up into
  // an unrelated parent repository and diff that instead.
  const root = path.resolve(projectRoot);
  let dir = cwd;
  for (let i = 0; i < 20; i++) {
    try {
      const stat = statSync(path.join(dir, '.git'));
      // A normal repo has a `.git` directory; a linked worktree has a `.git`
      // file (gitlink pointing at the main repo). Accept both.
      if (stat.isDirectory() || stat.isFile()) return dir;
    } catch {
      // continue
    }
    if (path.resolve(dir) === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function runGit(
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (signal.aborted) {
    return { stdout: '', stderr: 'Aborted', exitCode: 124 };
  }
  // The repository's config names programs `diff` runs (fsmonitor,
  // `.gitattributes` filters); when they cannot be switched off, git does not run.
  const isolation = await gitIsolationEnv(cwd, { baseEnv: buildChildEnv() });
  if (!isolation) {
    return {
      stdout: '',
      stderr: 'git isolation unavailable: the repository config could not be read',
      exitCode: 1,
    };
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    // Per-stream decoders: `chunk.toString()` corrupts multi-byte sequences
    // that straddle a pipe chunk boundary (each half decodes to U+FFFD).
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const child = spawn('git', args, {
      cwd,
      signal,
      env: { ...buildChildEnv(), ...isolation },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout?.on('data', (c) => {
      stdout += stdoutDecoder.write(c);
    });
    child.stderr?.on('data', (c) => {
      stderr += stderrDecoder.write(c);
    });
    child.on('close', (code) => {
      // Flush any partial trailing sequence before the payload is consumed.
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
    /* v8 ignore next -- spawn 'error' only fires when the git binary is missing; defensive. */
    child.on('error', (e) => resolve({ stdout: '', stderr: e.message, exitCode: 1 }));
  });
}

async function fileDiff(
  input: DiffInput,
  ctx: import('@wrongstack/core/agent').Context,
  signal: AbortSignal,
): Promise<DiffOutput> {
  signal.throwIfAborted();
  // `context` is accepted on the input schema but only affects the git-diff
  // path (`a`/`b`), where it becomes `-U<n>`. This line-dump path has no
  // notion of "context lines" because there is no real diff.
  void input.context;

  const rawFiles = Array.isArray(input.files)
    ? input.files
    : typeof input.files === 'string'
      ? input.files.split(',')
      : [];
  const files = [
    ...new Set(
      rawFiles
        .filter((f): f is string => typeof f === 'string')
        .map((f) => f.trim())
        .filter(Boolean),
    ),
  ];

  if (files.length === 0) {
    throw new ToolValidationError({
      message: 'diff: no files specified — pass `files`, or `a`/`b`/`staged` for a git diff',
      field: 'files',
    });
  }

  let basePath: string;
  try {
    basePath = input.path ? await safeResolveReal(input.path, ctx) : ctx.cwd;
  } catch (err) {
    throw new ToolValidationError({
      message: `diff: ${(err as Error).message}`,
      field: 'path',
    });
  }

  const fileEntries = await mapWithConcurrency(files, 16, async (file) => {
    signal.throwIfAborted();
    // Realpath containment (WS-048): the dump path OPENS the resolved file, so
    // the syntactic check alone would follow an in-root symlink out of root.
    const fileToResolve = path.isAbsolute(file) ? file : path.resolve(basePath, file);
    let absPath: string;
    try {
      absPath = await safeResolveReal(fileToResolve, ctx);
    } catch (err) {
      // A refused path is an error, not a silently-skipped file.
      throw new ToolValidationError({
        message: `diff: file "${file}": ${(err as Error).message}`,
        field: 'files',
        cause: err,
      });
    }
    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat?.isFile()) return { missing: file };

    if (stat.size > MAX_FILE_DUMP_BYTES) {
      return {
        truncated: true,
        output: `--- ${file} (skipped: ${stat.size} bytes exceeds the ${MAX_FILE_DUMP_BYTES} limit; use the read tool with offset/limit) ---`,
      };
    }

    const content = await fs.readFile(absPath, 'utf8');
    const lines = content.split(/\r?\n/);
    return {
      truncated: false,
      output: formatWithLineNumbers(file, lines),
    };
  });

  const results: string[] = [];
  const missing: string[] = [];
  let truncated = false;
  for (const entry of fileEntries) {
    if ('missing' in entry) {
      missing.push(entry.missing);
      continue;
    }
    if (entry.truncated) truncated = true;
    results.push(entry.output);
  }

  // Nothing could be shown: an empty "successful" dump would read as "these
  // files are empty". Globs are only expanded on the git path (`a`/`b`).
  if (results.length === 0) {
    throw new Error(
      `diff: none of the requested files exist or are regular files: ${missing.join(', ')}`,
    );
  }

  const notes = [
    input.mode !== undefined
      ? 'The `files`-only path is a line-numbered dump; `mode` only affects the git-diff path (`a`/`b`).'
      : undefined,
    missing.length > 0
      ? `Skipped (not found or not a regular file): ${missing.join(', ')}`
      : undefined,
  ].filter(Boolean);

  return {
    diff: results.join('\n\n'),
    files,
    truncated,
    // Honest mode: this path always produces a line-numbered dump — it never
    // honors `mode`, so it must not echo the requested value back.
    mode: 'dump',
    note: notes.length > 0 ? notes.join('\n') : undefined,
  };
}

/**
 * Render a file's content as a line-numbered dump. This is intentionally
 * NOT a unified diff — it has no `-`/`+` prefixes. For a real diff
 * between two revisions, use the `a`/`b` params (delegates to `git diff`).
 *
 * Format: `   N | content` with the line number right-aligned. The
 * `context` parameter is accepted for API compatibility but unused —
 * a line dump has no notion of "context lines".
 */
function formatWithLineNumbers(file: string, lines: string[]): string {
  const count = lines.length;
  const width = String(count).length;
  const parts: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const numStr = String(i + 1).padStart(width, ' ');
    parts[i] = `${numStr} | ${lines[i]}`;
  }
  return `--- ${file} (line-numbered dump, not a unified diff) ---\n${parts.join('\n')}`;
}
