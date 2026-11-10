/**
 * ACPServerAgentTurn — `RunTurn` adapter for the v1 server side.
 *
 * Wires the ACP v1 server (`ACPProtocolHandler`) to a core `Agent`.
 * Each session gets its own `Agent` instance (per spec: sessions are
 * isolated; sharing agents across sessions would defeat isolation).
 * The agent is created lazily on the first `session/prompt` and
 * torn down when the server is closed or the session is removed.
 *
 * The adapter:
 *  - converts the ACP `ContentBlock[]` prompt into a single string
 *    (concatenating text blocks; non-text blocks are recorded as a
 *    note in the prompt — future work can route images / audio to
 *    the appropriate provider)
 *  - calls `agent.run(prompt, {signal})` to drive the core loop
 *  - captures the agent's text result and emits it as one or more
 *    `agent_message_chunk` notifications
 *  - maps the agent's stop semantics to a v1 `StopReason`
 *
 * Streaming: the core `Agent` API is not currently token-streamed
 * through this surface (its `run()` returns a final `RunResult`).
 * v1 clients expect text deltas, but most implementations batch
 * them — a single chunk per turn is acceptable. A future
 * enhancement can use the Agent's `Renderer` interface to capture
 * deltas as they're written, then forward them as multiple chunks.
 *
 * Scope: the adapter is deliberately minimal. It does NOT:
 *  - model the full conversation history across turns (the v1 spec
 *    leaves this to the agent; on the next prompt we re-feed the
 *    latest user message and the agent handles its own history)
 *  - use the agent's tool registry, permission policy, or
 *    extensions (this adapter is the lowest-fidelity integration;
 *    a future PR can wire a richer session-aware agent)
 *  - stream deltas token-by-token (see "Streaming" above)
 *
 * Cancellation: the parent `AbortSignal` propagates through
 * `agent.run({signal})` and the underlying provider call observes
 * it. On abort, the adapter maps the resulting `AbortError` to
 * `{stopReason: 'cancelled'}`.
 *
 * Background delegations: a background `delegate` result is queued for the
 * session's leader and injected by the core agent loop at its next iteration
 * boundary — on ACP that is the next `session/prompt`, because ACP never
 * starts a turn on its own. So the client is not left guessing, the adapter
 * listens for `leader.delivery_pending` on the session agent's event bus and,
 * while no turn is running, sends one coalesced unprompted `session/update`
 * ("Background delegation <id> finished; send any message to continue.")
 * through `RunTurnApi.sendSessionUpdate`. Nothing is sent after the session is
 * disposed, and a notice failure never reaches the event bus.
 */
