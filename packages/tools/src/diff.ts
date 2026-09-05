import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildChildEnv } from '@wrongstack/core/utils';
import type { Tool } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
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

/** Character cap for the git-diff stdout returned to the model. */
const MAX_GIT_DIFF_CHARS = 100_000;

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
    if (input.a !== undefined || input.b !== undefined) {
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

  // 'side-by-side' has no git equivalent we can safely render; fall back to
  // unified and say so — result.mode must reflect what was actually produced.
  const requestedMode = input.mode ?? 'unified';
  const statMode = requestedMode === 'stat';
  const effectiveMode = statMode ? 'stat' : 'unified';
  const sideBySideNote =
    requestedMode === 'side-by-side'
      ? 'side-by-side output is not supported; a unified diff was produced instead.'
      : undefined;

  const basePath = input.path ? await safeResolveReal(input.path, ctx) : ctx.cwd;
  const gitDir = findGitDir(basePath);
  if (!gitDir) {
    return {
      diff: '',
      files: [],
      truncated: false,
      mode: effectiveMode,
      note: 'Not a git repository (or any parent up to root).',
    };
  }

  const args: string[] = ['diff', '--no-color'];
  if (statMode) args.push('--stat');
  if (!statMode && input.context !== undefined) {
    // Sanitized to a non-negative integer: `context` reaches the git argv.
    const contextLines = Math.max(0, Math.floor(input.context));
    if (Number.isFinite(contextLines)) args.push(`-U${contextLines}`);
  }
  if (input.staged) args.push('--staged');
  if (input.a) args.push(input.a.trim());
  if (input.b) args.push(input.b.trim());
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
  // Honest truncation: actually clip the payload (at a line boundary) when it
  // exceeds the cap, and only then report truncated=true.
  let diff = result.stdout;
  let truncated = false;
  if (diff.length > MAX_GIT_DIFF_CHARS) {
    let clipped = diff.slice(0, MAX_GIT_DIFF_CHARS);
    const nl = clipped.lastIndexOf('\n');
    if (nl > 0) clipped = clipped.slice(0, nl);
    diff = `${clipped}\n…[git diff truncated: ${result.stdout.length - clipped.length} of ${result.stdout.length} characters omitted]`;
    truncated = true;
  }
  const exitNote =
    result.exitCode !== 0
      ? `git diff exited with code ${result.exitCode}: ${result.stderr.trim() || 'command failed'}`
      : undefined;
  const combinedNote = [sideBySideNote, exitNote].filter(Boolean).join('\n') || undefined;
  return {
    diff,
    files: effectiveFiles,
    truncated,
    mode: effectiveMode,
    note: combinedNote,
  };
}

function findGitDir(cwd: string): string | null {
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
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function runGit(
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (signal.aborted) {
    return Promise.resolve({ stdout: '', stderr: 'Aborted', exitCode: 124 });
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const child = spawn('git', args, {
      cwd,
      signal,
      env: buildChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout?.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr?.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
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
    return {
      diff: 'No files specified',
      files: [],
      truncated: false,
      mode: 'dump',
    };
  }

  const basePath = input.path ? await safeResolveReal(input.path, ctx) : ctx.cwd;

  const fileEntries = await mapWithConcurrency(files, 16, async (file) => {
    signal.throwIfAborted();
    // Realpath containment (WS-048): the dump path OPENS the resolved file, so
    // the syntactic check alone would follow an in-root symlink out of root.
    const fileToResolve = path.isAbsolute(file) ? file : path.resolve(basePath, file);
    const absPath = await safeResolveReal(fileToResolve, ctx);
    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat?.isFile()) return null;

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
  let truncated = false;
  for (const entry of fileEntries) {
    if (!entry) continue;
    if (entry.truncated) truncated = true;
    results.push(entry.output);
  }

  return {
    diff: results.join('\n\n'),
    files,
    truncated,
    // Honest mode: this path always produces a line-numbered dump — it never
    // honors `mode`, so it must not echo the requested value back.
    mode: 'dump',
    note:
      input.mode !== undefined
        ? 'The `files`-only path is a line-numbered dump; `mode` only affects the git-diff path (`a`/`b`).'
        : undefined,
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
