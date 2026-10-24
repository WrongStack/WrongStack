import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Tool } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import { assessCommitSafety } from '@wrongstack/core/coordination';
import { buildChildEnv } from '@wrongstack/core/utils';
import { gitIsolationEnv } from '@wrongstack/primitives';
import { createOutputSpool, spoolNote } from './_output-spool.js';
import { commandOutputPreviewBytes, normalizeCommandOutput } from './_util.js';

export type GitSubcommand =
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

export interface GitInput {
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

export interface GitOutput {
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

    if (
      input.limit !== undefined &&
      (typeof input.limit !== 'number' || !Number.isFinite(input.limit) || input.limit <= 0)
    ) {
      throw new ToolValidationError({
        message: 'git: limit must be a positive integer',
        field: 'limit',
      });
    }

    // Refusals below THROW. A returned `{ exitCode: 1, stderr }` was recorded
    // by the executor as a successful call; the exit-code result shape is only
    // for git invocations that actually ran.
    if (input.command === 'commit' && !input.message) {
      throw new ToolValidationError({
        message: 'git: commit requires a message',
        field: 'message',
      });
    }

    // A flag-shaped `branch` is rejected for EVERY command, not just worktree.
    // The leading-dash check used to live inside validateWorktreeInput, so
    // `fetch` — which passes input.branch as a bare positional — accepted
    // `--upload-pack=<prog>` and handed git a program to execute. `exec.ts`
    // already denylists exactly those flags for the `git` binary; the git tool
    // did not reuse it. Checked centrally so the next command that forwards a
    // branch cannot reintroduce the gap (WS-090).
    assertSafeBranch(input);

    // Validate worktree paths before touching the filesystem: reject any path
    // that escapes the project root.
    if (input.command === 'worktree') {
      assertSafeWorktreeInput(input, ctx.projectRoot);
    }

    // Bound the search at projectRoot so a non-git project doesn't drift
    // into a parent repo (e.g. ~/repos/.git) and operate on the wrong tree.
    const gitDir = findGitDir(ctx.cwd, ctx.projectRoot);
    if (!gitDir) {
      throw new Error(`git: Not in a git repository (within project root ${ctx.projectRoot})`);
    }

    let args = buildArgs(input);
    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;

    // `git fetch <x>` reads x as a REMOTE. `branch` is documented as a branch
    // name, and `git fetch feature` failed ("'feature' does not appear to be a
    // git repository") — pull/push already address `origin <branch>`. A value
    // that names a configured remote still fetches that remote.
    if (input.command === 'fetch' && input.branch) {
      const remotes = await runGit(['remote'], gitDir, signal).catch(() => undefined);
      const names =
        remotes?.exitCode === 0 ? remotes.stdout.split(/\r?\n/).map((r) => r.trim()) : [];
      if (!names.includes(input.branch)) args = ['fetch', 'origin', input.branch];
    }

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
        const diffResult = await runGit(
          ['diff', '--cached', '--no-ext-diff', '--no-textconv'],
          gitDir,
          signal,
          { isolate: true },
        );
        // runGit already spools a large diff to disk and points at the full
        // file, so nothing past the preview is lost.
        if (diffResult.exitCode === 0) stagedDiff = diffResult.stdout;
      } catch {
        // Diff capture is best-effort; don't fail the whole operation
      }
    }

    const result = await runGit(args, gitDir, signal, {
      isolate: READ_COMMANDS.has(input.command),
    });
    if (stagedDiff !== undefined) result.diff = stagedDiff;
    if (safetyWarning !== undefined) result.warning = safetyWarning;
    return result;
  },
} satisfies Tool<GitInput, GitOutput>;

/**
 * Reject a `branch` that git would parse as an option, for every command.
 *
 * `git fetch --upload-pack=<prog>` (and `--exec=`, `--receive-pack=`) makes git
 * run an arbitrary program, so a branch name is a code-execution sink wherever
 * it reaches git as a bare positional. `' --'` is caught too: a value like
 * `main --upload-pack=x` splits into extra argv entries in any path that later
 * word-splits the branch.
 */
function assertSafeBranch(input: GitInput): void {
  const branch = input.branch;
  if (branch === undefined) return;
  if (!branch.startsWith('-') && !branch.includes(' --')) return;
  throw new ToolValidationError({
    message: `git: unsafe branch name (parsed as a git option): ${branch}`,
    field: 'branch',
  });
}

/**
 * Reject worktree inputs that could inject git flags or escape the project
 * root, and an `add` with no path (which used to silently run `worktree list`).
 */
function assertSafeWorktreeInput(input: GitInput, projectRoot: string): void {
  const reject = (message: string): never => {
    throw new ToolValidationError({ message: `git: ${message}`, field: 'worktreePath' });
  };

  // Flag injection on the path. Branch names are handled centrally by
  // assertSafeBranch before this runs (WS-090).
  if (input.worktreePath?.startsWith('-')) {
    reject(`unsafe worktree path: ${input.worktreePath}`);
  }

  if (input.worktreeAction === 'add' && !input.worktreePath) {
    reject('worktree add requires worktreePath');
  }

  // Path escape: add/remove targets must resolve inside the project root.
  if ((input.worktreeAction === 'add' || input.worktreeAction === 'remove') && input.worktreePath) {
    const root = resolve(projectRoot);
    const abs = resolve(root, input.worktreePath);
    if (abs !== root && !abs.startsWith(root + sep)) {
      reject(`unsafe worktree path (escapes project root): ${input.worktreePath}`);
    }
  }
}

