/**
 * diff-summary plugin — PostToolUse hook that injects a compact diff
 * into the LLM's context after every `write` or `edit`.
 *
 * Tools registered:
 * - diff_summary_status : Show config + per-session counters.
 *
 * Hooks registered:
 * - PostToolUse with matcher `write|edit`. After the tool completes,
 *   runs `git diff -- <path>` to capture what changed and injects a
 *   capped unified diff (or stat summary) as `additionalContext`.
 *
 * Config (`config.extensions['diff-summary']`):
 *
 * ```jsonc
 * {
 *   "maxLines": 50,       // cap diff context at N lines
 *   "showStat": true,     // include "+N -M" summary line
 *   "mode": "diff"        // "diff" (unified diff) | "stat" (counts only) | "off"
 * }
 * ```
 *
 * Why: The `write` tool's result doesn't include a diff. The `edit`
 * tool shows the replacement but not the full file context. This
 * plugin gives the LLM consistent, compact visibility into what its
 * change actually did to the file — confirming the edit applied
 * correctly and showing surrounding context.
 *
 * @public
 */
import type { Plugin } from '@wrongstack/core';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Sandbox: reject file paths that resolve outside the project root.
// diff-summary invokes `git diff` against whatever path the write/edit
// tool passed. An absolute path outside the project would feed host FS
// contents into the LLM context. Used to call `execSync` with a string
// template — fine when path contains no shell metacharacters, brittle
// when it does. Switch to execFileSync for argv-form git invocations so
// filenames with spaces, double quotes, or shell metacharacters cannot
// escape the command.
// ---------------------------------------------------------------------------
function withinProject(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return false;
  const root = process.cwd();
  const resolved = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, resolved);
  if (rel === '' || rel === '.') return true;
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

const state = {
  invocationCount: 0,
  /** Times a diff was successfully generated and injected. */
  injectedCount: 0,
  /** Times git diff failed (not a repo, untracked, etc.). */
  fallbackCount: 0,
  /** Hook handle for teardown. */
  hookUnregister: null as null | (() => void),
  /** Last diff summary — surfaced by health() + status tool. */
  lastSummary: null as null | {
    path: string;
    tool: string;
    added: number;
    removed: number;
    when: string;
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type Mode = 'diff' | 'stat' | 'off';

interface DiffSummaryConfig {
  /** Cap diff context at N lines. */
  maxLines: number;
  /** Include "+N -M" summary line. */
  showStat: boolean;
  /** "diff" (unified diff), "stat" (counts only), "off" (disabled). */
  mode: Mode;
  /**
   * Number of context lines around each change in the unified diff.
   * Maps to git's `-U<N>` flag. 0 = no context (compact), 3 = git
   * default, higher = more surrounding lines for orientation.
   */
  includeContext: number;
}

const DEFAULTS: DiffSummaryConfig = {
  maxLines: 50,
  showStat: true,
  mode: 'diff',
  includeContext: 3,
};

function readConfig(raw: unknown): DiffSummaryConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    maxLines:
      typeof r['maxLines'] === 'number' && r['maxLines'] > 0 ? r['maxLines'] : DEFAULTS.maxLines,
    showStat: r['showStat'] !== false,
    mode: r['mode'] === 'stat' ? 'stat' : r['mode'] === 'off' ? 'off' : 'diff',
    includeContext:
      typeof r['includeContext'] === 'number' && r['includeContext'] >= 0
        ? r['includeContext']
        : DEFAULTS.includeContext,
  };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

interface DiffResult {
  /** Unified diff text (may be truncated). Empty if no changes. */
  diff: string;
  /** Lines added (approximate, from diff headers). */
  added: number;
  /** Lines removed (approximate). */
  removed: number;
  /** True if this is a new file (no git history). */
  isNewFile: boolean;
}

/**
 * Run `git diff -- <path>` to get the unified diff of the file against
 * its last committed version. For untracked files, tries
 * `git diff --no-index /dev/null <path>`.
 *
 * Returns null if not in a git repo or git is unavailable.
 */
function getGitDiff(filePath: string, contextLines: number, cwd?: string): DiffResult | null {
  const opts = {
    encoding: 'utf-8' as const,
    timeout: 3_000,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'] as 'pipe'[],
  };

  // First, check if the file is tracked by git. execFileSync (argv) so a
  // filePath with `"` or `;` cannot escape the command.
  let isTracked = false;
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', filePath], opts);
    isTracked = true;
  } catch {
    isTracked = false;
  }

  try {
    let rawDiff: string;
    const contextFlag = `-U${contextLines}`;
    if (isTracked) {
      // Standard diff for tracked files — argv form, no shell interpolation.
      rawDiff = execFileSync('git', ['diff', contextFlag, '--', filePath], opts);
    } else {
      // New/untracked file — diff against /dev/null.
      try {
        rawDiff = execFileSync(
          'git',
          ['diff', '--no-index', contextFlag, '/dev/null', filePath],
          opts,
        );
      } catch (err: unknown) {
        // git diff --no-index exits 1 when there ARE differences (which is
        // what we want). stdout has the diff.
        const e = err as { stdout?: string };
        rawDiff = e.stdout ?? '';
      }
    }

    // If diff is empty, the file might be staged but not modified,
    // or the write produced identical content.
    if (!rawDiff.trim()) {
      return { diff: '', added: 0, removed: 0, isNewFile: !isTracked };
    }

    // Parse added/removed from diff line markers.
    const lines = rawDiff.split('\n');
    let added = 0;
    let removed = 0;
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }

    return { diff: rawDiff, added, removed, isNewFile: !isTracked };
  } catch {
    return null;
  }
}

