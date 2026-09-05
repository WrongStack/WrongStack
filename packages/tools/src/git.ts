import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { assessCommitSafety } from '@wrongstack/core/coordination';
import type { Tool } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
import { buildChildEnv } from '@wrongstack/core/utils';
import { COMMAND_OUTPUT_MAX_BYTES, normalizeCommandOutput } from './_util.js';

type GitSubcommand =
  | 'status'
  | 'log'
  | 'diff'
  | 'commit'
  | 'branch'
  | 'checkout'
  | 'stash'
  | 'push'
  | 'pull'
  | 'fetch'
  | 'reset'
  | 'worktree';

interface GitInput {
  command: GitSubcommand;
  files?: string | string[] | undefined;
  dry_run?: boolean | undefined;
  /** commit message for `commit` subcommand */
  message?: string | undefined;
  /** branch name for `checkout` / `branch` */
  branch?: string | undefined;
  /** pass --graph, --oneline, --stat for `log` */
  format?: 'short' | 'oneline' | 'stat' | 'graph' | undefined;
  /** limit for `log` */
  limit?: number | undefined;
  /** worktree action: list, add, remove, prune */
  worktreeAction?: 'list' | 'add' | 'remove' | 'prune' | undefined;
  /** path for worktree add/remove (e.g. "../wt-feature-xyz") */
  worktreePath?: string | undefined;
  /** create new branch when adding worktree */
  newBranch?: boolean | undefined;
  /** force operation (e.g. worktree remove --force) */
  force?: boolean | undefined;
}

interface GitOutput {
  command: GitSubcommand;
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  /** Staged diff shown for commit commands so the caller can verify. */
  diff?: string | undefined;
  /**
   * Shared-worktree warning for `commit`: present when uncommitted changes
   * were authored by another agent/session (or a concurrent non-wrongstack
   * process). The commit still proceeds — this is advisory so the caller can
   * reconsider committing work it did not write.
   */
  warning?: string | undefined;
}

type GitContext = Parameters<Tool<GitInput, GitOutput>['execute']>[1];

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 100_000;