function findGitDir(cwd: string, projectRoot: string): string | null {
  // Compare one spelling per directory: a trailing separator or a different
  // drive-letter case must not let the walk pass the project-root bound.
  const pathKey = (p: string): string =>
    process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
  const root = pathKey(projectRoot);
  let dir = cwd;
  for (;;) {
    try {
      const stat = statSync(resolve(dir, '.git'));
      // A normal repo has a `.git` directory; a linked worktree has a `.git`
      // *file* (gitlink pointing at the main repo). Accept both so the tool
      // operates inside a worktree when a subagent's cwd is a worktree dir.
      if (stat.isDirectory() || stat.isFile()) return dir;
    } catch {
      // continue
    }
    if (pathKey(dir) === root) break;
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
        ...NO_DIFF_PROGRAMS,
        `--max-count=${limit}`,
        ...(input.format === 'oneline' ? ['--oneline'] : []),
        ...(input.format === 'stat' ? ['--stat'] : []),
        ...(input.format === 'graph' ? ['--oneline', '--graph', '--decorate'] : []),
        ...(input.format === 'short' || !input.format ? [] : []),
      ];
    case 'diff':
      return ['diff', '--no-color', ...NO_DIFF_PROGRAMS, ...(files.length ? ['--', ...files] : [])];
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

/**
 * Subcommands that only read. They run isolated from the repository's own
 * config programs (fsmonitor, `.gitattributes` filters); the approved
 * operations that write keep git's ordinary behavior, hooks and filters
 * included, as when the user runs them.
 */
const READ_COMMANDS: ReadonlySet<string> = new Set(['status', 'log', 'diff']);
/** A diff driver or textconv the repository assigns runs on patch output. */
const NO_DIFF_PROGRAMS = ['--no-ext-diff', '--no-textconv'];

async function runGit(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  opts: { isolate?: boolean } = {},
): Promise<GitOutput> {
  if (signal.aborted) {
    throw signal.reason ?? new Error('git: aborted');
  }
  let isolation: Record<string, string> = {};
  if (opts.isolate) {
    const env = await gitIsolationEnv(cwd, { baseEnv: buildChildEnv() });
    if (!env)
      throw new Error('git: isolation unavailable, the repository config could not be read');
    isolation = env;
  }

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    // The model sees a head+tail preview; the spools keep the FULL streams on
    // disk so a big log/diff is never lost past the in-memory cap.
    const stdoutSpool = createOutputSpool({
      tool: 'git',
      thresholdBytes: commandOutputPreviewBytes(),
    });
    const stderrSpool = createOutputSpool({
      tool: 'git',
      thresholdBytes: commandOutputPreviewBytes(),
    });

    const child = spawn('git', args, {
      cwd,
      signal,
      env: { ...buildChildEnv(), ...isolation },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      const text = stdoutDecoder.write(chunk);
      if (text) stdoutSpool.write(text);
      if (text && stdout.length < MAX_OUTPUT) stdout += text.slice(0, MAX_OUTPUT - stdout.length);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      const text = stderrDecoder.write(chunk);
      if (text) stderrSpool.write(text);
      if (text && stderr.length < MAX_OUTPUT) stderr += text.slice(0, MAX_OUTPUT - stderr.length);
    });

    // 'error' means git could not be run (missing binary, bad cwd) or was
    // aborted — there is no git exit code to report, so reject.
    child.on('error', (err) => {
      stdoutSpool.finalize(); // idempotent — close any opened spool file
      stderrSpool.finalize();
      reject(
        (err as NodeJS.ErrnoException).code === 'ABORT_ERR'
          ? err
          : new Error(`git: could not run git ${args[0] ?? ''}: ${err.message}`, { cause: err }),
      );
    });

    child.on('close', (code) => {
      const stdoutTail = stdoutDecoder.end();
      if (stdoutTail) stdoutSpool.write(stdoutTail);
      if (stdoutTail && stdout.length < MAX_OUTPUT) {
        stdout += stdoutTail.slice(0, MAX_OUTPUT - stdout.length);
      }
      const stderrTail = stderrDecoder.end();
      if (stderrTail) stderrSpool.write(stderrTail);
      if (stderrTail && stderr.length < MAX_OUTPUT) {
        stderr += stderrTail.slice(0, MAX_OUTPUT - stderr.length);
      }
      const stdoutSpooled = stdoutSpool.finalize();
      const stderrSpooled = stderrSpool.finalize();
      // `MAX_OUTPUT` already bounded the raw buffers in memory; normalize strips
      // ANSI / progress / duplicate noise and head+tail-truncates to the shared
      // command cap so only useful output reaches the model.
      const isTruncated =
        stdoutBytes > MAX_OUTPUT ||
        stderrBytes > MAX_OUTPUT ||
        Buffer.byteLength(stdout, 'utf8') > commandOutputPreviewBytes() ||
        Buffer.byteLength(stderr, 'utf8') > commandOutputPreviewBytes();
      resolve({
        command: args[0] as GitSubcommand,
        stdout: normalizeCommandOutput(stdout) + (stdoutSpooled ? spoolNote(stdoutSpooled) : ''),
        stderr: normalizeCommandOutput(stderr) + (stderrSpooled ? spoolNote(stderrSpooled) : ''),
        exitCode: code ?? 1,
        truncated: isTruncated,
      });
    });
  });
}
