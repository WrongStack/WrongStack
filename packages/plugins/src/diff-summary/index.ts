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

import { execFile } from 'node:child_process';
import type { Plugin } from '@wrongstack/core/types';
import { releaseHandle, BoundedMap, withinProject } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Sandbox: reject file paths that resolve outside the project root.
// diff-summary invokes `git diff` against whatever path the write/edit
// tool passed. An absolute path outside the project would feed host FS
// contents into the LLM context. Git is invoked with argv-form `execFile`, so
// filenames with spaces, double quotes, or shell metacharacters cannot
// escape the command, and the post-tool hook does not block the event loop.
// ---------------------------------------------------------------------------
// withinProject() imported from ../runtime/index.js

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

const state = {
  invocationCount: 0,
  /** Times a diff was successfully generated and injected. */
  injectedCount: 0,
  /** Times git diff failed (not a repo, untracked, etc.). */
  fallbackCount: 0,
  /** Times the per-path throttle fired (no git diff was spawned). */
  throttledCount: 0,
  /** Times the content hash matched the last injection (no git diff). */
  duplicateContentCount: 0,
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
  /**
   * Minimum interval (ms) between two diff-summary injections for
   * the SAME path. Defaults to 1000 (1 s). Set to 0 to disable the
   * per-path throttle. Without this, a model retry that re-issues
   * an `edit` (or a tight loop of writes to the same file) would
   * pay a `git diff` per call -- easily 50-500 ms each.
   */
  minIntervalMs: number;
  /**
   * When true (default), the plugin fingerprints each PostToolUse
   * payload's `content` (write) or `new_string` (edit) with a tiny
   * hash and skips the `git diff` when the hash matches the one
   * injected for this path last time. Catches the common case of
   * the model re-issuing an identical edit because its first call
   * "didn't seem to take". Default ON.
   */
  enableContentHashCache: boolean;
}

const DEFAULTS: DiffSummaryConfig = {
  maxLines: 50,
  showStat: true,
  mode: 'diff',
  includeContext: 3,
  minIntervalMs: 1_000,
  enableContentHashCache: true,
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
    minIntervalMs:
      typeof r['minIntervalMs'] === 'number' && r['minIntervalMs'] >= 0
        ? Math.floor(r['minIntervalMs'])
        : DEFAULTS.minIntervalMs,
    enableContentHashCache: r['enableContentHashCache'] !== false,
  };
}

/**
 * Tiny non-cryptographic content fingerprint for the per-path
 * content-hash cache. DJB2 over the string produces a stable
 * 32-bit unsigned hash; collisions are tolerable (they only mean a
 * false dedupe -> we miss one diff, not corrupt data). The input is
 * capped at 64 KB to keep the cost bounded on very large files --
 * the first 64 KB is more than enough to detect "same edit, retry".
 */