export const gitTool = {
  name: 'git',
  category: 'Git',
  description:
    'Safe wrapper around common git operations. Supports status, log, diff, commit, branch, checkout, stash, push, pull, fetch, reset, worktree, etc. ' +
    'This is the preferred way to interact with git instead of using the raw `bash` or `exec` tools.',
  usageHint:
    'ALWAYS prefer this tool over raw shell git commands.\n\n' +
    'Key fields:\n' +
    '- `command`: one of the supported subcommands (status, log, diff, commit, etc.)\n' +
    '- Use `message` only for commit operations.\n' +
    '- Use `files` array for operations that take paths (status, diff, add, etc.).\n' +
    '- Non-mutating commands (status, log, diff, branch, fetch) are still permission:confirm for safety.\n' +
    '- For `commit` in a possibly-shared working tree, pass an explicit `files` list scoped to ' +
    'what YOU changed. A bare commit (no `files`) includes ALL staged changes and may capture ' +
    "another agent's half-done work. Heed the `warning` field on the result.\n" +
    'Never pass raw git flags through `args` for dangerous operations — use the structured fields.',
  permission: 'confirm',
  icon: 'git',
  // Conservative: any of these may mutate. The non-mutating commands
  // (status/log/diff/branch/fetch) are still gated on `permission: 'confirm'`
  // and `MUTATING_SUBCOMMANDS` is consulted at runtime for per-call checks.
  // WS-046: gives permission decisions something to key on.
  // The git subcommand (status/commit/push) is what a trust rule needs to
  // distinguish; `git status` and `git push --force` must not share a subject.
  subjectKey: 'command',
  // `command` is an enum subcommand, so on its own it rendered the subject
  // `"push"` — and one "always allow" then covered every push, to any branch,
  // with or without `--force`. These are the fields that change what the call
  // actually does, so the stored trust rule is as specific as the invocation
  // the user approved.
  subjectFields: ['branch', 'force', 'worktreeAction', 'worktreePath', 'newBranch'],
  mutating: true,
  capabilities: ['fs.write', 'shell.restricted'],
  timeoutMs: TIMEOUT_MS,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        enum: [
          'status',
          'log',
          'diff',
          'commit',
          'branch',
          'checkout',
          'stash',
          'push',
          'pull',
          'fetch',
          'reset',
          'worktree',
        ],
        description: 'Git subcommand',
      },
      files: {
        type: 'string',
        description:
          'File(s) for status/diff: single path, comma-separated list, or "**/*.ts" glob',
      },
      message: { type: 'string', description: 'Commit message (required for commit)' },
      branch: { type: 'string', description: 'Branch name for checkout/branch' },
      format: {
        type: 'string',
        enum: ['short', 'oneline', 'stat', 'graph'],
        description: 'Log format (default: short)',
      },
      limit: { type: 'integer', description: 'Limit for log (default: 20)' },
      dry_run: { type: 'boolean', description: 'For commit: show what would be committed' },
      worktreeAction: {
        type: 'string',
        enum: ['list', 'add', 'remove', 'prune'],
        description: 'Worktree action: list, add, remove, prune',
      },
      worktreePath: {
        type: 'string',
        description: 'Path for worktree add/remove (e.g. "../wt-feature-xyz")',
      },
      newBranch: {
        type: 'boolean',
        description: 'Create new branch when adding worktree',
      },
      force: {
        type: 'boolean',
        description: 'Force operation (e.g. worktree remove --force)',
      },
    },
    required: ['command'],
  },
  async execute(input: GitInput, ctx: GitContext, opts?: { signal: AbortSignal }) {
    if (!input?.command || typeof input.command !== 'string' || !input.command.trim()) {
      throw new ToolValidationError({
        message: 'git: command is required and cannot be empty',
        field: 'command',
      });
    }

    if (input.command.startsWith('-') || input.command.includes(' --')) {
      throw new ToolValidationError({
        message: `git: unsafe subcommand name "${input.command}"`,
        field: 'command',
      });
    }

    if (input.command === 'commit' && !input.message) {
      return {
        command: 'commit',
        stdout: '',
        stderr: 'git commit requires a message (-m flag)',
        exitCode: 1,
        truncated: false,
      };
    }

    // A flag-shaped `branch` is rejected for EVERY command, not just worktree.
    // The leading-dash check used to live inside validateWorktreeInput, so
    // `fetch` — which passes input.branch as a bare positional — accepted
    // `--upload-pack=<prog>` and handed git a program to execute. `exec.ts`
    // already denylists exactly those flags for the `git` binary; the git tool
    // did not reuse it. Checked centrally so the next command that forwards a
    // branch cannot reintroduce the gap (WS-090).
    const branchGuard = validateBranchInput(input);
    if (branchGuard) return branchGuard;

    // Validate worktree paths before touching the filesystem: reject any path
    // that escapes the project root.
    if (input.command === 'worktree') {
      const guard = validateWorktreeInput(input, ctx.projectRoot);
      if (guard) return guard;
    }

    // Bound the search at projectRoot so a non-git project doesn't drift
    // into a parent repo (e.g. ~/repos/.git) and operate on the wrong tree.
    const gitDir = findGitDir(ctx.cwd, ctx.projectRoot);
    if (!gitDir) {
      return {
        command: input.command,
        stdout: '',
        stderr: 'Not in a git repository (within project root)',
        exitCode: 128,
        truncated: false,
      };
    }

    const args = buildArgs(input);
    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;

    // For commits, check whether the working tree holds changes this session
    // did not author (a concurrent agent / separate wrongstack process / human).
    // Warn-only: the commit still runs, but the caller sees the risk of sweeping
    // up another agent's half-done work. Best-effort — never blocks the commit.
    let safetyWarning: string | undefined;
    if (input.command === 'commit') {
      try {
        const report = await assessCommitSafety({
          cwd: ctx.cwd,
          projectRoot: ctx.projectRoot,
          sessionId: ctx.session?.id,
          signal,
        });
        if (report.warning) {
          // Committing without an explicit file list stages/commits everything
          // already staged — the highest-risk path for capturing foreign work.
          const scopeNote = input.files
            ? ''
            : '\nNote: this commit has no explicit `files` list, so it will include ALL ' +
              'staged changes. Pass `files` to scope the commit to only what you changed.';
          safetyWarning = report.warning + scopeNote;
        }
      } catch {
        // commit-safety is advisory; ignore failures
      }
    }

    // For commits, capture the staged diff BEFORE committing so the caller
    // can verify what is about to land without another tool call.
    let stagedDiff: string | undefined;
    if (input.command === 'commit' && !input.dry_run) {
      try {
        const diffResult = await runGit(['diff', '--cached'], gitDir, signal);
        if (diffResult.exitCode === 0) {
          const MAX_DIFF = 20_000;
          stagedDiff =
            diffResult.stdout.length > MAX_DIFF
              ? diffResult.stdout.slice(0, MAX_DIFF) + '\n\n... (diff truncated)'
              : diffResult.stdout;
        }
      } catch {
        // Diff capture is best-effort; don't fail the whole operation
      }
    }

    const result = await runGit(args, gitDir, signal);
    if (stagedDiff !== undefined) result.diff = stagedDiff;
    if (safetyWarning !== undefined) result.warning = safetyWarning;
    return result;
  },
} satisfies Tool<GitInput, GitOutput>;

/**
 * Reject worktree inputs that could inject git flags or escape the project
 * root. Returns a `GitOutput` describing the rejection, or `null` if safe.
 */
