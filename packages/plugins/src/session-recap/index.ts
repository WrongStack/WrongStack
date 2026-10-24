/**
 * session-recap plugin — Stop hook that posts a one-page summary
 * of the session to the project mailbox when the agent loop ends.
 *
 * As the session runs, the plugin accumulates lightweight metrics
 * from the agent's EventBus:
 *
 *  - Total input/output tokens (per model)
 *  - Tool-call counts (per tool name)
 *  - Git commits made during the session
 *  - Elapsed wall-clock time
 *
 * On `Stop`, the hook reads `api.session.transcriptPath` (the JSONL
 * session log) for any extra detail the metrics stream didn't catch
 * — last user prompt, last assistant output, final todo state —
 * then composes a compact summary and posts it to `api.mailbox.send`
 * with `type: 'status'` and a high-signal subject.
 *
 * Use cases:
 *  - End-of-day handoff — a second agent opens the mailbox and
 *    sees what the previous session finished
 *  - Audit — every session leaves a breadcrumb
 *  - Shadow agents can monitor the recap stream for anomalies
 *
 * Config (`config.extensions['session-recap']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "subjectPrefix": "session recap: ",
 *   "includeTranscriptTail": 3,
 *   "maxBodyChars": 8000
 * }
 * ```
 *
 * Host requirements:
 * - Requires `api.mailbox` (added in commit 31dde5ba). When absent
 *   the hook logs a one-shot warn and silently no-ops.
 * - Requires `api.session.transcriptPath` to read the JSONL.
 *   Minimal hosts without a session writer skip the transcript tail
 *   but still post the metrics summary.
 *
 * @public
 */
import type { HookInvocationContext, Plugin } from '@wrongstack/contracts/types';
import { releaseHandle } from '../runtime/index.js';
import { formatDuration, topN, truncate } from './recap-format.js';
import { readTranscriptTail } from './transcript-tail.js';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  invocations: number;
}

interface RecapState {
  /** Whether we've ever published a recap for this setup(). */
  recapsPublished: number;
  /** Whether we've ever errored on publish. */
  recapsErrored: number;
  /** Whether we've skipped (mailbox undefined, no data, etc.). */
  recapsSkipped: number;
  /** Natural-language summaries written by the LLM. */
  aiSummariesWritten: number;
  /** LLM summary attempts that failed (recap still posted). */
  aiSummaryErrors: number;
  /** Stop-hook invocations. */
  stopInvocations: number;
  /** Total tokens across all models. */
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Per-model breakdown. */
  perModel: Map<string, ModelUsage>;
  /** Tool-call counts keyed by tool name. */
  toolCounts: Map<string, number>;
  /** Git commits observed (via the `git_autocommit` tool). */
  commitCount: number;
  /** First activity timestamp (ISO 8601). */
  startedAt: string | null;
  /** Last activity timestamp (ISO 8601). */
  lastActivityAt: string | null;
  /** Hook handle for teardown. */
  stopHookUnregister: null | (() => void);
  /** Event listener unsubscribers. */
  eventUnsubscribers: Array<() => void>;
  /**
   * git_autocommit tool-use ids seen via `tool.started`, mapped to whether
   * the call was a dry_run preview. `tool.completed` carries neither the
   * tool input nor its return content, so started/completed are correlated
   * by id: only a non-dry-run completion created a commit. Entries are
   * removed on completed/failed, so the map stays tiny.
   */
  gitAutocommitDryRuns: Map<string, boolean>;
}