function contentHash(s: string): number {
  const cap = Math.min(s.length, 65536);
  let h = 5381;
  for (let i = 0; i < cap; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/**
 * Per-path memo: last injected content hash + last injection time.
 * Bounded by the set of paths the user has touched this session --
 * typically tens to hundreds, not thousands.
 */
interface PathMemo {
  hash: number;
  lastInjectedAt: number;
}
/**
 * Per-path diff memo. Bounded: one entry per file touched in a long
 * session over a large repository added up to an unbounded retain.
 */
const pathMemo = new BoundedMap<string, PathMemo>({ max: 512 });

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
interface GitCommandResult {
  ok: boolean;
  stdout: string;
}

function runGit(args: string[], cwd?: string): Promise<GitCommandResult> {
  return new Promise((resolveCommand) => {
    execFile(
      'git',
      args,
      {
        encoding: 'utf8',
        timeout: 3000,
        cwd,
        windowsHide: true,
        maxBuffer: 5 * 1024 * 1024,
      },
      (error, stdout) => resolveCommand({ ok: !error, stdout }),
    );
  });
}

async function getGitDiff(
  filePath: string,
  contextLines: number,
  cwd?: string,
): Promise<DiffResult | null> {
  // First, check if the file is tracked by git. argv form ensures a
  // filePath with `"` or `;` cannot escape the command.
  const tracked = await runGit(['ls-files', '--error-unmatch', '--', filePath], cwd);
  const isTracked = tracked.ok;

  try {
    let rawDiff: string;
    const contextFlag = `-U${contextLines}`;
    if (isTracked) {
      // Standard diff for tracked files — argv form, no shell interpolation.
      const result = await runGit(['diff', contextFlag, '--', filePath], cwd);
      if (!result.ok) return null;
      rawDiff = result.stdout;
    } else {
      // New/untracked file — diff against /dev/null.
      // git diff --no-index exits 1 when there ARE differences; stdout still
      // contains the desired diff, so the status is intentionally ignored.
      rawDiff = (await runGit(['diff', '--no-index', contextFlag, '/dev/null', filePath], cwd))
        .stdout;
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
      minIntervalMs: {
        type: 'number',
        minimum: 0,
        default: 1000,
        description:
          'Per-path throttle: minimum interval (ms) between two diff-summary injections for the same file. Skips `git diff` when the model re-touches a file within the window. Set to 0 to disable.',
      },
      enableContentHashCache: {
        type: 'boolean',
        default: true,
        description:
          'When true, fingerprints the PostToolUse payload content and skips `git diff` when the hash matches the previously injected hash for the same path. Catches "edit retry" loops.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.injectedCount = 0;
    state.fallbackCount = 0;
    state.throttledCount = 0;
    state.duplicateContentCount = 0;
    state.hookUnregister = releaseHandle(state.hookUnregister);
    state.lastSummary = null;
    pathMemo.clear();

    const cfg = readConfig(api.config.extensions?.['diff-summary']);
    const cwd = typeof process.cwd === 'function' ? process.cwd() : undefined;

    const hook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): Promise<{ additionalContext?: string | undefined } | void> => {
      if (cfg.mode === 'off') return;

      // Skip if the tool errored — no point summarizing a failed write.
      if (input.toolResult?.isError) return;

      const toolName = input.toolName ?? '';
      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const rawPath =
        inp['path'] ??
        inp['filePath'] ??
        inp['file_path'] ??
        inp['TargetFile'] ??
        inp['targetFile'] ??
        inp['file'];
      const filePath = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : undefined;
      if (!filePath || typeof filePath !== 'string') return;

      state.invocationCount += 1;

      // Sandbox: refuse to diff a file outside the project root. Without
      // this a prompt-injected write with an absolute host path could
      // stream host-fs content into the LLM context.
      if (!withinProject(filePath)) {
        state.fallbackCount += 1;
        return;
      }

      // Per-path throttle + content-hash dedupe. These two cheap
      // checks skip the expensive `git diff` invocation when the
      // model just retried the same edit (or hammered the same path
      // in quick succession). They run AFTER the sandbox check so
      // hostile paths are still refused; they run BEFORE `git diff`
      // so we save the subprocess spawn.
      const oldStr = String(inp['old_string'] ?? inp['TargetContent'] ?? inp['oldContent'] ?? '');
      const newStr = String(
        inp['new_string'] ?? inp['ReplacementContent'] ?? inp['newContent'] ?? '',
      );
      const contentStr = String(
        inp['content'] ??
          inp['CodeContent'] ??
          inp['code'] ??
          inp['text'] ??
          inp['contents'] ??
          inp['body'] ??
          '',
      );
      // Three-way shape: hash old/new when EITHER is present, else the
      // write-content. (Gating the old/new branch on `toolName === 'edit'`
      // collapsed every edit that populates other field aliases to the
      // constant `:::` fingerprint, defeating the dedupe for distinct edits.)
      const toolInputForHash = oldStr || newStr ? `${oldStr}:::${newStr}` : contentStr;
      const now = Date.now();
      const memo = pathMemo.get(filePath);
      if (memo) {
        if (cfg.minIntervalMs > 0 && now - memo.lastInjectedAt < cfg.minIntervalMs) {
          state.throttledCount = (state.throttledCount ?? 0) + 1;
          api.metrics.counter('throttled');
          return;
        }
        if (
          cfg.enableContentHashCache &&
          typeof toolInputForHash === 'string' &&
          contentHash(toolInputForHash) === memo.hash
        ) {
          state.duplicateContentCount = (state.duplicateContentCount ?? 0) + 1;
          api.metrics.counter('duplicate_content');
          return;
        }
      }

      const result = await getGitDiff(filePath, cfg.includeContext, cwd);
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

      // Record the content hash + injection time so the next call to
      // this path can be deduped / throttled without another `git diff`.
      if (cfg.enableContentHashCache && typeof toolInputForHash === 'string') {
        pathMemo.set(filePath, {
          hash: contentHash(toolInputForHash),
          lastInjectedAt: now,
        });
      } else if (cfg.minIntervalMs > 0) {
        // Even if content caching is off, keep the throttle memo.
        pathMemo.set(filePath, {
          hash: 0,
          lastInjectedAt: now,
        });
      }

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

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, {
      background: true,
    });

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
          minIntervalMs: cfg.minIntervalMs,
          enableContentHashCache: cfg.enableContentHashCache,
          counters: {
            invocations: state.invocationCount,
            injected: state.injectedCount,
            fallbacks: state.fallbackCount,
            throttled: state.throttledCount,
            duplicateContent: state.duplicateContentCount,
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
      throttled: state.throttledCount,
      duplicateContent: state.duplicateContentCount,
    };
    state.invocationCount = 0;
    state.injectedCount = 0;
    state.fallbackCount = 0;
    state.throttledCount = 0;
    state.duplicateContentCount = 0;
    state.lastSummary = null;
    pathMemo.clear();
    api.log.info('diff-summary: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message:
        state.lastSummary === null
          ? `diff-summary: ${state.invocationCount} invocation(s), ${state.injectedCount} injected, ${state.throttledCount} throttled, ${state.duplicateContentCount} dup-content`
          : `diff-summary: last ${state.lastSummary.tool} on ${state.lastSummary.path} (+${state.lastSummary.added} -${state.lastSummary.removed}) at ${state.lastSummary.when}`,
      counters: {
        invocations: state.invocationCount,
        injected: state.injectedCount,
        fallbacks: state.fallbackCount,
        throttled: state.throttledCount,
        duplicateContent: state.duplicateContentCount,
      },
      lastSummary: state.lastSummary,
    };
  },
};

export default plugin;