import type { Agent } from '@wrongstack/core/agent';
import type { McpServer } from '../types/acp-v1.js';
import type { RunTurn, RunTurnApi, RunTurnResult } from './protocol-handler.js';
import { type RunPromptCommand, runPromptCommand } from './server-agent-commands.js';
import {
  extractPlan,
  extractRunError,
  extractText,
  extractUsage,
  isRecord,
  pickStopReason,
  promptToAgentInput,
  promptToText,
  seedAgentContext,
  toolNameToKind,
  toolTitle,
} from './server-agent-turn-content.js';
export interface ACPServerAgentTurnOptions {
  /**
   * Factory that creates a fresh `Agent` for a given session.
   * Called once per session on the first `session/prompt` turn.
   * The factory must isolate each agent — sharing one agent
   * across sessions would defeat v1's session-isolation model.
   *
   * `api` (when provided) is the client-callback surface: ask the client
   * for permission, and use the client's filesystem/terminal when it
   * advertises those capabilities. A factory that wires it builds a
   * client-backed permission policy and ACP-backed fs/terminal tools
   * instead of silently auto-approving against the local disk.
   *
   * `mcpServers` is the client's per-session MCP server list from
   * `session/new`. The factory owns the session's tool registry, so it is the
   * only place those servers can be connected and their tools registered.
   */
  agentFor: (
    sessionId: string,
    cwd: string,
    api?: RunTurnApi,
    mcpServers?: readonly McpServer[],
  ) => Promise<Agent> | Agent;
  /**
   * Apply the session's current config selections (e.g. the chosen model) to
   * its agent. Runs before every turn, after the agent is built, with the
   * values `session/set_config_option` last stored. A throw fails the turn
   * with its message rather than silently running on the previous settings.
   */
  applyConfigOptions?:
    | ((
        agent: Agent,
        configOptions: NonNullable<Parameters<RunTurn>[0]['configOptions']>,
        sessionId: string,
      ) => Promise<void> | void)
    | undefined;
  /**
   * Hard wall-clock cap for one turn. The agent's own provider
   * timeout is layered under this; this cap is a safety belt.
   * Default 5 minutes.
   */
  timeoutMs?: number | undefined;
  /**
   * The session's slash commands (`ProtocolHandlerOptions.sessionCommands`
   * advertises them): a prompt naming one runs it instead of a model turn.
   */
  runCommand?: RunPromptCommand | undefined;
  /** Maximum replay entries retained per session. Default 1000. */
  maxHistoryEntries?: number | undefined;
  /** Maximum serialized replay bytes retained per session. Default 8 MiB. */
  maxHistoryBytes?: number | undefined;
  /**
   * Coalescing window for the unprompted "background delegation finished"
   * notice. Deliveries announced within it share one notice. Default 1500 ms.
   */
  deliveryNoticeDebounceMs?: number | undefined;
  /**
   * Live count of results still queued for the session's leader (the host
   * wires the core leader-delivery hub here). When provided, a notice is sent
   * only while something is actually still pending — so a result the agent
   * loop already drained mid-turn is never announced. When omitted, results
   * announced during a running turn are assumed drained by that turn.
   */
  pendingDeliveries?: ((sessionId: string) => number) | undefined;
}

/** Per-session state for the unprompted background-delegation notice. */
interface DeliveryNotifier {
  /** Latest turn's client API — its `sendSessionUpdate` outlives the turn. */
  api: RunTurnApi | undefined;
  /** Delivery ids announced as pending and not yet noticed. */
  pending: Set<string>;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  unsubscribe: Array<() => void>;
}

/** A recorded conversation turn, replayable on `session/load`. */
interface SessionReplayUpdate {
  sessionUpdate: 'user_message_chunk' | 'agent_message_chunk';
  content: { type: 'text'; text: string };
}

/**
 * A `RunTurn` that also exposes the recorded per-session history so the
 * server can replay it on `session/load`.
 */
interface ACPServerAgentTurn {
  (
    input: Parameters<RunTurn>[0],
    emit: Parameters<RunTurn>[1],
    api?: Parameters<RunTurn>[2],
  ): Promise<RunTurnResult>;
  /** Recorded user/agent text turns for a session, in order. */
  replay(sessionId: string): SessionReplayUpdate[];
  /**
   * Seed a session's history (from a durable store on cold `session/load`)
   * so `replay()` returns it AND the next-created `Agent` for the session is
   * primed with the prior conversation as model context — not just the
   * client UI. Call before the first post-load `session/prompt`.
   */
  seed(
    sessionId: string,
    history: ReadonlyArray<{ sessionUpdate: string; content: unknown }>,
  ): void;
  /** Drop the session's Agent, timers, seed marker, and in-memory replay history. */
  dispose(sessionId: string): void;
}

/**
 * Build a `RunTurn` that owns per-session `Agent` instances and
 * delegates each turn to the appropriate agent. The returned
 * function is reusable across sessions — the agents are kept in a
 * Map keyed by `sessionId`. It also records each turn's user/agent
 * text so the server can replay history on `session/load` (see
 * `.replay(sessionId)`).
 */
