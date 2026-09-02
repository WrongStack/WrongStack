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
import type { Plugin } from '@wrongstack/core/types';
import { releaseHandle, BoundedMap } from '../runtime/index.js';

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
 * Performance: caches the branch name per cwd+signal combination to
 * avoid redundant git subprocess spawns on repeated hook invocations.
 * The cache is invalidated on setup() reload.
 */
/**
 * Branch lookups keyed by cwd. Bounded: a session that walks many
 * worktrees would otherwise retain one entry per directory forever.
 * The TTL also means a branch switch is picked up without a reload.
 */
const branchCache = new BoundedMap<string, string | null>({ max: 64, ttlMs: 2_000 });

function runGit(args: string[], cwd: string | undefined, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { encoding: 'utf-8', timeout: 3_000, cwd, windowsHide: true, signal },
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
  // Check cache first — avoids redundant git subprocess spawns.
  const cacheKey = `${cwd ?? 'undefined'}`;
  const cached = branchCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const branch = (await runGit(['branch', '--show-current'], cwd, signal)).trim();
    const result = branch || null;
    branchCache.set(cacheKey, result);
    return result;
  } catch (err) {
    if (signal.aborted) throw err;
    branchCache.set(cacheKey, null);
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
}

function detectGitCommand(command: string): GitCommandMatch | null {
  // Normalize whitespace for matching.
  const cmd = command.trim();

  // git commit (but NOT git commit-tree or similar)
  if (/\bgit\s+commit\b/.test(cmd)) {
    return { type: 'commit', snippet: cmd.slice(0, 120) };
  }
  // git push
  if (/\bgit\s+push\b/.test(cmd)) {
    return { type: 'push', snippet: cmd.slice(0, 120) };
  }
  // git merge (but NOT git merge-base, git merge-file as standalone tool)
  if (/\bgit\s+merge\s/.test(cmd)) {
    return { type: 'merge', snippet: cmd.slice(0, 120) };
  }
  return null;
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

    // Clear branch cache to ensure fresh detection after config changes.
    branchCache.clear();

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

      // Determine the git operation from the tool call.
      let gitOp: GitCommandMatch | null = null;

      if (toolName === 'git_autocommit') {
        // Dry-run is a preview and does not mutate git history, so it should
        // remain available on protected branches as the safe way to inspect
        // exactly what would be committed before switching branches.
        if (inp['dry_run'] === true) return;
        // The git-autocommit plugin's tool is a direct commit.
        gitOp = { type: 'commit', snippet: 'git_autocommit' };
      } else if (toolName === 'git') {
        gitOp = detectStructuredGitCommand(inp);
      } else {
        const rawCmd =
          inp['command'] ?? inp['CommandLine'] ?? inp['cmd'] ?? inp['script'] ?? inp['input'];
        const command = typeof rawCmd === 'string' ? rawCmd : undefined;
        if (typeof command !== 'string') return;
        gitOp = detectGitCommand(command);
      }

      if (!gitOp) return; // not a git commit/push/merge — let it through
      if (!shouldBlock(gitOp.type, cfg)) return; // config says don't block this op type

      // Check current branch.
      const branch = await getCurrentBranch(cwd, runtime.signal);
      if (!branch) return; // can't determine branch — don't block
      const protectedSet = new Set(cfg.branches);
      if (!protectedSet.has(branch)) return; // not protected — let it through

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
