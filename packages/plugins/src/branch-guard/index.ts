/**
 * branch-guard plugin — PreToolUse hook that blocks commits, pushes,
 * and merges to protected branches (default: main, master).
 *
 * Tools registered:
 * - branch_guard_status : Show protected branches, mode, and counters.
 *
 * Hooks registered:
 * - PreToolUse with matcher `bash|git|git_autocommit`. Inspects the tool
 *   input for git commit / push / merge commands (bash), structured git
 *   operations (git), or the tool call itself (git_autocommit). If the current
 *   branch is protected, the call is blocked with a clear reason.
 *
 * Config (`config.extensions['branch-guard']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,               // set false to make the hook a no-op
 *   "branches": ["main", "master"],  // protected branch names
 *   "mode": "block",                 // "block" | "warn" | "off"
 *   "blockMerge": true,              // also block merges into protected
 *   "blockPush": true,               // also block pushes from protected
 *   "blockCommit": true              // also block commits on protected
 * }
 * ```
 *
 * @public
 */

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import type { Plugin } from '@wrongstack/contracts/types';
import { gitIsolationEnv } from '@wrongstack/primitives';
import { releaseHandle } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

const state = {
  invocationCount: 0,
  blockCount: 0,
  warnCount: 0,
  hookUnregister: null as null | (() => void),
  configUnregister: null as null | (() => void),
  lastBlock: null as null | {
    tool: string;
    branch: string;
    command: string;
    when: string;
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface BranchGuardConfig {
  /** Set false to keep the plugin loaded but make the hook a no-op. */
  enabled: boolean;
  /** Branch names that are protected (no commits/pushes/merges). */
  branches: string[];
  /** Action: "block" refuses, "warn" injects context, "off" disables the hook. */
  mode: 'block' | 'warn' | 'off';
  /** Block commits on protected branches. */
  blockCommit: boolean;
  /** Block pushes from protected branches. */
  blockPush: boolean;
  /** Block merges into protected branches. */
  blockMerge: boolean;
}

const DEFAULTS: BranchGuardConfig = {
  enabled: true,
  branches: ['main', 'master'],
  mode: 'block',
  blockCommit: true,
  blockPush: true,
  blockMerge: true,
};

function readConfig(raw: unknown): BranchGuardConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const rawBranches =
    r['branches'] ?? r['protectedBranches'] ?? r['protected_branches'] ?? r['protected'];
  const branches = Array.isArray(rawBranches)
    ? (rawBranches as unknown[]).filter((b): b is string => typeof b === 'string')
    : DEFAULTS.branches;
  const rawMode =
    typeof (r['mode'] ?? r['action']) === 'string'
      ? String(r['mode'] ?? r['action'])
          .trim()
          .toLowerCase()
      : undefined;
  const mode = rawMode === 'warn' ? 'warn' : rawMode === 'off' ? 'off' : 'block';
  return {
    enabled: r['enabled'] !== false && mode !== 'off',
    branches: branches.length > 0 ? branches : DEFAULTS.branches,
    mode,
    blockCommit: (r['blockCommit'] ?? r['block_commit']) !== false,
    blockPush: (r['blockPush'] ?? r['block_push']) !== false,
    blockMerge: (r['blockMerge'] ?? r['block_merge']) !== false,
  };
}

function readHostConfig(raw: unknown): BranchGuardConfig {
  const host = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const extensions = host['extensions'];
  const branchGuardOptions =
    extensions && typeof extensions === 'object'
      ? (extensions as Record<string, unknown>)['branch-guard']
      : undefined;
  const cfg = readConfig(branchGuardOptions);
  if (hasDisabledPluginEntry(host['plugins'])) {
    return { ...cfg, enabled: false, mode: 'off' };
  }
  return cfg;
}

function hasDisabledPluginEntry(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const r = entry as Record<string, unknown>;
    if (r['enabled'] !== false) return false;
    const name = typeof r['name'] === 'string' ? r['name'] : '';
    return name === 'branch-guard' || name === '@wrongstack/plugins/branch-guard';
  });
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Get the current git branch name. Returns null if not a git repo
 * or git is unavailable.
 *
 * Not cached: a 2 s per-cwd cache let `commit on feat -> git checkout main ->
 * commit` inside the window be judged against the stale branch and land on
 * the protected one. The lookup only runs for a guarded commit/push/merge.
 */