/**
 * Reject a `branch` that git would parse as an option, for every command.
 *
 * `git fetch --upload-pack=<prog>` (and `--exec=`, `--receive-pack=`) makes git
 * run an arbitrary program, so a branch name is a code-execution sink wherever
 * it reaches git as a bare positional. `' --'` is caught too: a value like
 * `main --upload-pack=x` splits into extra argv entries in any path that later
 * word-splits the branch.
 */
function validateBranchInput(input: GitInput): GitOutput | null {
  const branch = input.branch;
  if (branch === undefined) return null;
  if (!branch.startsWith('-') && !branch.includes(' --')) return null;
  return {
    command: input.command,
    stdout: '',
    stderr: `unsafe branch name (parsed as a git option): ${branch}`,
    exitCode: 1,
    truncated: false,
  };
}

function validateWorktreeInput(input: GitInput, projectRoot: string): GitOutput | null {
  const reject = (stderr: string): GitOutput => ({
    command: 'worktree',
    stdout: '',
    stderr,
    exitCode: 1,
    truncated: false,
  });

  // Flag injection on the path. Branch names are handled centrally by
  // validateBranchInput before this runs (WS-090).
  if (input.worktreePath?.startsWith('-')) {
    return reject(`unsafe worktree path: ${input.worktreePath}`);
  }

  // Path escape: add/remove targets must resolve inside the project root.
  if ((input.worktreeAction === 'add' || input.worktreeAction === 'remove') && input.worktreePath) {
    const root = resolve(projectRoot);
    const abs = resolve(root, input.worktreePath);
    if (abs !== root && !abs.startsWith(root + sep)) {
      return reject(`unsafe worktree path (escapes project root): ${input.worktreePath}`);
    }
  }

  return null;
}

