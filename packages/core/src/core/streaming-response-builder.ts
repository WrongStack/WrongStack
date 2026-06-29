import { randomUUID } from 'node:crypto';
import type { EventBus } from '../kernel/events.js';
import type { Logger } from '../types/logger.js';
import type { ContentBlock, ThinkingBlock, ToolUseBlock } from '../types/blocks.js';
import type { Provider, Request, Response } from '../types/provider.js';
import type { Context } from './context.js';
import { completePartialObject } from '../utils/json-repair.js';

const STREAM_DRAIN_TIMEOUT_MS = 500;

interface ThinkingEntry {
  textBuf: string;
  signature?: string | undefined;
  providerMeta?: Record<string, unknown>;
}

interface StreamingState {
  model: string;
  stopReason: Response['stopReason'];
  usage: Response['usage'];
  textBuffers: string[];
  currentTextIndex: number;
  tools: Map<
    string,
    {
      name: string;
      partial: string;
      input?: unknown | undefined;
      providerMeta?: Record<string, unknown>;
    }
  >;
  thinking: ThinkingEntry[];
  currentThinkingIndex: number;
  blockOrder: Array<
    { kind: 'text'; idx: number } | { kind: 'tool'; id: string } | { kind: 'thinking'; idx: number }
  >;
}

export function buildResponse(state: StreamingState): Response {
  const content: ContentBlock[] = [];
  for (const b of state.blockOrder) {
    if (b.kind === 'text') {
      const txt = state.textBuffers[b.idx] ?? '';
      if (txt) content.push({ type: 'text', text: txt });
    } else if (b.kind === 'thinking') {
      const t = state.thinking[b.idx];
      // Skip blocks with no thinking text AND no signature — emitting an
      // empty {type:'thinking', thinking:''} block makes Anthropic 400
      // ("content[].thinking.thinking: cannot be empty").
      if (!t) continue;
      if (!t.textBuf && !t.signature) continue;
      const block: ThinkingBlock = { type: 'thinking', thinking: t.textBuf };
      if (t.signature) block.signature = t.signature;
      if (t.providerMeta && Object.keys(t.providerMeta).length > 0) {
        block.providerMeta = t.providerMeta;
      }
      content.push(block);
    } else {
      const tb = state.tools.get(b.id);
      if (tb) {
        const block: ToolUseBlock = {
          type: 'tool_use',
          id: b.id,
          name: tb.name,
          input: (tb.input as Record<string, unknown>) ?? {},
        };
        if (tb.providerMeta && Object.keys(tb.providerMeta).length > 0) {
          block.providerMeta = tb.providerMeta;
        }
        content.push(block);
      }
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return { content, stopReason: state.stopReason, usage: state.usage, model: state.model };
}

export function createStreamingState(model: string): StreamingState {
  return {
    model,
    stopReason: 'end_turn',
    usage: { input: 0, output: 0 },
    textBuffers: [],
    currentTextIndex: -1,
    tools: new Map(),
    thinking: [],
    currentThinkingIndex: -1,
    blockOrder: [],
  };
}

export function handleMessageStart(state: StreamingState, model: string): void {
  state.model = model;
}

export function handleContentBlockStart(
  state: StreamingState,
  ev: {
    kind?: string | undefined;
    id?: string | undefined;
    name?: string | undefined;
    providerMeta?: Record<string, unknown>;
  },
): void {
  const kind = ev.kind ?? 'text';
  if (kind === 'text') {
    state.currentTextIndex = state.textBuffers.length;
    state.textBuffers.push('');
    state.blockOrder.push({ kind: 'text', idx: state.currentTextIndex });
  } else if (kind === 'tool_use') {
    const id = ev.id ?? randomUUID();
    state.tools.set(id, { name: ev.name ?? 'unknown', partial: '' });
    state.blockOrder.push({ kind: 'tool', id });
    state.currentTextIndex = -1;
  } else if (kind === 'thinking') {
    state.currentThinkingIndex = state.thinking.length;
    state.thinking.push({
      textBuf: '',
      ...(ev.providerMeta ? { providerMeta: ev.providerMeta } : {}),
    });
    state.blockOrder.push({ kind: 'thinking', idx: state.currentThinkingIndex });
    state.currentTextIndex = -1;
  }
}

export function handleContentBlockStop(
  state: StreamingState,
  ev: { index?: number | undefined },
): void {
  // Currently no provider adapter sends stop-only metadata.
  // (e.g. tool use result, thinking signature). Currently a no-op — every
  // content_block_stop event is consumed but produces no side effects.
  void state;
  void ev;
}

export function handleTextDelta(state: StreamingState, text: string): void {
  if (state.currentTextIndex === -1) {
    // No open text block — create one and track it.
    state.currentTextIndex = state.textBuffers.length;
    state.textBuffers.push('');
    state.blockOrder.push({ kind: 'text', idx: state.currentTextIndex });
  }
  state.textBuffers[state.currentTextIndex] =
    (state.textBuffers[state.currentTextIndex] ?? '') + text;
}

export function handleToolUseStart(state: StreamingState, ev: { id: string; name: string }): void {
  state.currentTextIndex = -1;
  state.tools.set(ev.id, { name: ev.name, partial: '' });
  state.blockOrder.push({ kind: 'tool', id: ev.id });
}

export function handleToolUseInputDelta(
  state: StreamingState,
  ev: { id: string; partial: string },
): void {
  const t = state.tools.get(ev.id);
  if (t) t.partial += ev.partial;
}

export function safeJsonOrRaw(s: string): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    // Attempt to repair a truncated streaming JSON blob by auto-closing
    // unclosed braces and string values before giving up.
    const repaired = completePartialObject(s);
    try {
      return JSON.parse(repaired);
    } catch {
      return { _raw: repaired };
    }
  }
}