async function runGit(
  args: string[],
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  // The repository's config names programs git runs on status/diff
  // (fsmonitor, `.gitattributes` filters); when they cannot be switched off,
  // git does not run.
  const isolation = await gitIsolationEnv(cwd ?? process.cwd(), { timeoutMs: 3_000 });
  if (!isolation)
    throw new Error('git isolation unavailable: the repository config could not be read');
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        encoding: 'utf-8',
        timeout: 3_000,
        cwd,
        env: { ...process.env, ...isolation },
        windowsHide: true,
        signal,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

async function getCurrentBranch(
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const branch = (await runGit(['branch', '--show-current'], cwd, signal)).trim();
    return branch || null;
  } catch (err) {
    if (signal.aborted) throw err;
    return null;
  }
}

/**
 * Check if the working tree has uncommitted changes (staged or unstaged).
 * Uses `git status --porcelain` — any non-empty output means dirty tree.
 * Returns false if not a git repo or the command fails (best-effort).
 */
async function detectUncommittedChanges(
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const output = (await runGit(['status', '--porcelain'], cwd, signal)).trim();
    return output.length > 0;
  } catch (err) {
    if (signal.aborted) throw err;
    return false;
  }
}

/**
 * Check if a bash command string contains a git operation that
 * modifies the branch history.
 */
interface GitCommandMatch {
  type: 'commit' | 'push' | 'merge';
  /** The matched substring (for display). */
  snippet: string;
  /**
   * Branch an earlier `git checkout|switch` in the SAME command moved to, so
   * the op runs there — not on the branch current when the hook fires.
   */
  onBranch?: string | undefined;
}

/**
 * Every commit/push/merge in a shell command, each tagged with the branch a
 * preceding in-command `git checkout <b>` / `git switch <b>` moved to.
 * Judging the whole command against the branch current before it ran let
 * `git checkout main && git merge feat` land on main from a feature branch.
 * Path restores (`git checkout main -- file`) do not switch; for -b/-c the
 * new branch name is the target; `git switch -` (unknown target) is ignored.
 */
/**
 * Git's global options, which sit between `git` and the subcommand:
 * `-C <dir>`, `-c <k=v>`, `--git-dir <d>` / `--work-tree <d>`, `--opt=value`
 * and bare flags (`--no-pager`, `-P`). Matching `git\s+commit` alone let
 * `git -C . commit` or `git -c user.name=x commit` past the guard.
 */
const GIT_GLOBAL_OPTIONS = String.raw`(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--(?:git-dir|work-tree|namespace|exec-path|super-prefix)\s+(?!-)\S+|--?(?![Cc]\s)[A-Za-z][\w-]*(?:=\S+)?))*`;
/**
 * The git binary as a shell spells it: `git`, Windows' `git.exe`, and the end
 * of a quoted full path (`"C:\Program Files\Git\cmd\git.exe" commit`).
 */
const GIT_BINARY = String.raw`\bgit(?:\.exe)?["']?`;
const GIT_OP_RE = new RegExp(
  String.raw`${GIT_BINARY}${GIT_GLOBAL_OPTIONS}\s+(commit|push|merge)(?![a-zA-Z0-9_-])`,
  'g',
);
const GIT_SWITCH_RE = new RegExp(
  String.raw`${GIT_BINARY}${GIT_GLOBAL_OPTIONS}\s+(checkout|switch)\s+([^;&|\n]*)`,
  'g',
);

/**
 * Whether `name` is a branch `git checkout <name>` would switch to: a local
 * branch, or a remote-tracking one checkout DWIM-creates a local branch from.
 */
async function isCheckoutBranch(
  name: string,
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], cwd, signal);
    return true;
  } catch (err) {
    if (signal.aborted) throw err;
  }
  try {
    const remote = await runGit(
      ['for-each-ref', '--count=1', '--format=%(refname)', `refs/remotes/*/${name}`],
      cwd,
      signal,
    );
    return remote.trim().length > 0;
  } catch (err) {
    if (signal.aborted) throw err;
    return false;
  }
}