const state: RecapState = {
  recapsPublished: 0,
  recapsErrored: 0,
  recapsSkipped: 0,
  aiSummariesWritten: 0,
  aiSummaryErrors: 0,
  stopInvocations: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  perModel: new Map(),
  toolCounts: new Map(),
  commitCount: 0,
  startedAt: null,
  lastActivityAt: null,
  stopHookUnregister: null,
  eventUnsubscribers: [],
  gitAutocommitDryRuns: new Map(),
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface SessionRecapConfig {
  enabled: boolean;
  /** Prepended to the broadcast `subject` (mailbox reads this in the inbox). */
  subjectPrefix: string;
  /** Number of last transcript events to include in the recap body. */
  includeTranscriptTail: number;
  /** Hard cap on the recap body size (chars). Default 8 KB. */
  maxBodyChars: number;
  /**
   * When true and `api.llm` is wired, a natural-language summary of the
   * session is written by the LLM and prepended to the recap body.
   * Best-effort — a failure leaves the metrics-only recap intact.
   */
  aiSummary: boolean;
}

const DEFAULTS: SessionRecapConfig = {
  enabled: true,
  subjectPrefix: 'session recap: ',
  includeTranscriptTail: 3,
  maxBodyChars: 8_000,
  aiSummary: false,
};

export function readConfig(raw: unknown): SessionRecapConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const rawPrefix = r['subjectPrefix'] ?? r['subject_prefix'] ?? r['prefix'];
  const rawTail =
    r['includeTranscriptTail'] ??
    r['include_transcript_tail'] ??
    r['transcriptTail'] ??
    r['transcript_tail'];
  const rawBody = r['maxBodyChars'] ?? r['max_body_chars'] ?? r['maxChars'] ?? r['max_chars'];
  const rawAi = r['aiSummary'] ?? r['ai_summary'] ?? r['useLlm'] ?? r['use_llm'];
  return {
    enabled: r['enabled'] !== false,
    subjectPrefix: typeof rawPrefix === 'string' ? rawPrefix : DEFAULTS.subjectPrefix,
    includeTranscriptTail:
      typeof rawTail === 'number' && rawTail >= 0 ? rawTail : DEFAULTS.includeTranscriptTail,
    maxBodyChars: typeof rawBody === 'number' && rawBody > 0 ? rawBody : DEFAULTS.maxBodyChars,
    aiSummary: rawAi === true,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function touchActivity(): void {
  const now = new Date().toISOString();
  if (state.startedAt === null) state.startedAt = now;
  state.lastActivityAt = now;
}

function bumpModelUsage(model: string, inputTokens: number, outputTokens: number): void {
  let m = state.perModel.get(model);
  if (!m) {
    m = { inputTokens: 0, outputTokens: 0, invocations: 0 };
    state.perModel.set(model, m);
  }
  m.inputTokens += inputTokens;
  m.outputTokens += outputTokens;
  m.invocations += 1;
  state.totalInputTokens += inputTokens;
  state.totalOutputTokens += outputTokens;
}

/**
 * Provider usage is an untrusted response boundary. `typeof === 'number'`
 * accepts NaN/Infinity, and one non-finite response poisons every later
 * total (`NaN + finite === NaN`) — the mailbox recap subject then reports
 * "NaN tokens" for the rest of the session. Same invariant as token-budget /
 * token-throttle / cost-tracker: non-finite numeric input normalizes to 0.
 */
function toFiniteUsage(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function bumpToolCount(name: string): void {
  state.toolCounts.set(name, (state.toolCounts.get(name) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'session-recap',
  version: '0.1.0',
  description:
    'Stop hook that posts a one-page session summary (tokens, tools, commits, last activity) to the project mailbox',
  apiVersion: '^0.1.10',
  capabilities: { tools: true, hooks: true, llm: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      subjectPrefix: {
        type: 'string',
        default: DEFAULTS.subjectPrefix,
        description: 'Prepended to the broadcast subject.',
      },
      includeTranscriptTail: {
        type: 'number',
        minimum: 0,
        maximum: 50,
        default: 3,
        description: 'Number of last transcript events to include in the recap body.',
      },
      maxBodyChars: {
        type: 'number',
        minimum: 500,
        default: 8_000,
        description: 'Hard cap on the recap body size (chars).',
      },
      aiSummary: {
        type: 'boolean',
        default: false,
        description:
          'Prepend an LLM-written natural-language summary (api.llm) to the recap. Provider/model follow extensions["session-recap"].llm, then the session default.',
      },
      llm: {
        type: 'object',
        description: 'Optional { provider, model } override for the AI summary.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.recapsPublished = 0;
    state.recapsErrored = 0;
    state.recapsSkipped = 0;
    state.aiSummariesWritten = 0;
    state.aiSummaryErrors = 0;
    state.stopInvocations = 0;
    state.totalInputTokens = 0;
    state.totalOutputTokens = 0;
    state.perModel.clear();
    state.toolCounts.clear();
    state.gitAutocommitDryRuns.clear();
    state.commitCount = 0;
    state.startedAt = null;
    state.lastActivityAt = null;
    state.stopHookUnregister = releaseHandle(state.stopHookUnregister);
    for (const off of state.eventUnsubscribers) {
      try {
        off();
      } catch {
        // best-effort
      }
    }
    state.eventUnsubscribers = [];

    const cfg = readConfig(api.config.extensions?.['session-recap']);
    const mailbox = api.mailbox;

    // ── Subscribe to live events to accumulate metrics ─────────────────
    if (api.onEvent) {
      // Token usage — fires on every provider response.
      const offUsage = api.onEvent('provider.response', (payload: unknown) => {
        touchActivity();
        const p = payload as {
          model?: string;
          usage?: Record<string, unknown>;
        } | null;
        const model = p?.model ?? 'unknown';
        const u = p?.usage;
        const input = toFiniteUsage(
          typeof u?.['input'] === 'number'
            ? u['input']
            : typeof u?.['inputTokens'] === 'number'
              ? u['inputTokens']
              : typeof u?.['promptTokens'] === 'number'
                ? u['promptTokens']
                : typeof u?.['prompt_tokens'] === 'number'
                  ? u['prompt_tokens']
                  : 0,
        );
        const output = toFiniteUsage(
          typeof u?.['output'] === 'number'
            ? u['output']
            : typeof u?.['outputTokens'] === 'number'
              ? u['outputTokens']
              : typeof u?.['completionTokens'] === 'number'
                ? u['completionTokens']
                : typeof u?.['completion_tokens'] === 'number'
                  ? u['completion_tokens']
                  : 0,
        );
        bumpModelUsage(model, input, output);
      });
      state.eventUnsubscribers.push(offUsage);
    }

    if (api.onPattern) {
      // Tool-call counts — fires on every tool invocation across the
      // event bus. We use a wildcard pattern to catch all tool events.
      const offTool = api.onPattern('tool.*', (eventName: string, payload: unknown) => {
        touchActivity();
        // eventName is `tool.started`, `tool.completed`, etc. `tool` is
        // the tool NAME on some events and the whole `Tool` object on
        // others (`tool.confirm_needed`), so read `.name` off an object.
        const p = payload as {
          tool?: unknown;
          name?: unknown;
          id?: unknown;
          input?: unknown;
        } | null;
        const rawTool = p?.tool;
        const nameOf = (v: unknown): string | undefined =>
          typeof v === 'string'
            ? v
            : v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string'
              ? (v as { name: string }).name
              : undefined;
        const toolName = nameOf(rawTool) ?? nameOf(p?.name) ?? eventName;
        // Count each INVOCATION once: a single call emits tool.started +
        // progress×N + completed + executed, and non-call events
        // (tool.confirm_resolved, tool.loop_detected) also match this
        // wildcard — bumping on every event inflated the recap's
        // "N tool calls" several-fold and polluted uniqueTools with
        // event-name phantoms. tool.started fires exactly once per
        // invocation attempt.
        if (eventName === 'tool.started') bumpToolCount(toolName);
        // Commit tracking. Core emits `tool.started` / `tool.completed` /
        // `tool.failed` — there is no `tool.result` event (the previous
        // subscription here could never fire, so commits were never
        // counted). `tool.completed` carries neither the tool input nor
        // its return content, so git_autocommit calls are correlated by
        // tool-use id against `tool.started`, whose payload carries the
        // raw input: a dry_run preview completes successfully without
        // creating a commit, and only a non-dry-run completion counts.
        if (toolName === 'git_autocommit' && p !== null) {
          const id = typeof p.id === 'string' ? p.id : null;
          if (id !== null) {
            if (eventName === 'tool.started') {
              const ti = (p.input ?? {}) as Record<string, unknown>;
              state.gitAutocommitDryRuns.set(id, ti['dry_run'] === true || ti['dryRun'] === true);
            } else if (eventName === 'tool.completed') {
              if (state.gitAutocommitDryRuns.get(id) === false) state.commitCount += 1;
              state.gitAutocommitDryRuns.delete(id);
            } else if (eventName === 'tool.failed') {
              state.gitAutocommitDryRuns.delete(id);
            }
          }
        }
      });
      state.eventUnsubscribers.push(offTool);
    }

    // ── Register the Stop hook ────────────────────────────────────────
    const stopHook = async (
      input: {
        cwd?: string | undefined;
        sessionId?: string | undefined;
      },
      hookContext?: HookInvocationContext,
    ): Promise<void> => {
      if (!cfg.enabled) return;
      touchActivity();
      state.stopInvocations += 1;

      if (!mailbox) {
        state.recapsSkipped += 1;
        api.log.warn(
          'session-recap: no mailbox available on api — recap disabled. ' +
            'Add `mailbox` to the setupPlugins() call to enable cross-session summaries.',
        );
        return;
      }

      // Read tail of the transcript for context.
      const transcriptPath = api.session?.transcriptPath;
      const tailEvents = await readTranscriptTail(transcriptPath, cfg.includeTranscriptTail);

      const duration = formatDuration(state.startedAt, state.lastActivityAt);

      const rawInput = (input ?? {}) as Record<string, unknown>;
      const sessionId =
        (typeof input.sessionId === 'string' ? input.sessionId : undefined) ??
        (typeof rawInput['session_id'] === 'string' ? rawInput['session_id'] : undefined) ??
        (typeof rawInput['id'] === 'string' ? rawInput['id'] : undefined) ??
        null;
      const cwd =
        (typeof input.cwd === 'string' ? input.cwd : undefined) ??
        (typeof rawInput['workingDirectory'] === 'string'
          ? rawInput['workingDirectory']
          : undefined) ??
        (typeof rawInput['dir'] === 'string' ? rawInput['dir'] : undefined) ??
        null;

      const recap: {
        session: {
          id: string | null;
          cwd: string | null;
          startedAt: string | null;
          endedAt: string | null;
          duration: string;
        };
        tokens: {
          total: { input: number; output: number };
          perModel: Array<{ model: string; input: number; output: number; invocations: number }>;
        };
        tools: {
          totalCalls: number;
          uniqueTools: number;
          top: Array<[string, number]>;
        };
        commits: number;
        transcriptTail: Array<{ type?: string; ts?: string; role?: string; preview?: string }>;
      } = {
        session: {
          id: sessionId,
          cwd,
          startedAt: state.startedAt,
          endedAt: state.lastActivityAt,
          duration,
        },
        tokens: {
          total: { input: state.totalInputTokens, output: state.totalOutputTokens },
          perModel: topN(state.perModel, 10).map(([model, u]) => ({
            model,
            input: u.inputTokens,
            output: u.outputTokens,
            invocations: u.invocations,
          })),
        },
        tools: {
          totalCalls: [...state.toolCounts.values()].reduce((a, b) => a + b, 0),
          uniqueTools: state.toolCounts.size,
          top: topN(state.toolCounts, 5),
        },
        commits: state.commitCount,
        transcriptTail: tailEvents.flatMap((e) => {
          const entry: { type?: string; ts?: string; role?: string; preview?: string } = {};
          if (e.type !== undefined) entry.type = e.type;
          if (e.ts !== undefined) entry.ts = e.ts;
          if (e.role !== undefined) entry.role = e.role;
          if (typeof e.content === 'string') entry.preview = e.content.slice(0, 200);
          return [entry];
        }),
      };

      const subject =
        `${cfg.subjectPrefix}${recap.session.id ?? 'session'} — ${duration}, ${recap.tools.totalCalls} tool calls, ${recap.tokens.total.input + recap.tokens.total.output} tokens`.slice(
          0,
          200,
        );

      // Optional natural-language summary from the LLM (best-effort). The
      // metrics-only recap is always posted; the prose is a bonus prepended
      // to the body when it succeeds.
      let aiSummary: string | null = null;
      if (cfg.aiSummary && api.llm) {
        try {
          const topTools = recap.tools.top.map(([n, c]) => `${n}×${c}`).join(', ') || 'none';
          const result = await api.llm.complete(
            'Summarize this coding-agent session in 2-3 sentences for a teammate catching up. ' +
              'Focus on what was worked on and the scale of activity. Be concrete and terse.\n\n' +
              `Duration: ${duration}\n` +
              `Tool calls: ${recap.tools.totalCalls} (top: ${topTools})\n` +
              `Commits: ${recap.commits}\n` +
              `Tokens: ${recap.tokens.total.input} in / ${recap.tokens.total.output} out\n` +
              (recap.transcriptTail.length > 0
                ? `Recent activity: ${recap.transcriptTail
                    .map((e) => e.preview ?? e.type ?? '')
                    .filter(Boolean)
                    .join(' | ')
                    .slice(0, 500)}`
                : ''),
            {
              system: 'You write concise engineering session recaps.',
              role: 'document',
              timeoutMs: 3000,
              signal: hookContext?.signal,
            },
          );
          if (hookContext?.signal.aborted) return;
          const text = result.text.trim();
          if (text) {
            aiSummary = text;
            state.aiSummariesWritten += 1;
          }
        } catch {
          state.aiSummaryErrors += 1;
        }
      }

      const recapWithSummary = aiSummary ? { summary: aiSummary, ...recap } : recap;
      const bodyPrefix = aiSummary ? `${aiSummary}\n\n---\n` : '';
      const body = truncate(
        bodyPrefix + JSON.stringify(recapWithSummary, null, 2),
        cfg.maxBodyChars,
      );

      if (hookContext?.signal.aborted) return;

      try {
        const result = (await mailbox.send({
          from: 'plugin:session-recap',
          to: '*',
          type: 'status',
          subject,
          body,
          priority: 'low',
        })) as { id?: string };
        state.recapsPublished += 1;
        api.log.info('session-recap: published session summary', {
          messageId: result.id ?? null,
          duration,
          toolCalls: recap.tools.totalCalls,
          tokensIn: recap.tokens.total.input,
          tokensOut: recap.tokens.total.output,
        });
      } catch (err) {
        state.recapsErrored += 1;
        api.log.warn('session-recap: mailbox.send failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    state.stopHookUnregister = api.registerHook('Stop', undefined, stopHook as never);

    // ── session_recap_status tool ─────────────────────────────────────
    api.tools.register({
      name: 'session_recap_status',
      description:
        'Reports session-recap state: config, accumulated metrics (tokens, tool calls, commits), and last recap status.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          subjectPrefix: cfg.subjectPrefix,
          includeTranscriptTail: cfg.includeTranscriptTail,
          maxBodyChars: cfg.maxBodyChars,
          mailboxAvailable: Boolean(mailbox),
          aiSummary: cfg.aiSummary,
          llmAvailable: Boolean(api.llm),
          counters: {
            stopInvocations: state.stopInvocations,
            recapsPublished: state.recapsPublished,
            recapsErrored: state.recapsErrored,
            recapsSkipped: state.recapsSkipped,
            aiSummariesWritten: state.aiSummariesWritten,
            aiSummaryErrors: state.aiSummaryErrors,
          },
          metrics: {
            totalInputTokens: state.totalInputTokens,
            totalOutputTokens: state.totalOutputTokens,
            perModel: topN(state.perModel, 10).map(([model, u]) => ({
              model,
              input: u.inputTokens,
              output: u.outputTokens,
              invocations: u.invocations,
            })),
            toolCalls: {
              total: [...state.toolCounts.values()].reduce((a, b) => a + b, 0),
              uniqueTools: state.toolCounts.size,
              top: topN(state.toolCounts, 5),
            },
            commits: state.commitCount,
          },
          timing: {
            startedAt: state.startedAt,
            lastActivityAt: state.lastActivityAt,
            duration: formatDuration(state.startedAt, state.lastActivityAt),
          },
        };
      },
    });

    api.log.info('session-recap plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      mailboxAvailable: Boolean(mailbox),
    });
  },

  teardown(api) {
    if (state.stopHookUnregister) {
      try {
        state.stopHookUnregister();
      } catch {
        // best-effort
      }
      state.stopHookUnregister = null;
    }
    for (const off of state.eventUnsubscribers) {
      try {
        off();
      } catch {
        // best-effort
      }
    }
    state.eventUnsubscribers = [];
    state.gitAutocommitDryRuns.clear();
    const final = {
      recapsPublished: state.recapsPublished,
      recapsErrored: state.recapsErrored,
      recapsSkipped: state.recapsSkipped,
      aiSummariesWritten: state.aiSummariesWritten,
      totalInputTokens: state.totalInputTokens,
      totalOutputTokens: state.totalOutputTokens,
      toolCalls: [...state.toolCounts.values()].reduce((a, b) => a + b, 0),
      commits: state.commitCount,
    };
    state.recapsPublished = 0;
    state.recapsErrored = 0;
    state.recapsSkipped = 0;
    state.aiSummariesWritten = 0;
    state.aiSummaryErrors = 0;
    state.stopInvocations = 0;
    state.totalInputTokens = 0;
    state.totalOutputTokens = 0;
    state.perModel.clear();
    state.toolCounts.clear();
    state.commitCount = 0;
    state.startedAt = null;
    state.lastActivityAt = null;
    api.log.info('session-recap: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: `session-recap: ${state.stopInvocations} stop(s), ${state.recapsPublished} recap(s) published (${state.aiSummariesWritten} with AI summary), ${state.recapsErrored} error(s), ${state.totalInputTokens + state.totalOutputTokens} tokens observed`,
      counters: {
        stopInvocations: state.stopInvocations,
        recapsPublished: state.recapsPublished,
        recapsErrored: state.recapsErrored,
        recapsSkipped: state.recapsSkipped,
        aiSummariesWritten: state.aiSummariesWritten,
        aiSummaryErrors: state.aiSummaryErrors,
      },
      metrics: {
        totalInputTokens: state.totalInputTokens,
        totalOutputTokens: state.totalOutputTokens,
        toolCalls: [...state.toolCounts.values()].reduce((a, b) => a + b, 0),
        commits: state.commitCount,
      },
    };
  },
};

export default plugin;
