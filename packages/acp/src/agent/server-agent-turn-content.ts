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
import * as path from 'node:path';
import type { Agent, AgentInput } from '@wrongstack/core/agent';
import { parseIncomingImages } from '@wrongstack/core/utils';
import type { ContentBlock, PlanEntry, StopReason, ToolKind, UsageCost } from '../types/acp-v1.js';

/**
 * Prime a freshly-created agent's conversation state with restored history.
 * Each recorded user/agent chunk becomes a `user`/`assistant` message so the
 * model continues the prior conversation instead of starting blank.
 */
export function seedAgentContext(
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
export function toolNameToKind(name: string): ToolKind {
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
export function toolTitle(name: string, input: unknown): string {
  if (isRecord(input)) {
    const path = input.path ?? input.file ?? input.filePath ?? input.pattern ?? input.command;
    if (typeof path === 'string' && path.length > 0) {
      if (path.length <= 80) return `${name}: ${path}`;
      // The cut must not leave a lone high surrogate in the tool_call frame.
      let cut = 77;
      const last = path.charCodeAt(cut - 1);
      if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
      return `${name}: ${path.slice(0, cut)}…`;
    }
  }
  return name;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Extract ACP v1 `tool_call.locations` (`{ path, line? }[]`) from a tool's
 * structured input so editors can offer "Follow Agent" / click-to-open-file.
 */
export function toolLocations(
  input: unknown,
  cwd?: string,
): Array<{ path: string; line?: number }> | undefined {
  if (!isRecord(input)) return undefined;
  const rawPath = input.path ?? input.file ?? input.filePath;
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) return undefined;
  const resolved = path.isAbsolute(rawPath) ? rawPath : cwd ? path.resolve(cwd, rawPath) : rawPath;
  const rawLine = input.line ?? input.offset ?? input.startLine;
  const line =
    typeof rawLine === 'number' && Number.isInteger(rawLine) && rawLine >= 1 ? rawLine : undefined;
  return [{ path: resolved, ...(line !== undefined ? { line } : {}) }];
}

/**
 * Convert an ACP `ContentBlock[]` prompt into a core `AgentInput`.
 *
 * When the prompt is all text we return a plain string (the common,
 * cheapest path). When it carries images we build a multimodal
 * `ContentBlock[]` the provider can pass to a vision-capable model.
 * Images go through core's shared ingest (allowlist, base64, size and count
 * caps, the bytes decide the media type): the client's label used to reach
 * the provider unchecked. Every other block renders as in the text path, so
 * an embedded resource keeps its `[embedded resource: <uri>]` header.
 */
export function promptToAgentInput(blocks: readonly ContentBlock[]): AgentInput {
  const images = blocks.filter((b) => b.type === 'image');
  if (images.length === 0) {
    return promptToText(blocks);
  }
  let parsed: ReturnType<typeof parseIncomingImages>;
  try {
    parsed = parseIncomingImages(images.map((b) => ({ data: b.data, mediaType: b.mimeType })));
  } catch (err) {
    // IncomingImageError: its message is safe to echo; a bad block is the
    // client's invalid params, not an internal error.
    throw Object.assign(new Error((err as Error).message), { code: -32602 });
  }
  const out: AgentInput = [];
  let next = 0;
  for (const b of blocks) {
    if (b.type === 'image') out.push(parsed[next++]!);
    else if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else {
      const text = promptToText([b]);
      if (text) out.push({ type: 'text', text });
    }
  }
  return out;
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
export function promptToText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      parts.push(b.text);
    } else if (b.type === 'image') {
      parts.push(`[image: ${b.mimeType}]`);
    } else if (b.type === 'audio') {
      parts.push(`[audio: ${b.mimeType}]`);
    } else if (b.type === 'resource') {
      parts.push(
        'text' in b.resource && typeof b.resource.text === 'string'
          ? `[embedded resource: ${b.resource.uri}]\n${b.resource.text}`
          : `[embedded resource: ${b.resource.uri}]`,
      );
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
export function extractText(result: unknown): string {
  if (typeof result !== 'object' || result === null) return '';
  const r = result as Record<string, unknown>;
  // Core `RunResult` carries the answer as `finalText`; reading only `text`
  // sent a real Agent's turn back to the client with no message at all.
  if (typeof r.finalText === 'string') return r.finalText;
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
 * A user-facing line for a run that ended with an error, or `''` when the
 * result carries none. Used only when the run produced no text of its own.
 */
export function extractRunError(result: unknown): string {
  if (typeof result !== 'object' || result === null) return '';
  const error = (result as { error?: unknown }).error;
  if (!error) return '';
  const message =
    typeof error === 'string'
      ? error
      : typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : '';
  return message ? `Error: ${message}` : 'Error: the turn failed.';
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
export function pickStopReason(result: unknown, signal: AbortSignal): StopReason {
  if (signal.aborted) return 'cancelled';
  if (typeof result !== 'object' || result === null) return 'end_turn';
  const r = result as { error?: unknown; stopReason?: unknown; status?: unknown };
  // Core `RunResult.status`: an exhausted iteration budget is not a normal finish.
  if (r.status === 'max_iterations') return 'max_turn_requests';
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
export function extractPlan(result: unknown): PlanEntry[] {
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
export function extractUsage(
  result: unknown,
): { used: number; size: number; cost?: UsageCost | undefined } | null {
  if (typeof result !== 'object' || result === null) return null;
  const r = result as Record<string, unknown>;
  if (typeof r.usage === 'object' && r.usage !== null) {
    const u = r.usage as { used?: unknown; size?: unknown; cost?: unknown };
    if (
      typeof u.used === 'number' &&
      Number.isFinite(u.used) &&
      typeof u.size === 'number' &&
      Number.isFinite(u.size)
    ) {
      return {
        used: u.used,
        size: u.size,
        ...(typeof u.cost === 'object' && u.cost !== null ? { cost: u.cost as UsageCost } : {}),
      };
    }
  }
  return null;
}