function findGitDir(cwd: string, projectRoot: string): string | null {
  const root = projectRoot;
  let dir = cwd;
  for (let i = 0; i < 20; i++) {
    try {
      const stat = statSync(resolve(dir, '.git'));
      // A normal repo has a `.git` directory; a linked worktree has a `.git`
      // *file* (gitlink pointing at the main repo). Accept both so the tool
      // operates inside a worktree when a subagent's cwd is a worktree dir.
      if (stat.isDirectory() || stat.isFile()) return dir;
    } catch {
      // continue
    }
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function buildArgs(input: GitInput): string[] {
  const rawLimit =
    typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
      ? Math.floor(input.limit)
      : 20;
  const limit = Math.max(1, rawLimit);
  const rawFiles = input.files
    ? (Array.isArray(input.files) ? input.files : input.files.split(','))
        .filter((s): s is string => typeof s === 'string')
        .map((s: string) => s.trim().replace(/\\/g, '/'))
        .filter(Boolean)
    : [];
  const files = [...new Set(rawFiles)];

  switch (input.command) {
    case 'status':
      return ['status', ...(files.length ? ['--', ...files] : [])];
    case 'log':
      return [
        'log',
        `--max-count=${limit}`,
        ...(input.format === 'oneline' ? ['--oneline'] : []),
        ...(input.format === 'stat' ? ['--stat'] : []),
        ...(input.format === 'graph' ? ['--oneline', '--graph', '--decorate'] : []),
        ...(input.format === 'short' || !input.format ? [] : []),
      ];
    case 'diff':
      return ['diff', '--no-color', ...(files.length ? ['--', ...files] : [])];
    case 'commit':
      return [
        'commit',
        ...(input.dry_run ? ['--dry-run', '--porcelain'] : []),
        ...(input.message ? ['-m', input.message] : []),
        ...(files.length ? ['--', ...files] : []),
      ];
    case 'branch':
      // Validate branch name: reject names starting with '-' or containing ' --'
      // to prevent flag injection (e.g. "foo --force").
      return input.branch
        ? [
            'branch',
            ...(input.branch.startsWith('-') || input.branch.includes(' --') ? [] : [input.branch]),
          ]
        : ['branch'];
    case 'checkout':
      // Everything AFTER `--` is a pathspec, so `['checkout', '--', branch]`
      // never switched a branch — it restored that path from the index.
      // `git checkout -- packages` exits 0 while silently discarding every
      // uncommitted change under `packages/`, and the tool reported success.
      //
      // A trailing `--` with nothing after it is the other half of the fix: it
      // declares "no pathspecs follow", which disables git's DWIM fallback.
      // Verified against git 2.x — `git checkout docs` with a `docs/` directory
      // and no `docs` branch prints "Updated 1 path from the index" and
      // discards the working-tree change, while `git checkout docs --` exits
      // 128 with `fatal: invalid reference: docs` and touches nothing.
      //
      // The two modes are mutually exclusive: passing both used to emit TWO
      // `--` separators, which git rejects outright. When both are supplied
      // the file restore wins — it is the narrower, explicitly-addressed
      // operation.
      if (files.length) return ['checkout', '--', ...files];
      return input.branch ? ['checkout', input.branch, '--'] : ['checkout'];
    case 'stash':
      return input.message ? ['stash', 'push', '-m', input.message] : ['stash', 'push'];
    case 'push':
      return [
        'push',
        ...(input.dry_run ? ['--dry-run'] : []),
        ...(input.force ? ['--force'] : []),
        ...(input.branch ? ['origin', input.branch] : []),
      ];
    case 'pull':
      return ['pull', ...(input.branch ? ['origin', input.branch] : [])];
    case 'fetch':
      return ['fetch', ...(input.branch ? [input.branch] : ['--all'])];
    case 'reset':
      return ['reset', ...(files.length ? ['--', ...files] : [])];
    case 'worktree':
      switch (input.worktreeAction) {
        case 'list':
          return ['worktree', 'list'];
        case 'add': {
          // git worktree add [-b <new-branch>] <path> [<commit-ish>]
          // The path comes BEFORE the branch/commit-ish. With --newBranch the
          // branch is the name to create (`-b <branch> <path>`); without it the
          // branch is an existing branch/commit to check out (`<path> <branch>`).
          if (!input.worktreePath) return ['worktree', 'list'];
          const add = ['worktree', 'add'];
          if (input.newBranch && input.branch) add.push('-b', input.branch);
          add.push(input.worktreePath);
          if (!input.newBranch && input.branch) add.push(input.branch);
          return add;
        }
        case 'remove':
          return [
            'worktree',
            'remove',
            ...(input.force ? ['--force'] : []),
            input.worktreePath ?? '',
          ].filter(Boolean);
        case 'prune':
          return ['worktree', 'prune'];
        default:
          return ['worktree', 'list'];
      }
    default:
      return [input.command];
  }
}

function runGit(args: string[], cwd: string, signal: AbortSignal): Promise<GitOutput> {
  if (signal.aborted) {
    return Promise.resolve({
      command: args[0] as GitSubcommand,
      stdout: '',
      stderr: 'Aborted',
      exitCode: 124,
      truncated: false,
    });
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const child = spawn('git', args, {
      cwd,
      signal,
      env: buildChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdout.length < MAX_OUTPUT) {
        const text = stdoutDecoder.write(chunk);
        if (text) stdout += text.slice(0, MAX_OUTPUT - stdout.length);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderr.length < MAX_OUTPUT) {
        const text = stderrDecoder.write(chunk);
        if (text) stderr += text.slice(0, MAX_OUTPUT - stderr.length);
      }
    });

    child.on('error', (err) => {
      const stdoutTail = stdoutDecoder.end();
      if (stdoutTail && stdout.length < MAX_OUTPUT) {
        stdout += stdoutTail.slice(0, MAX_OUTPUT - stdout.length);
      }
      const stderrTail = stderrDecoder.end();
      if (stderrTail && stderr.length < MAX_OUTPUT) {
        stderr += stderrTail.slice(0, MAX_OUTPUT - stderr.length);
      }
      resolve({
        command: args[0] as GitSubcommand,
        stdout: normalizeCommandOutput(stdout),
        stderr: err.message,
        exitCode: 1,
        truncated:
          stdoutBytes > MAX_OUTPUT || Buffer.byteLength(stdout, 'utf8') > COMMAND_OUTPUT_MAX_BYTES,
      });
    });

    child.on('close', (code) => {
      const stdoutTail = stdoutDecoder.end();
      if (stdoutTail && stdout.length < MAX_OUTPUT) {
        stdout += stdoutTail.slice(0, MAX_OUTPUT - stdout.length);
      }
      const stderrTail = stderrDecoder.end();
      if (stderrTail && stderr.length < MAX_OUTPUT) {
        stderr += stderrTail.slice(0, MAX_OUTPUT - stderr.length);
      }
      // `MAX_OUTPUT` already bounded the raw buffers in memory; normalize strips
      // ANSI / progress / duplicate noise and head+tail-truncates to the shared
      // command cap so only useful output reaches the model.
      const isTruncated =
        stdoutBytes > MAX_OUTPUT ||
        stderrBytes > MAX_OUTPUT ||
        Buffer.byteLength(stdout, 'utf8') > COMMAND_OUTPUT_MAX_BYTES ||
        Buffer.byteLength(stderr, 'utf8') > COMMAND_OUTPUT_MAX_BYTES;
      resolve({
        command: args[0] as GitSubcommand,
        stdout: normalizeCommandOutput(stdout),
        stderr: normalizeCommandOutput(stderr),
        exitCode: code ?? 1,
        truncated: isTruncated,
      });
    });
  });
}