export function makeACPServerAgentTurn(opts: ACPServerAgentTurnOptions): ACPServerAgentTurn {
  const agents = new Map<string, Agent>();
  const timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  const history = new Map<string, SessionReplayUpdate[]>();
  const historyBytes = new Map<string, number>();
  // Sessions restored from a durable store whose freshly-created Agent must
  // be primed with the prior conversation before its first turn runs.
  const pendingSeed = new Set<string>();
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const maxHistoryEntries = finitePositiveLimit(opts.maxHistoryEntries, 1_000);
  const maxHistoryBytes = finitePositiveLimit(opts.maxHistoryBytes, 8 * 1024 * 1024);
  const deliveryNoticeDebounceMs = finiteNonNegativeLimit(opts.deliveryNoticeDebounceMs, 1_500);
  const notifiers = new Map<string, DeliveryNotifier>();
  // The turn in flight per session. dispose() drops it, so a turn can tell
  // its session was closed or deleted while it awaited the agent or the run.
  const liveTurns = new Map<string, symbol>();

  const stillPending = (sessionId: string): boolean => {
    if (!opts.pendingDeliveries) return true;
    try {
      return opts.pendingDeliveries(sessionId) > 0;
    } catch {
      return false;
    }
  };

  const flushDeliveryNotice = async (sessionId: string, state: DeliveryNotifier): Promise<void> => {
    // Disposed, a turn started meanwhile (its loop injects the results), or
    // nothing left to announce.
    if (notifiers.get(sessionId) !== state || state.running || state.pending.size === 0) return;
    const api = state.api;
    if (!api?.sendSessionUpdate) return;
    const ids = [...state.pending];
    state.pending.clear();
    if (!stillPending(sessionId)) return;
    try {
      await api.sendSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: deliveryNoticeText(ids) },
      });
    } catch {
      // Best-effort: the result itself stays queued for the next prompt.
    }
  };

  const scheduleDeliveryNotice = (sessionId: string): void => {
    const state = notifiers.get(sessionId);
    if (!state || state.running || state.pending.size === 0 || state.timer) return;
    // Not re-armed per event: a steady stream of results still yields a notice
    // within one window instead of being postponed indefinitely.
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void flushDeliveryNotice(sessionId, state);
    }, deliveryNoticeDebounceMs);
    state.timer.unref?.();
  };

  const attachDeliveryNotifier = (
    sessionId: string,
    agent: Agent,
  ): DeliveryNotifier | undefined => {
    const existing = notifiers.get(sessionId);
    if (existing) return existing;
    const bus = (agent as { events?: { on?: typeof agent.events.on } }).events;
    if (!bus?.on) return undefined;
    const state: DeliveryNotifier = {
      api: undefined,
      pending: new Set(),
      running: false,
      timer: undefined,
      unsubscribe: [],
    };
    notifiers.set(sessionId, state);
    const owns = (eventSessionId: unknown): boolean =>
      agentOwnsSession(agent, sessionId, eventSessionId);
    state.unsubscribe.push(
      bus.on('leader.delivery_pending', (e) => {
        try {
          if (notifiers.get(sessionId) !== state || !owns(e?.sessionId)) return;
          for (const id of Array.isArray(e.deliveryIds) ? e.deliveryIds : []) {
            if (typeof id === 'string' && id.length > 0) state.pending.add(id);
          }
          scheduleDeliveryNotice(sessionId);
        } catch {
          // A notice must never break the event bus.
        }
      }),
      bus.on('delegation.delivered', (e) => {
        try {
          if (!owns(e?.sessionId) || typeof e.delegationId !== 'string') return;
          state.pending.delete(e.delegationId);
          state.pending.delete(`${DELEGATION_DELIVERY_PREFIX}${e.delegationId}`);
        } catch {
          // A notice must never break the event bus.
        }
      }),
    );
    return state;
  };

  /** Keep one exchange for `session/load` replay, within the per-session caps. */
  const recordExchange = (sessionId: string, userText: string, text: string): void => {
    const hist = history.get(sessionId) ?? [];
    let retainedHistoryBytes = historyBytes.get(sessionId) ?? 0;
    for (const [sessionUpdate, chunk] of [
      ['user_message_chunk', userText],
      ['agent_message_chunk', text],
    ] as const) {
      if (!chunk) continue;
      const update: SessionReplayUpdate = { sessionUpdate, content: { type: 'text', text: chunk } };
      hist.push(update);
      retainedHistoryBytes += replayEntryBytes(update);
    }
    retainedHistoryBytes = trimHistory(
      hist,
      retainedHistoryBytes,
      maxHistoryEntries,
      maxHistoryBytes,
    );
    if (hist.length > 0) {
      history.set(sessionId, hist);
      historyBytes.set(sessionId, retainedHistoryBytes);
    } else {
      history.delete(sessionId);
      historyBytes.delete(sessionId);
    }
  };

  const turn = async (
    input: Parameters<RunTurn>[0],
    publish: Parameters<RunTurn>[1],
    api?: Parameters<RunTurn>[2],
  ): Promise<RunTurnResult> => {
    const token = Symbol(input.sessionId);
    liveTurns.set(input.sessionId, token);
    const alive = (): boolean => liveTurns.get(input.sessionId) === token;
    const emit: Parameters<RunTurn>[1] = (update) => {
      if (alive()) publish(update);
    };
    // Lazily create an agent for this session on the first turn.
    let agent = agents.get(input.sessionId);
    if (!agent) {
      agent = await opts.agentFor(
        input.sessionId,
        input.cwd ?? process.cwd(),
        api,
        input.mcpServers,
      );
      if (!alive()) {
        // Disposed while the agent was being built: nothing else owns it.
        const stale = agent;
        void Promise.resolve()
          .then(() => stale.teardown?.())
          .catch(() => {});
        return { stopReason: 'cancelled' };
      }
      agents.set(input.sessionId, agent);
    }
    // Cold-load priming: re-feed the restored conversation into the
    // agent's context so the MODEL resumes (not just the client UI).
    if (pendingSeed.delete(input.sessionId)) {
      const prior = history.get(input.sessionId);
      if (prior) seedAgentContext(agent, prior);
    }
    if (opts.applyConfigOptions && input.configOptions && input.configOptions.length > 0) {
      await opts.applyConfigOptions(agent, input.configOptions, input.sessionId);
      if (!alive()) return { stopReason: 'cancelled' };
    }

    // This turn's loop injects every result queued so far, so any notice still
    // waiting is moot; announcements that land mid-turn are re-checked below.
    const notifier = attachDeliveryNotifier(input.sessionId, agent);
    if (notifier) {
      if (api) notifier.api = api;
      notifier.running = true;
      notifier.pending.clear();
      if (notifier.timer) {
        clearTimeout(notifier.timer);
        notifier.timer = undefined;
      }
    }

    // Per-turn safety belt: a hard wall-clock cap that actually aborts the
    // run. We drive `agent.run` with a derived signal that fires when EITHER
    // the parent signal (client `session/cancel`) aborts OR the timer
    // elapses. Without this, a provider call that ignores the parent signal
    // would hang forever despite the documented `timeoutMs` cap.
    const turnAbort = new AbortController();
    const abortForTimeout = (): void => turnAbort.abort();
    const onParentAbort = (): void => turnAbort.abort();
    if (input.signal.aborted) {
      turnAbort.abort();
    } else {
      input.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timeouts.delete(input.sessionId);
      abortForTimeout();
    }, timeoutMs);
    timeouts.set(input.sessionId, timer);

    // Stream the core agent's tool activity to the ACP client as
    // tool_call / tool_call_update notifications so editors (Zed,
    // JetBrains, …) render live tool cards + statuses instead of seeing
    // a silent gap until the final text. We subscribe for the duration
    // of this turn and detach in the finally block.
    const unsub: Array<() => void> = [];
    // Real `Agent` always exposes `.events`; guard for Agent-like fakes.
    const bus = (agent as { events?: { on?: typeof agent.events.on } }).events;
    if (bus?.on) {
      unsub.push(
        bus.on('tool.started', (e) => {
          emit({
            sessionUpdate: 'tool_call',
            toolCallId: e.id,
            title: toolTitle(e.name, e.input),
            kind: toolNameToKind(e.name),
            status: 'in_progress',
            ...(isRecord(e.input) ? { rawInput: e.input } : {}),
          });
        }),
        bus.on('tool.executed', (e) => {
          emit({
            sessionUpdate: 'tool_call_update',
            toolCallId: e.id ?? e.name,
            status: e.ok ? 'completed' : 'failed',
            ...(e.output !== undefined
              ? {
                  content: [{ type: 'content', content: { type: 'text', text: e.output } }],
                }
              : {}),
          });
        }),
      );
    }

    try {
      const command = opts.runCommand
        ? await runPromptCommand(opts.runCommand, agent, input, {
            signal: turnAbort.signal,
            api,
            emit,
          })
        : { kind: 'none' as const };
      if (command.kind === 'done') {
        if (input.signal.aborted) return { stopReason: 'cancelled' };
        // The exchange is part of the conversation: replayed on load, and seen
        // by the model on the next turn ("what does that output mean?").
        const userText = promptToText(input.prompt);
        recordExchange(input.sessionId, userText, command.message);
        seedAgentContext(agent, [
          { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: userText } },
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: command.message },
          },
        ]);
        return { stopReason: 'end_turn' };
      }
      const userInput = promptToAgentInput(
        command.kind === 'continue' ? command.prompt : input.prompt,
      );
      const result = await agent.run(userInput, {
        signal: turnAbort.signal,
        inputOrigin: 'user',
      });
      if (!alive()) return { stopReason: 'cancelled' };

      // Stream the agent's final text back. A failed run with no text would
      // otherwise reach the client as an empty, successful-looking end_turn
      // (#421), so its error becomes the visible reply.
      const text = extractText(result) || (turnAbort.signal.aborted ? '' : extractRunError(result));
      if (text) {
        emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        });
      }

      // Record the turn so `session/load` can replay the conversation (not
      // for a session disposed mid-turn: that would outlive the session).
      const record = alive() && !turnAbort.signal.aborted;
      if (record) recordExchange(input.sessionId, promptToText(input.prompt), text);

      // Emit plan if the agent provided one
      const plan = extractPlan(result);
      if (plan.length > 0) {
        emit({
          sessionUpdate: 'plan',
          entries: plan,
        });
      }

      // Emit usage if the agent provided one
      const usage = extractUsage(result);
      if (usage) {
        emit({
          sessionUpdate: 'usage_update',
          used: usage.used,
          size: usage.size,
          ...(usage.cost ? { cost: usage.cost } : {}),
        });
      }

      const result_out: RunTurnResult = {
        // `turnAbort.signal` covers both client cancellation and the
        // wall-clock timeout, so either maps to stopReason 'cancelled'.
        stopReason: pickStopReason(result, turnAbort.signal),
      };
      if (text) result_out.text = text;
      const runTurnPlan = extractPlan(result);
      if (runTurnPlan.length > 0) result_out.plan = runTurnPlan;
      if (usage) result_out.usage = usage;
      return result_out;
    } finally {
      if (alive()) liveTurns.delete(input.sessionId);
      clearTimeout(timer);
      if (timeouts.get(input.sessionId) === timer) timeouts.delete(input.sessionId);
      input.signal.removeEventListener('abort', onParentAbort);
      for (const u of unsub) u();
      if (notifier && notifiers.get(input.sessionId) === notifier) {
        notifier.running = false;
        // A result can settle during the final iteration, after the loop's
        // last drain. With a live pending count that is detectable; without
        // one, assume the turn consumed what it saw rather than announce a
        // result the model already holds.
        if (!opts.pendingDeliveries) notifier.pending.clear();
        scheduleDeliveryNotice(input.sessionId);
      }
    }
  };

  const replay = (sessionId: string): SessionReplayUpdate[] => [...(history.get(sessionId) ?? [])];

  const seed = (
    sessionId: string,
    incoming: ReadonlyArray<{ sessionUpdate: string; content: unknown }>,
  ): void => {
    if (incoming.length === 0) {
      history.delete(sessionId);
      historyBytes.delete(sessionId);
      pendingSeed.delete(sessionId);
      return;
    }
    const seeded = [...incoming] as SessionReplayUpdate[];
    const retainedBytes = trimHistory(
      seeded,
      seeded.reduce((total, entry) => total + replayEntryBytes(entry), 0),
      maxHistoryEntries,
      maxHistoryBytes,
    );
    if (seeded.length === 0) {
      history.delete(sessionId);
      historyBytes.delete(sessionId);
      pendingSeed.delete(sessionId);
      return;
    }
    history.set(sessionId, seeded);
    historyBytes.set(sessionId, retainedBytes);
    pendingSeed.add(sessionId);
  };

  const dispose = (sessionId: string): void => {
    liveTurns.delete(sessionId);
    const timer = timeouts.get(sessionId);
    if (timer) clearTimeout(timer);
    timeouts.delete(sessionId);
    const notifier = notifiers.get(sessionId);
    if (notifier) {
      notifiers.delete(sessionId);
      if (notifier.timer) clearTimeout(notifier.timer);
      notifier.timer = undefined;
      notifier.pending.clear();
      for (const off of notifier.unsubscribe) {
        try {
          off();
        } catch {
          // teardown continues
        }
      }
    }
    const agent = agents.get(sessionId);
    agents.delete(sessionId);
    void Promise.resolve()
      .then(() => agent?.teardown?.())
      .catch(() => {});
    history.delete(sessionId);
    historyBytes.delete(sessionId);
    pendingSeed.delete(sessionId);
  };

  return Object.assign(turn, { replay, seed, dispose });
}

function finitePositiveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
}

function finiteNonNegativeLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) >= 0 ? Math.floor(value as number) : fallback;
}

/**
 * Prefix of a delegation's delivery id — mirrors core's
 * `delegationDeliveryId` (`delegation:<delegationId>`). Kept local so this
 * adapter does not pull the coordination runtime in for one string.
 */
const DELEGATION_DELIVERY_PREFIX = 'delegation:';
const NOTICE_MAX_IDS = 5;

function normalizeSessionKey(id: string): string {
  return id.trim().replace(/\\/g, '/');
}

/**
 * True when an event's session id belongs to this ACP session: the ACP id
 * itself, or the id the agent's context is bound to.
 */
function agentOwnsSession(agent: Agent, acpSessionId: string, eventSessionId: unknown): boolean {
  if (typeof eventSessionId !== 'string' || eventSessionId.trim().length === 0) return false;
  const target = normalizeSessionKey(eventSessionId);
  const ctx = (
    agent as { ctx?: { session?: { id?: unknown }; meta?: Record<string, unknown> | undefined } }
  ).ctx;
  const candidates: unknown[] = [acpSessionId, ctx?.session?.id, ctx?.meta?.['sessionId']];
  return candidates.some(
    (c) => typeof c === 'string' && c.length > 0 && normalizeSessionKey(c) === target,
  );
}