export function handleToolUseStop(
  state: StreamingState,
  ev: { id: string; input?: unknown | undefined; providerMeta?: Record<string, unknown> },
): void {
  const t = state.tools.get(ev.id);
  if (t) {
    t.input = ev.input !== undefined ? ev.input : safeJsonOrRaw(t.partial);
    if (ev.providerMeta) t.providerMeta = ev.providerMeta;
  }
  state.currentTextIndex = -1;
}

/**
 * Open a fresh thinking block. Providers that don't pre-announce blocks
 * (e.g. OpenAI/DeepSeek) can call this lazily on the first reasoning delta.
 */
export function handleThinkingStart(
  state: StreamingState,
  ev: { providerMeta?: Record<string, unknown> },
): void {
  state.currentThinkingIndex = state.thinking.length;
  state.thinking.push({
    textBuf: '',
    ...(ev.providerMeta ? { providerMeta: ev.providerMeta } : {}),
  });
  state.blockOrder.push({ kind: 'thinking', idx: state.currentThinkingIndex });
  state.currentTextIndex = -1;
}

export function handleThinkingDelta(state: StreamingState, text: string): void {
  if (state.currentThinkingIndex === -1) {
    handleThinkingStart(state, {});
  }
  const t = state.thinking[state.currentThinkingIndex];
  if (t) t.textBuf += text;
}

export function handleThinkingSignature(state: StreamingState, signature: string): void {
  if (state.currentThinkingIndex === -1) {
    handleThinkingStart(state, {});
  }
  const t = state.thinking[state.currentThinkingIndex];
  if (t) t.signature = signature;
}

export function handleThinkingStop(state: StreamingState): void {
  state.currentThinkingIndex = -1;
}

export function handleMessageStop(
  state: StreamingState,
  ev: { stopReason?: Response['stopReason'] | undefined; usage?: Response['usage'] | undefined },
): void {
  state.stopReason = ev.stopReason ?? 'end_turn';
  state.usage = ev.usage ?? { input: 0, output: 0 };
}