/**
 * Whether a switch's global options leave it in this repository. A switch run
 * with `-C <elsewhere>`, `--git-dir` or `--work-tree` moves another checkout's
 * branch; applying it here judged `git -C ../other checkout feat && git commit`
 * on main as a commit on feat. Unknown cwd: only a bare switch counts.
 */
function switchesThisRepo(head: string, cwd: string | undefined): boolean {
  if (/\s--(?:git-dir|work-tree)\b/.test(head)) return false;
  const dirs = [...head.matchAll(/\s-C\s+("[^"]*"|'[^']*'|\S+)/g)].map((d) =>
    (d[1] ?? '').replace(/^['"]|['"]$/g, ''),
  );
  if (dirs.length === 0) return true;
  if (!cwd) return false;
  const target = dirs.reduce((dir, next) => path.resolve(dir, next), cwd);
  const same = (a: string) => (process.platform === 'win32' ? a.toLowerCase() : a);
  return same(path.resolve(target)) === same(path.resolve(cwd));
}

/** The branch `git checkout -` would switch back to, when git can name it. */
async function previousCheckoutBranch(
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const name = (await runGit(['rev-parse', '--abbrev-ref', '@{-1}'], cwd, signal)).trim();
    return name && name !== 'HEAD' ? name : undefined;
  } catch (err) {
    if (signal.aborted) throw err;
    return undefined;
  }
}

/**
 * A plain `git checkout <x>` (no -b/-c/--orphan) is a branch switch only when
 * `<x>` IS a branch: `git checkout src/app.ts` restores a file and leaves HEAD
 * where it was. Reading every such target as a branch let
 * `git checkout src/app.ts && git commit -am x` on main be judged against a
 * "branch" named src/app.ts — and commit to main unblocked. `git switch`
 * never restores files, so its target needs no check.
 */
async function detectGitOpsInCommand(
  command: string,
  isBranch: (name: string) => Promise<boolean>,
  previousBranch: () => Promise<string | undefined> = async () => undefined,
  cwd?: string,
): Promise<GitCommandMatch[]> {
  const cmd = command.trim();
  const snippet = cmd.slice(0, 120);
  const events: Array<{
    at: number;
    op?: GitCommandMatch['type'];
    to?: string;
    verify?: boolean;
  }> = [];
  for (const m of cmd.matchAll(GIT_OP_RE)) {
    events.push({ at: m.index ?? 0, op: m[1] as GitCommandMatch['type'] });
  }
  for (const m of cmd.matchAll(GIT_SWITCH_RE)) {
    const head = m[0].slice(0, m[0].lastIndexOf(m[1] ?? '', m[0].length - (m[2] ?? '').length));
    if (!switchesThisRepo(head, cwd)) continue;
    const args = (m[2] ?? '').trim().split(/\s+/).filter(Boolean);
    if (args.includes('--')) continue;
    const create = args.findIndex((a) => /^(?:-[bBcC]|--orphan)$/.test(a));
    const target =
      create >= 0 ? args[create + 1] : args.find((a) => a === '-' || !a.startsWith('-'));
    if (target) {
      events.push({
        at: m.index ?? 0,
        to: target.replace(/^['"]|['"]$/g, ''),
        verify: m[1] === 'checkout' && create < 0,
      });
    }
  }
  // Only a command that also commits/pushes/merges needs its switches resolved.
  if (!events.some((e) => e.op)) return [];
  events.sort((a, b) => a.at - b.at);
  const ops: GitCommandMatch[] = [];
  let onBranch: string | undefined;
  // Branch before the last in-command switch: null = the branch the command
  // started on, undefined = no switch yet (git's own previous branch).
  let previous: string | null | undefined;
  for (const e of events) {
    if (e.to !== undefined) {
      // `git checkout -` / `@{-1}` goes BACK; read literally it was ignored, so
      // `git checkout feat && git checkout - && git commit` on main was judged
      // as a commit on feat while git committed to main.
      if (e.to === '-' || e.to === '@{-1}') {
        const back = previous === undefined ? await previousBranch() : previous;
        previous = onBranch ?? null;
        onBranch = back ?? undefined;
      } else if (!e.verify || (await isBranch(e.to))) {
        previous = onBranch ?? null;
        onBranch = e.to;
      }
    } else if (e.op) ops.push({ type: e.op, snippet, onBranch });
  }
  return ops;
}

function detectStructuredGitCommand(input: Record<string, unknown>): GitCommandMatch | null {
  const command = input['command'];
  if (command === 'commit') {
    if (input['dry_run'] === true) return null;
    return { type: 'commit', snippet: 'git commit' };
  }
  if (command === 'push') return { type: 'push', snippet: 'git push' };
  if (command === 'merge') return { type: 'merge', snippet: 'git merge' };
  return null;
}

/**
 * Check if a git operation type should be blocked based on config.
 */
function shouldBlock(op: 'commit' | 'push' | 'merge', cfg: BranchGuardConfig): boolean {
  if (op === 'commit') return cfg.blockCommit;
  if (op === 'push') return cfg.blockPush;
  if (op === 'merge') return cfg.blockMerge;
  return false;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'branch-guard',
  version: '0.1.0',
  description:
    'Pre-tool hook that blocks commits, pushes, and merges to protected branches (default: main, master)',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      branches: {
        type: 'array',
        items: { type: 'string' },
        default: ['main', 'master'],
        description: 'Branch names that are protected.',
      },
      mode: {
        type: 'string',
        enum: ['block', 'warn'],
        default: 'block',
        description: '"block" refuses the call; "warn" injects context but lets it through.',
      },
      blockCommit: {
        type: 'boolean',
        default: true,
        description: 'Block commits on protected branches.',
      },
      blockPush: {
        type: 'boolean',
        default: true,
        description: 'Block pushes from protected branches.',
      },
      blockMerge: {
        type: 'boolean',
        default: true,
        description: 'Block merges into protected branches.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.blockCount = 0;
    state.warnCount = 0;
    state.hookUnregister = releaseHandle(state.hookUnregister);
    state.configUnregister = releaseHandle(state.configUnregister);
    state.lastBlock = null;

    let cfg = readHostConfig(api.config);
    state.configUnregister = api.onConfigChange((next) => {
      cfg = readHostConfig(next);
    });
    const cwd = typeof process.cwd === 'function' ? process.cwd() : undefined;

    const hook = async (
      input: { toolName?: string | undefined; toolInput?: unknown },
      runtime: { signal: AbortSignal } = { signal: new AbortController().signal },
    ): Promise<{
      decision?: 'block' | 'allow' | undefined;
      reason?: string;
      additionalContext?: string;
    } | void> => {
      const toolName = input.toolName ?? '';
      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      state.invocationCount += 1;

      if (!cfg.enabled || cfg.mode === 'off') return;

      // Determine the git operation(s) from the tool call.
      let gitOps: GitCommandMatch[] = [];

      if (toolName === 'git_autocommit') {
        // Dry-run is a preview and does not mutate git history, so it should
        // remain available on protected branches as the safe way to inspect
        // exactly what would be committed before switching branches.
        if (inp['dry_run'] === true) return;
        // The git-autocommit plugin's tool is a direct commit.
        gitOps = [{ type: 'commit', snippet: 'git_autocommit' }];
      } else if (toolName === 'git') {
        const op = detectStructuredGitCommand(inp);
        gitOps = op ? [op] : [];
      } else {
        const rawCmd =
          inp['command'] ?? inp['CommandLine'] ?? inp['cmd'] ?? inp['script'] ?? inp['input'];
        const command = typeof rawCmd === 'string' ? rawCmd : undefined;
        if (typeof command !== 'string') return;
        gitOps = await detectGitOpsInCommand(
          command,
          (name) => isCheckoutBranch(name, cwd, runtime.signal),
          () => previousCheckoutBranch(cwd, runtime.signal),
          cwd,
        );
      }

      // Ops the config does not block — or none at all — let it through.
      const blockable = gitOps.filter((op) => shouldBlock(op.type, cfg));
      if (blockable.length === 0) return;

      // Each op runs on the branch an earlier in-command switch moved to, else
      // on the current branch (unknown current branch — don't block on it).
      const current = blockable.some((op) => op.onBranch === undefined)
        ? await getCurrentBranch(cwd, runtime.signal)
        : null;
      const protectedSet = new Set(cfg.branches);
      let gitOp: GitCommandMatch | undefined;
      let branch = '';
      for (const op of blockable) {
        const on = op.onBranch ?? current;
        if (on && protectedSet.has(on)) {
          gitOp = op;
          branch = on;
          break;
        }
      }
      if (!gitOp) return; // not on a protected branch — let it through

      // Protected branch + blocked operation → act.
      const when = new Date().toISOString();
      const opVerb =
        gitOp.type === 'commit'
          ? 'committing to'
          : gitOp.type === 'push'
            ? 'pushing from'
            : 'merging into';

      // Check for uncommitted changes so we can suggest stash.
      const hasUncommitted = await detectUncommittedChanges(cwd, runtime.signal);

      // Build a helpful suggestion: stash + branch + retry the same operation.
      // For git_autocommit, keep the final step at the tool level so agents do
      // not fall back to raw `git commit` and bypass scoped staging safeguards.
      const retryStep =
        toolName === 'git_autocommit' ? 'retry git_autocommit' : `git ${gitOp.type} ...`;
      const suggestionParts: string[] = [];
      if (hasUncommitted) {
        suggestionParts.push('git stash');
      }
      suggestionParts.push('git checkout -b feat/my-change');
      if (hasUncommitted) {
        suggestionParts.push('git stash pop');
      }
      suggestionParts.push(retryStep);
      const suggestion = suggestionParts.join(' → ');

      const reason =
        `branch-guard: refused to ${gitOp.type} on protected branch '${branch}'. ` +
        `You're on a protected branch. Use a feature branch instead.\n` +
        (hasUncommitted
          ? `You have uncommitted changes. Safe workflow:\n  ${suggestion}\n`
          : `Safe workflow:\n  ${suggestion}\n`) +
        `Protected branches: ${cfg.branches.join(', ')}.`;

      state.lastBlock = { tool: toolName, branch, command: gitOp.snippet, when };

      if (cfg.mode === 'block') {
        state.blockCount += 1;
        return {
          decision: 'block',
          reason,
        };
      }

      // mode === 'warn'
      state.warnCount += 1;
      return {
        decision: 'allow',
        additionalContext:
          `\n⚠️ branch-guard: you are ${opVerb} protected branch '${branch}'. ` +
          (hasUncommitted
            ? `You have uncommitted changes — consider \`git stash\` before switching branches. `
            : '') +
          `Use a feature branch instead. Protected: ${cfg.branches.join(', ')}.`,
      };
    };

    state.hookUnregister = api.registerHook('PreToolUse', 'bash|git|git_autocommit', hook, {
      name: 'branch-guard',
      stage: 'validate',
      timeoutMs: 7_000,
      failurePolicy: 'closed',
      policy: true,
    });

    // --- branch_guard_status tool ---
    api.tools.register({
      name: 'branch_guard_status',
      description:
        'Reports branch-guard state: protected branches, mode, and per-session invocation/block/warn counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Git',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          branches: cfg.branches,
          mode: cfg.mode,
          blockCommit: cfg.blockCommit,
          blockPush: cfg.blockPush,
          blockMerge: cfg.blockMerge,
          counters: {
            invocations: state.invocationCount,
            blocks: state.blockCount,
            warns: state.warnCount,
          },
          lastBlock: state.lastBlock,
        };
      },
    });

    api.log.info('branch-guard plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      branches: cfg.branches,
      mode: cfg.mode,
    });
  },

  teardown(api) {
    if (state.configUnregister) {
      try {
        state.configUnregister();
      } catch {
        // best-effort
      }
      state.configUnregister = null;
    }
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    const final = {
      invocations: state.invocationCount,
      blocks: state.blockCount,
      warns: state.warnCount,
    };
    state.invocationCount = 0;
    state.blockCount = 0;
    state.warnCount = 0;
    state.lastBlock = null;
    api.log.info('branch-guard: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message:
        state.lastBlock === null
          ? `branch-guard: ${state.invocationCount} invocation(s), ${state.blockCount} block(s)`
          : `branch-guard: last block on '${state.lastBlock.branch}' (${state.lastBlock.command}) at ${state.lastBlock.when}`,
      counters: {
        invocations: state.invocationCount,
        blocks: state.blockCount,
        warns: state.warnCount,
      },
      lastBlock: state.lastBlock,
    };
  },
};

export default plugin;
