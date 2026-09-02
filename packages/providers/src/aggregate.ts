import { expectDefined } from '@wrongstack/core/utils';
import type {
  ContentBlock,
  Response,
  StopReason,
  StreamEvent,
  Usage,
} from '@wrongstack/core/types';
import { parseToolInput } from './_tool-input.js';
/**
 * Consume an `AsyncIterable<StreamEvent>` and reduce it to a non-streaming
 * `Response`. Used by `Provider.complete()` default impls so that the
 * streaming code path is the single source of truth.
 *
 * Optional `onEvent` callback fires for every event as it arrives, useful
 * for the agent loop to emit text_delta to the EventBus without writing
 * its own aggregation logic.
 */
export async function aggregateStream(
  stream: AsyncIterable<StreamEvent>,
  onEvent?: ((e: StreamEvent) => void) | undefined,
): Promise<Response> {
  let model = '';
  let stopReason: StopReason = 'end_turn';
  let usage: Usage = { input: 0, output: 0 };
  // Accumulate deltas as an array of chunks; join once at content-build time.
  // This avoids O(n²) string concatenation for responses with many small deltas.
  const textBuffers: string[][] = [];
  let currentTextIndex = -1;
  const toolBuffers = new Map<
    string,
    {
      name: string;
      /** Accumulated as an array of chunks; joined into a string at parse time to avoid O(n²) concat. */
      chunks: string[];
      input?: unknown | undefined;
      providerMeta?: Record<string, unknown>;
    }
  >();
  const thinkingBuffers: Array<{
    /** Accumulated as an array of chunks; joined into a string at content-build time. */
    chunks: string[];
    signature?: string | undefined;
    providerMeta?: Record<string, unknown>;
  }> = [];
  let currentThinkingIndex = -1;
  const blockOrder: Array<
    { kind: 'text'; idx: number } | { kind: 'tool'; id: string } | { kind: 'thinking'; idx: number }
  > = [];

  for await (const ev of stream) {
    if (onEvent) onEvent(ev);
    switch (ev.type) {
      case 'message_start':
        model = ev.model;
        break;
      case 'text_delta':
        if (currentTextIndex === -1) {
          currentTextIndex = textBuffers.length;
          textBuffers.push([]);
          blockOrder.push({ kind: 'text', idx: currentTextIndex });
        }
        textBuffers[currentTextIndex]!.push(ev.text);
        break;
      case 'tool_use_start':
        // A tool_use block starts — close any open text block so subsequent
        // text_delta starts a new one.
        currentTextIndex = -1;
        toolBuffers.set(ev.id, { name: ev.name, chunks: [] });
        blockOrder.push({ kind: 'tool', id: ev.id });
        break;
      case 'tool_use_input_delta': {
        const b = toolBuffers.get(ev.id);
        if (b) b.chunks.push(ev.partial);
        break;
      }
      case 'tool_use_stop': {
        const b = toolBuffers.get(ev.id);
        if (b) {
          if (ev.input === undefined) {
            // No upstream input — parse from the accumulated chunk buffer.
            b.input = parseToolInput(
              b.chunks.length === 1 ? (b.chunks[0] ?? '') : b.chunks.join(''),
            );
          } else if (typeof ev.input === 'string') {
            // Upstream gave us a raw JSON string; route through the validator.
            b.input = parseToolInput(ev.input);
          } else if (ev.input && typeof ev.input === 'object' && !Array.isArray(ev.input)) {
            b.input = ev.input;
          } else {
            // Array / scalar — preserve via __raw so downstream sees an object.
            b.input = { __raw: ev.input };
          }
          if (ev.providerMeta) b.providerMeta = ev.providerMeta;
        }
        // Tool just stopped — next text_delta should open a new text block.
        currentTextIndex = -1;
        break;
      }
      case 'thinking_start': {
        currentTextIndex = -1;
        // If a thinking block was already started by thinking_signature before
        // this event arrived (e.g. due to out-of-order delivery), reuse it so
        // signature and content end up in the same block rather than creating
        // duplicate thinking entries in the response.
        if (currentThinkingIndex === -1 || !thinkingBuffers[currentThinkingIndex]) {
          currentThinkingIndex = thinkingBuffers.length;
          thinkingBuffers.push({ chunks: [] });
        }
        // Always set providerMeta on the target block (thinking_start may carry
        // metadata even when the prior signature event did not).
        if (ev.providerMeta && currentThinkingIndex >= 0) {
          expectDefined(thinkingBuffers[currentThinkingIndex]).providerMeta = ev.providerMeta;
        }
        blockOrder.push({ kind: 'thinking', idx: currentThinkingIndex });
        break;
      }
      case 'thinking_delta': {
        // Ensure a thinking buffer exists before appending. If thinking_signature
        // created the block (currentThinkingIndex >= 0), reuse it so the
        // signature and content end up in the same buffer.
        if (currentThinkingIndex === -1 || !thinkingBuffers[currentThinkingIndex]) {
          currentThinkingIndex = thinkingBuffers.length;
          thinkingBuffers.push({ chunks: [] });
          blockOrder.push({ kind: 'thinking', idx: currentThinkingIndex });
        }
        const t = thinkingBuffers[currentThinkingIndex];
        if (t) t.chunks.push(ev.text);
        break;
      }
      case 'thinking_signature': {
        // Ensure a thinking buffer exists before storing the signature. This
        // handles out-of-order delivery where thinking_signature arrives before
        // thinking_start.
        if (currentThinkingIndex === -1 || !thinkingBuffers[currentThinkingIndex]) {
          currentThinkingIndex = thinkingBuffers.length;
          thinkingBuffers.push({ chunks: [] });
          blockOrder.push({ kind: 'thinking', idx: currentThinkingIndex });
        }
        const t = thinkingBuffers[currentThinkingIndex];
        if (t) t.signature = ev.signature;
        break;
      }
      case 'thinking_stop': {
        currentThinkingIndex = -1;
        break;
      }
      case 'message_stop':
        stopReason = ev.stopReason;
        usage = ev.usage;
        break;
      default:
        // Unknown SSE event — silently skip
        break;
    }
  }

  const content: ContentBlock[] = [];
  for (const b of blockOrder) {
    if (b.kind === 'text') {
      const text = textBuffers[b.idx]?.join('') ?? '';
      if (text) content.push({ type: 'text', text });
    } else if (b.kind === 'thinking') {
      const t = thinkingBuffers[b.idx];
      const thinkingText = t?.chunks.join('') ?? '';
      // Drop completely empty thinking blocks — emitting one would make
      // Anthropic 400 on the round-trip ("thinking: cannot be empty").
      if (!t || (!thinkingText && !t.signature)) continue;
      const block: ContentBlock = { type: 'thinking', thinking: thinkingText };
      if (t.signature) (block as { signature?: string | undefined }).signature = t.signature;
      if (t.providerMeta && Object.keys(t.providerMeta).length > 0) {
        (block as { providerMeta?: Record<string, unknown> }).providerMeta = t.providerMeta;
      }
      content.push(block);
    } else {
      const tb = toolBuffers.get(b.id);
      if (tb) {
        const block: ContentBlock = {
          type: 'tool_use',
          id: b.id,
          name: tb.name,
          input:
            tb.input && typeof tb.input === 'object' && !Array.isArray(tb.input)
              ? (tb.input as Record<string, unknown>)
              : {},
        };
        if (tb.providerMeta && Object.keys(tb.providerMeta).length > 0) {
          (block as { providerMeta?: Record<string, unknown> }).providerMeta = tb.providerMeta;
        }
        content.push(block);
      }
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });

  return { content, stopReason, usage, model };
}