export async function streamProviderToResponse(
  provider: Provider,
  req: Request,
  signal: AbortSignal,
  ctx: Context,
  events: EventBus,
  logger: Logger,
): Promise<Response> {
  const state = createStreamingState(req.model);
  const sessionId = ctx.session?.id;
  logger.debug('Stream started', { providerId: provider.id, model: req.model });

  // Batch text_delta EventBus emissions to cut fan-out ~4×. Subscribers
  // treat `text` as an appendable chunk, so concatenating deltas before
  // emitting is semantically identical. Flush before any non-text event
  // and at stream end to preserve ordering.
  const TEXT_BATCH_SIZE = 4;
  let pendingText = '';
  let pendingCount = 0;
  const flushText = (): void => {
    if (pendingCount > 0) {
      events.emit('provider.text_delta', { sessionId, ctx, text: pendingText });
      pendingText = '';
      pendingCount = 0;
    }
  };

  const iter = provider.stream(req, { signal })[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await iter.next();
      if (next.done) break;
      const ev = next.value;
      try {
        switch (ev.type) {
          case 'message_start':
            handleMessageStart(state, ev.model);
            break;
          case 'content_block_start':
            handleContentBlockStart(state, ev as Parameters<typeof handleContentBlockStart>[1]);
            break;
          case 'content_block_stop':
            handleContentBlockStop(state, ev as Parameters<typeof handleContentBlockStop>[1]);
            break;
          case 'text_delta':
            handleTextDelta(state, ev.text);
            pendingText += ev.text;
            pendingCount++;
            if (pendingCount >= TEXT_BATCH_SIZE) flushText();
            break;
          case 'tool_use_start': {
            flushText();
            const idVal = ev.id;
            const nameVal = ev.name;
            handleToolUseStart(state, { id: idVal, name: nameVal });
            const emittedPayload = { sessionId, ctx, id: idVal ?? 'unknown', name: nameVal ?? 'unknown' };
            events.emit('provider.tool_use_start', emittedPayload);
            break;
          }
          case 'tool_use_input_delta':
            handleToolUseInputDelta(state, ev as Parameters<typeof handleToolUseInputDelta>[1]);
            break;
          case 'tool_use_stop': {
            flushText();
            const stoppedName = state.tools.get(ev.id)?.name ?? 'unknown';
            handleToolUseStop(state, ev as Parameters<typeof handleToolUseStop>[1]);
            events.emit('provider.tool_use_stop', { sessionId, ctx, id: ev.id, name: stoppedName });
            break;
          }
          case 'thinking_start':
            handleThinkingStart(state, ev as Parameters<typeof handleThinkingStart>[1]);
            break;
          case 'thinking_delta':
            flushText();
            handleThinkingDelta(state, ev.text);
            events.emit('provider.thinking_delta', { sessionId, ctx, text: ev.text });
            break;
          case 'thinking_signature':
            handleThinkingSignature(state, ev.signature);
            break;
          case 'thinking_stop':
            handleThinkingStop(state);
            break;
          case 'message_stop':
            handleMessageStop(state, ev as Parameters<typeof handleMessageStop>[1]);
            break;
          default: {
            // Unknown SSE event type — log for observability
            const unknownEv = ev as { type: unknown };
            logger.warn(`Stream received unknown event type: "${String(unknownEv.type)}"`, {
              providerId: provider.id,
              model: req.model,
              eventType: String(unknownEv.type),
            });
            break;
          }
        }
      } catch (handlerErr) {
        // Best-effort: a single malformed event should not abort the entire
        // stream. The partial response built from earlier events is preserved.
        const errMsg = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
        const evAny = ev as { type: unknown };
        logger.warn(`Stream handler error for event type "${String(evAny.type)}": ${errMsg}`, {
          providerId: provider.id,
          model: req.model,
          eventType: String(evAny.type),
          errorMessage: errMsg,
        });
        flushText();
        events.emit('provider.stream_error', {
          sessionId,
          ctx,
          eventType: String(evAny.type),
          msg: errMsg,
        });
      }
    }
  } catch (err) {
    if (signal.aborted) {
      // Preserve partial state so the agent can persist what was already
      // streamed before honoring the abort. The agent's outer loop checks
      // `controller.signal.aborted` after consuming this response and
      // returns `status: 'aborted'` with the finalText we built here.
      //
      // The stop reason `end_turn` is the most accurate of the available
      // StopReason values — the stream simply ended early, it was NOT a
      // token-budget hit (the previous code mis-attributed this as
      // `max_tokens`, which corrupted telemetry and broke retry logic
      // that branches on max_tokens specifically).
      state.stopReason = 'end_turn';
      flushText();
      logger.debug('Stream aborted — returning partial state', {
        providerId: provider.id,
        model: req.model,
        textBlockCount: state.textBuffers.length,
        toolBlockCount: state.tools.size,
        thinkingBlockCount: state.thinking.length,
      });
      return buildResponse(state);
    }
    throw err;
  } finally {
    try {
      // Race the drain against a short deadline so a non-cooperative
      // provider stream can't pin shutdown. 500ms is long enough for
      // cooperative SDK iterators to release network resources without
      // making abort/exit paths feel stuck.
      let drainTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        // Attach a noop catch to the loser so a rejected iter.return()
        // doesn't become an unhandled promise rejection when the timeout wins.
        const drainPromise = Promise.resolve(iter.return?.()).catch(() => {
          // best-effort — iter.return() may reject on abrupt stream close
        });
        await Promise.race([
          drainPromise,
          new Promise<void>((resolve) => {
            drainTimer = setTimeout(resolve, STREAM_DRAIN_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (drainTimer) clearTimeout(drainTimer);
      }
    } catch {
      // best-effort
    }
  }
  flushText();
  logger.debug('Stream completed', {
    providerId: provider.id,
    model: req.model,
    stopReason: state.stopReason,
    textBlockCount: state.textBuffers.length,
    toolBlockCount: state.tools.size,
    thinkingBlockCount: state.thinking.length,
    usageInput: state.usage.input,
    usageOutput: state.usage.output,
  });
  return buildResponse(state);
}
