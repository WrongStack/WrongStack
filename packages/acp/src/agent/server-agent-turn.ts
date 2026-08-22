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
 */
import type { Agent, AgentInput } from '@wrongstack/core/agent';
import type { ContentBlock, PlanEntry, StopReason, ToolKind, UsageCost } from '../types/acp-v1.js';
import type { RunTurn, RunTurnApi, RunTurnResult } from './protocol-handler.js';

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
   */
  agentFor: (sessionId: string, cwd: string, api?: RunTurnApi) => Promise<Agent> | Agent;
  /**
   * Hard wall-clock cap for one turn. The agent's own provider
   * timeout is layered under this; this cap is a safety belt.
   * Default 5 minutes.
   */
  timeoutMs?: number | undefined;
  /** Maximum replay entries retained per session. Default 1000. */
  maxHistoryEntries?: number | undefined;
  /** Maximum serialized replay bytes retained per session. Default 8 MiB. */
  maxHistoryBytes?: number | undefined;
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
export interface ACPServerAgentTurn {
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

  const turn = async (
    input: Parameters<RunTurn>[0],
    emit: Parameters<RunTurn>[1],
    api?: Parameters<RunTurn>[2],
  ): Promise<RunTurnResult> => {
    // Lazily create an agent for this session on the first turn.
    let agent = agents.get(input.sessionId);
    if (!agent) {
      agent = await opts.agentFor(input.sessionId, process.cwd(), api);
      agents.set(input.sessionId, agent);
      // Cold-load priming: re-feed the restored conversation into the new
      // agent's context so the MODEL resumes (not just the client UI).
      if (pendingSeed.has(input.sessionId)) {
        pendingSeed.delete(input.sessionId);
        seedAgentContext(agent, history.get(input.sessionId)!);
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
      const userInput = promptToAgentInput(input.prompt);
      const result = await agent.run(userInput, { signal: turnAbort.signal });

      // Stream the agent's final text back
      const text = extractText(result);
      if (text) {
        emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        });
      }

      // Record the turn so `session/load` can replay the conversation.
      const userText = promptToText(input.prompt);
      const hist = history.get(input.sessionId) ?? [];
      let retainedHistoryBytes = historyBytes.get(input.sessionId) ?? 0;
      if (userText) {
        const update: SessionReplayUpdate = {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: userText },
        };
        hist.push(update);
        retainedHistoryBytes += replayEntryBytes(update);
      }
      if (text) {
        const update: SessionReplayUpdate = {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        };
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
        history.set(input.sessionId, hist);
        historyBytes.set(input.sessionId, retainedHistoryBytes);
      } else {
        history.delete(input.sessionId);
        historyBytes.delete(input.sessionId);
      }

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
      clearTimeout(timer);
      timeouts.delete(input.sessionId);
      input.signal.removeEventListener('abort', onParentAbort);
      for (const u of unsub) u();
    }
  };

  const replay = (sessionId: string): SessionReplayUpdate[] => [...(history.get(sessionId) ?? [])];

  const seed = (
    sessionId: string,
    incoming: ReadonlyArray<{ sessionUpdate: string; content: unknown }>,
  ): void => {
    if (incoming.length === 0) return;
    const seeded = [...incoming] as SessionReplayUpdate[];
    const retainedBytes = trimHistory(
      seeded,
      seeded.reduce((total, entry) => total + replayEntryBytes(entry), 0),
      maxHistoryEntries,
      maxHistoryBytes,
    );
    history.set(sessionId, seeded);
    historyBytes.set(sessionId, retainedBytes);
    pendingSeed.add(sessionId);
  };

  const dispose = (sessionId: string): void => {
    const timer = timeouts.get(sessionId);
    if (timer) clearTimeout(timer);
    timeouts.delete(sessionId);
    agents.delete(sessionId);
    history.delete(sessionId);
    historyBytes.delete(sessionId);
    pendingSeed.delete(sessionId);
  };

  return Object.assign(turn, { replay, seed, dispose });
}

function finitePositiveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
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
 * Prime a freshly-created agent's conversation state with restored history.
 * Each recorded user/agent chunk becomes a `user`/`assistant` message so the
 * model continues the prior conversation instead of starting blank.
 */
function seedAgentContext(
  agent: Agent,
  history: ReadonlyArray<{ sessionUpdate: string; content: unknown }>,
): void {
  const state = (agent as { ctx?: { state?: { appendMessage?: (m: unknown) => void } } }).ctx
    ?.state;
  if (!state?.appendMessage) return;
  for (const u of history) {
    const text = (u.content as { text?: unknown } | undefined)?.text;
    if (typeof text !== 'string' || text.length === 0) continue;
    const role = u.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant';
    state.appendMessage({ role, content: text });
  }
}

/** Map a WrongStack tool name to the closest ACP ToolKind for UI grouping. */
function toolNameToKind(name: string): ToolKind {
  const n = name.toLowerCase();
  if (n.includes('read') || n.includes('cat')) return 'read';
  if (n.includes('write') || n.includes('edit') || n.includes('apply') || n.includes('patch'))
    return 'edit';
  if (n.includes('delete') || n === 'rm' || n.startsWith('rm_') || n.endsWith('_rm'))
    return 'delete';
  if (n.includes('move') || n.includes('rename') || n.includes('mv')) return 'move';
  if (n.includes('grep') || n.includes('glob') || n.includes('search') || n.includes('find'))
    return 'search';
  if (
    n.includes('bash') ||
    n.includes('shell') ||
    n.includes('exec') ||
    n.includes('run') ||
    n.includes('terminal')
  )
    return 'execute';
  if (n.includes('fetch') || n.includes('http') || n.includes('web') || n.includes('url'))
    return 'fetch';
  if (n.includes('think') || n.includes('plan')) return 'think';
  return 'other';
}

/** A short, human-readable title for a tool call card. */
function toolTitle(name: string, input: unknown): string {
  if (isRecord(input)) {
    const path = input.path ?? input.file ?? input.filePath ?? input.pattern ?? input.command;
    if (typeof path === 'string' && path.length > 0) {
      return `${name}: ${path.length > 80 ? `${path.slice(0, 77)}…` : path}`;
    }
  }
  return name;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Convert an ACP `ContentBlock[]` prompt into a core `AgentInput`.
 *
 * When the prompt is all text we return a plain string (the common,
 * cheapest path). When it carries images we build a multimodal
 * `ContentBlock[]` the provider can pass to a vision-capable model.
 * Audio and resource blocks have no core representation yet, so they're
 * recorded as bracketed text placeholders alongside the other content.
 */
function promptToAgentInput(blocks: readonly ContentBlock[]): AgentInput {
  const hasImage = blocks.some((b) => b.type === 'image');
  if (!hasImage) {
    return promptToText(blocks);
  }
  const out: AgentInput = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      out.push({ type: 'text', text: b.text });
    } else if (b.type === 'image') {
      out.push({
        type: 'image',
        source: { type: 'base64', media_type: b.mimeType, data: b.data },
      });
    } else if (b.type === 'audio') {
      out.push({ type: 'text', text: `[audio: ${b.mimeType}]` });
    } else if (b.type === 'resource') {
      const text =
        'text' in b.resource && typeof b.resource.text === 'string'
          ? b.resource.text
          : `[embedded resource: ${b.resource.uri}]`;
      out.push({ type: 'text', text });
    } else if (b.type === 'resource_link') {
      out.push({ type: 'text', text: `[resource link: ${b.uri}]` });
    }
  }
  return out;
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

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Convert an ACP `ContentBlock[]` prompt to a single user-message
 * string. Text blocks are concatenated; image / audio / resource
 * blocks are recorded as a bracketed placeholder (full multimodal
 * support is a future PR — the adapter is v1-text only for now).
 */
