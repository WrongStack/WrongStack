import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildChildEnv } from '@wrongstack/core/utils';
import type { Tool } from '@wrongstack/core/types';
import { safeResolve } from './_util.js';

/**
 * Per-file cap for the line-numbered dump path. The dump reads the whole file
 * into memory, splits it into an array of lines, and returns everything to the
 * model context — unbounded, that is both an OOM vector and a context bomb.
 * Mirrors the read tool's 5 MiB guard; files over the cap are skipped with an
 * explanatory note and `truncated: true`.
 */
const MAX_FILE_DUMP_BYTES = 5 * 1024 * 1024;

interface DiffInput {
  path?: string | undefined;
  files?: string | string[] | undefined;
  a?: string | undefined;
  b?: string | undefined;
  staged?: boolean | undefined;
  mode?: 'unified' | 'side-by-side' | 'stat' | undefined;
  context?: number | undefined;
}

interface DiffOutput {
  diff: string;
  files: string[];
  truncated: boolean;
  mode: string;
}

export const diffTool: Tool<DiffInput, DiffOutput> = {
  name: 'diff',
  category: 'Filesystem',
  description:
    'Show file content with line numbers, staged/working-tree diffs via git, or commit/branch diffs. A safer and more structured alternative to raw `git diff` via shell.',
  usageHint:
    'USE FOR CODE REVIEW AND CHANGE INSPECTION:\n\n' +
    '- `files` + no `a`/`b` → show file content with line numbers (NOT a unified diff; no +/- prefixes).\n' +
    '- `a` and/or `b` → git-style commit/branch diff (unified format, real +/- prefixes).\n' +
    '- `staged: true` → only show staged changes.\n' +
    '- `mode` can be "unified", "stat", or "side-by-side" (only affects the git-diff path).\n' +
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
        description: 'Output format. "unified" is default, "stat" shows summary only.',
      },
      context: {
        type: 'integer',
        description: 'Number of context lines for unified diffs (default: 3).',
      },
    },
  },
  async execute(input, ctx, opts) {
    if (input.a !== undefined || input.b !== undefined) {
      return await gitDiff(input, ctx, opts.signal);
    }

    return await fileDiff(input, ctx, opts.signal);
  },
};

async function gitDiff(
  input: DiffInput,
  ctx: import('@wrongstack/core/agent').Context,
  signal: AbortSignal,
): Promise<DiffOutput> {
  // Flag injection: a/b are passed as positional args BEFORE the `--`
  // separator, so a leading '-' would be parsed as a git option. The most
  // dangerous is `--output=<path>`, which makes `git diff` write to an
  // arbitrary path (outside the project root, with no confirmation since this
  // tool is permission:'auto'). Reject leading-dash refs unconditionally —
  // mirrors the guard in git.ts (validateWorktreeInput) and install.ts.
  if (input.a?.startsWith('-')) {
    throw new Error(`diff: unsafe ref "${input.a}" — refs may not begin with '-' (flag injection)`);
  }
  if (input.b?.startsWith('-')) {
    throw new Error(`diff: unsafe ref "${input.b}" — refs may not begin with '-' (flag injection)`);
  }

  const gitDir = findGitDir(ctx.cwd);
  if (!gitDir) {
    return { diff: '', files: [], truncated: false, mode: 'unified' };
  }

  const args: string[] = ['diff', '--no-color'];
  if (input.staged) args.push('--staged');
  if (input.a) args.push(input.a);
  if (input.b) args.push(input.b);
  if (input.files) {
    const files = Array.isArray(input.files) ? input.files : input.files.split(',');
    args.push('--', ...files.map((f) => f.trim()));
  }

  const result = await runGit(args, gitDir, signal);
  return {
    diff: result.stdout,
    files: [],
    truncated: result.stdout.length > 100_000,
    mode: 'unified',
  };
}

function findGitDir(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 20; i++) {
    try {
      const stat = statSync(path.join(dir, '.git'));
      if (stat.isDirectory()) return dir;
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
  _signal: AbortSignal,
): Promise<DiffOutput> {
  // `context` is accepted on the input schema for API stability but is
  // unused in the line-dump path — there is no notion of "context lines"
  // when there is no real diff. The git-diff path (`a`/`b`) ignores it too.
  void input.context;

  const files = input.files
    ? (Array.isArray(input.files) ? input.files : input.files.split(','))
        .map((f) => f.trim())
        .filter(Boolean)
    : [];

  if (files.length === 0) {
    return {
      diff: 'No files specified',
      files: [],
      truncated: false,
      mode: input.mode ?? 'unified',
    };
  }

  const results: string[] = [];
  let truncated = false;

  for (const file of files) {
    const absPath = safeResolve(file, ctx);
    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat?.isFile()) continue;

    if (stat.size > MAX_FILE_DUMP_BYTES) {
      truncated = true;
      results.push(
        `--- ${file} (skipped: ${stat.size} bytes exceeds the ${MAX_FILE_DUMP_BYTES} limit; use the read tool with offset/limit) ---`,
      );
      continue;
    }

    const content = await fs.readFile(absPath, 'utf8');
    const lines = content.split(/\r?\n/);
    results.push(formatWithLineNumbers(file, lines));
  }

  return {
    diff: results.join('\n\n'),
    files,
    truncated,
    mode: input.mode ?? 'unified',
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
  const width = String(lines.length).length;
  const numbered = lines.map((line, i) => `${String(i + 1).padStart(width)} | ${line}`).join('\n');
  return `--- ${file} (line-numbered dump, not a unified diff) ---\n${numbered}`;
}