/** The client-facing notice for one or more finished background delegations. */
function deliveryNoticeText(deliveryIds: readonly string[]): string {
  const ids = deliveryIds.map((id) =>
    id.startsWith(DELEGATION_DELIVERY_PREFIX) ? id.slice(DELEGATION_DELIVERY_PREFIX.length) : id,
  );
  if (ids.length === 1) {
    return `Background delegation ${ids[0]} finished; send any message to continue.`;
  }
  const shown = ids.slice(0, NOTICE_MAX_IDS).join(', ');
  const more = ids.length > NOTICE_MAX_IDS ? ` (+${ids.length - NOTICE_MAX_IDS} more)` : '';
  return `Background delegations ${shown}${more} finished; send any message to continue.`;
}

function trimHistory(
  entries: SessionReplayUpdate[],
  retainedBytes: number,
  maxEntries: number,
  maxBytes: number,
): number {
  while (entries.length > maxEntries || retainedBytes > maxBytes) {
    const removed = entries.shift();
    if (!removed) break;
    retainedBytes -= replayEntryBytes(removed);
  }
  return Math.max(0, retainedBytes);
}

function replayEntryBytes(entry: SessionReplayUpdate): number {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8');
}

/**
 * Tear down the agents and timers held by a turn factory. The
 * server's `close()` should call this so child connections don't
 * outlive the server.
 */
export function disposeACPServerAgentTurn(opts: { agents: Map<string, Agent> }): Promise<void> {
  return Promise.allSettled(Array.from(opts.agents.values()).map((agent) => agent.teardown())).then(
    () => undefined,
  );
}

/** Internal deterministic seams used by the per-file coverage suite. */
export const serverAgentTurnCoverage = {
  finitePositiveLimit,
  finiteNonNegativeLimit,
  agentOwnsSession,
  deliveryNoticeText,
  trimHistory,
  replayEntryBytes,
  seedAgentContext,
  toolNameToKind,
  toolTitle,
  isRecord,
  promptToAgentInput,
  promptToText,
  extractText,
  extractRunError,
  pickStopReason,
  extractPlan,
  extractUsage,
};