function promptToText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      parts.push(b.text);
    } else if (b.type === 'image') {
      parts.push(`[image: ${b.mimeType}]`);
    } else if (b.type === 'audio') {
      parts.push(`[audio: ${b.mimeType}]`);
    } else if (b.type === 'resource') {
      parts.push(`[embedded resource: ${b.resource.uri}]`);
    } else if (b.type === 'resource_link') {
      parts.push(`[resource link: ${b.uri}]`);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Extract the agent's final text from a `RunResult`. The shape
 * varies across core versions, so we read the most common fields
 * defensively and concatenate whatever text we find.
 */
function extractText(result: unknown): string {
  if (typeof result !== 'object' || result === null) return '';
  const r = result as Record<string, unknown>;
  // v1: result.text is the agent's final text (string).
  if (typeof r.text === 'string') return r.text;
  // Legacy: result.content is an array of blocks.
  if (Array.isArray(r.content)) {
    const parts: string[] = [];
    for (const c of r.content) {
      if (typeof c === 'object' && c !== null) {
        const cb = c as { type?: string; text?: unknown };
        if (cb.type === 'text' && typeof cb.text === 'string') parts.push(cb.text);
      }
    }
    return parts.join('');
  }
  return '';
}

/**
 * Map a `RunResult` (and the parent signal) to a v1 `StopReason`.
 *
 * If the parent signal was aborted, return `'cancelled'`. Otherwise
 * the agent completed normally — we treat any non-error result
 * as `'end_turn'`. The core `RunResult` doesn't currently surface
 * a per-turn stop reason, so v1's `'max_tokens'`, `'max_turn_requests'`,
 * and `'refusal'` discriminators can't be emitted precisely; we
 * log a warning if the result carries an error and return the
 * generic end_turn.
 */
function pickStopReason(result: unknown, signal: AbortSignal): StopReason {
  if (signal.aborted) return 'cancelled';
  if (typeof result !== 'object' || result === null) return 'end_turn';
  const r = result as { error?: unknown; stopReason?: unknown };
  if (r.error) {
    return 'end_turn';
  }
  if (typeof r.stopReason === 'string' && r.stopReason) {
    return r.stopReason as StopReason;
  }
  return 'end_turn';
}

/**
 * Extract a plan from the agent's RunResult, if available.
 * The plan is an array of PlanEntry objects.
 */
function extractPlan(result: unknown): PlanEntry[] {
  if (typeof result !== 'object' || result === null) return [];
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.plan)) {
    // Agent provided a plan array
    return r.plan.filter(
      (e: unknown) =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { content?: unknown }).content === 'string',
    ) as PlanEntry[];
  }
  return [];
}

/**
 * Extract usage/token info from the agent's RunResult, if available.
 */
function extractUsage(
  result: unknown,
): { used: number; size: number; cost?: UsageCost | undefined } | null {
  if (typeof result !== 'object' || result === null) return null;
  const r = result as Record<string, unknown>;
  if (typeof r.usage === 'object' && r.usage !== null) {
    const u = r.usage as { used?: unknown; size?: unknown; cost?: unknown };
    if (typeof u.used === 'number' && typeof u.size === 'number') {
      return {
        used: u.used,
        size: u.size,
        ...(typeof u.cost === 'object' && u.cost !== null ? { cost: u.cost as UsageCost } : {}),
      };
    }
  }
  return null;
}

/** Internal deterministic seams used by the per-file coverage suite. */
export const serverAgentTurnCoverage = {
  finitePositiveLimit,
  trimHistory,
  replayEntryBytes,
  seedAgentContext,
  toolNameToKind,
  toolTitle,
  isRecord,
  promptToAgentInput,
  promptToText,
  extractText,
  pickStopReason,
  extractPlan,
  extractUsage,
};