/**
 * Build a compact stat-only summary (no diff body).
 */
function buildStatSummary(filePath: string, result: DiffResult): string {
  if (result.diff === '') return `${filePath}: no changes`;
  const tag = result.isNewFile ? ' (new file)' : '';
  return `${filePath}${tag}: +${result.added} -${result.removed}`;
}

/**
 * Build a full unified diff summary, capped at maxLines.
 */
function buildDiffSummary(filePath: string, result: DiffResult, maxLines: number): string {
  if (result.diff === '') return `${filePath}: no changes`;
  const lines = result.diff.split('\n');
  const tag = result.isNewFile ? ' (new file)' : '';
  if (lines.length <= maxLines) {
    return `${filePath}${tag}: +${result.added} -${result.removed}\n${result.diff}`;
  }
  const truncated = lines.slice(0, maxLines).join('\n');
  return `${filePath}${tag}: +${result.added} -${result.removed}\n${truncated}\n... (${lines.length - maxLines} more lines truncated)`;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'diff-summary',
  version: '0.1.0',
  description:
    'PostToolUse hook that injects a compact git diff into the LLM context after every write or edit',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      maxLines: {
        type: 'number',
        minimum: 5,
        default: 50,
        description: 'Cap diff context at N lines to avoid blowing up the context window.',
      },
      showStat: {
        type: 'boolean',
        default: true,
        description: 'Include "+N -M" summary line.',
      },
      mode: {
        type: 'string',
        enum: ['diff', 'stat', 'off'],
        default: 'diff',
        description:
          '"diff" injects unified diff; "stat" injects only +N -M counts; "off" disables the hook.',
      },
      includeContext: {
        type: 'number',
        minimum: 0,
        default: 3,
        description:
          'Context lines around each change (git -U<N>). 0 = compact (no surrounding lines), 3 = git default, higher = more orientation.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.injectedCount = 0;
    state.fallbackCount = 0;
    state.hookUnregister = null;
    state.lastSummary = null;

    const cfg = readConfig(api.config.extensions?.['diff-summary']);
    const cwd = typeof process.cwd === 'function' ? process.cwd() : undefined;

    const hook = (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): { additionalContext?: string | undefined } | void => {
      if (cfg.mode === 'off') return;

      // Skip if the tool errored — no point summarizing a failed write.
      if (input.toolResult?.isError) return;

      const toolName = input.toolName ?? '';
      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const filePath = inp['path'] as string | undefined;
      if (!filePath || typeof filePath !== 'string') return;

      state.invocationCount += 1;

      // Sandbox: refuse to diff a file outside the project root. Without
      // this a prompt-injected write with an absolute host path could
      // stream host-fs content into the LLM context.
      if (!withinProject(filePath)) {
        state.fallbackCount += 1;
        return;
      }

      const result = getGitDiff(filePath, cfg.includeContext, cwd);
      if (!result) {
        state.fallbackCount += 1;
        return; // not a git repo or git failed — silent
      }

      if (result.diff === '' && result.added === 0 && result.removed === 0) {
        return; // no changes — nothing to summarize
      }

      state.injectedCount += 1;
      state.lastSummary = {
        path: filePath,
        tool: toolName,
        added: result.added,
        removed: result.removed,
        when: new Date().toISOString(),
      };

      let summary: string;
      if (cfg.mode === 'stat') {
        summary = buildStatSummary(filePath, result);
      } else {
        summary = buildDiffSummary(filePath, result, cfg.maxLines);
      }

      const header = cfg.showStat ? `\n📝 diff-summary (${toolName}): ` : '\n📝 diff-summary: ';

      return {
        additionalContext: header + summary,
      };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook);

    // --- diff_summary_status tool ---
    api.tools.register({
      name: 'diff_summary_status',
      description:
        'Reports diff-summary state: mode, maxLines, and per-session invocation/injected/fallback counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Meta',
      mutating: false,
      async execute() {
        return {
          ok: true,
          mode: cfg.mode,
          maxLines: cfg.maxLines,
          showStat: cfg.showStat,
          includeContext: cfg.includeContext,
          counters: {
            invocations: state.invocationCount,
            injected: state.injectedCount,
            fallbacks: state.fallbackCount,
          },
          lastSummary: state.lastSummary,
        };
      },
    });

    api.log.info('diff-summary plugin loaded', {
      version: '0.1.0',
      mode: cfg.mode,
      maxLines: cfg.maxLines,
    });
  },

  teardown(api) {
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
      injected: state.injectedCount,
      fallbacks: state.fallbackCount,
    };
    state.invocationCount = 0;
    state.injectedCount = 0;
    state.fallbackCount = 0;
    state.lastSummary = null;
    api.log.info('diff-summary: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message:
        state.lastSummary === null
          ? `diff-summary: ${state.invocationCount} invocation(s), ${state.injectedCount} injected`
          : `diff-summary: last ${state.lastSummary.tool} on ${state.lastSummary.path} (+${state.lastSummary.added} -${state.lastSummary.removed}) at ${state.lastSummary.when}`,
      counters: {
        invocations: state.invocationCount,
        injected: state.injectedCount,
        fallbacks: state.fallbackCount,
      },
      lastSummary: state.lastSummary,
    };
  },
};

export default plugin;
