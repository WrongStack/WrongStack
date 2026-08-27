import { describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import {
  buildResponse,
  createStreamingState,
  handleContentBlockStart,
  handleContentBlockStop,
  handleMessageStart,
  handleMessageStop,
  handleTextDelta,
  handleThinkingDelta,
  handleThinkingSignature,
  handleThinkingStart,
  handleThinkingStop,
  handleToolUseInputDelta,
  handleToolUseStart,
  handleToolUseStop,
  safeJsonOrRaw,
  streamProviderToResponse,
} from '../../src/core/streaming-response-builder.js';
import { EventBus } from '../../src/kernel/events.js';
import type { Provider, Request } from '../../src/types/provider.js';

// Every agent event carries the session that owns the run; a context without
// one is rejected at emit time.
const fakeCtx = {
  messages: [],
  activeRunSessionId: '2026-08-26/sess_01TESTSTREAMBUILDER000000',
} as never as Context;

const noopLogger = {
  level: 'info' as const,
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child() {
    return noopLogger;
  },
};

function fakeProvider(events: Array<Record<string, unknown>>): Provider {
  return {
    id: 'fake',
    capabilities: { streaming: true, tools: true, vision: false, reasoning: true },
    async complete() {
      throw new Error('not used');
    },
    async *stream() {
      for (const ev of events) yield ev as never;
    },
  };
}

const req = { model: 'fake-1', messages: [] } as Request;

describe('createStreamingState + buildResponse', () => {
  it('creates a fresh state with sensible defaults', () => {
    const s = createStreamingState('model-x');
    expect(s.model).toBe('model-x');
    expect(s.stopReason).toBe('end_turn');
    expect(s.usage).toEqual({ input: 0, output: 0 });
    expect(s.currentTextIndex).toBe(-1);
    expect(s.currentThinkingIndex).toBe(-1);
    expect(s.textBuffers).toEqual([]);
    expect(s.thinking).toEqual([]);
    expect(s.blockOrder).toEqual([]);
  });

  it('buildResponse with no blocks emits a single empty text block', () => {
    const s = createStreamingState('m');
    const r = buildResponse(s);
    expect(r.content).toEqual([{ type: 'text', text: '' }]);
    expect(r.stopReason).toBe('end_turn');
    expect(r.model).toBe('m');
  });

  it('buildResponse drops empty thinking blocks (no text + no signature)', () => {
    const s = createStreamingState('m');
    s.thinking.push({ textBuf: '', signature: undefined });
    s.blockOrder.push({ kind: 'thinking', idx: 0 });
    const r = buildResponse(s);
    // Empty thinking suppressed → fallback empty text block is emitted
    expect(r.content).toEqual([{ type: 'text', text: '' }]);
  });

  it('buildResponse retains thinking with text or signature, including providerMeta', () => {
    const s = createStreamingState('m');
    s.thinking.push({
      textBuf: 'reasoning',
      signature: 'sig-1',
      providerMeta: { reasoning_id: 'abc' },
    });
    s.blockOrder.push({ kind: 'thinking', idx: 0 });
    const r = buildResponse(s);
    expect(r.content).toHaveLength(1);
    expect(r.content[0]).toMatchObject({
      type: 'thinking',
      thinking: 'reasoning',
      signature: 'sig-1',
      providerMeta: { reasoning_id: 'abc' },
    });
  });

  it('buildResponse skips tool blocks not present in the tools map', () => {
    const s = createStreamingState('m');
    s.blockOrder.push({ kind: 'tool', id: 'missing-id' });
    const r = buildResponse(s);
    expect(r.content).toEqual([{ type: 'text', text: '' }]);
  });

  it('buildResponse emits tool_use blocks with providerMeta when present', () => {
    const s = createStreamingState('m');
    s.tools.set('t1', {
      name: 'foo',
      partial: '',
      input: { x: 1 },
      providerMeta: { extra: 'meta' },
    });
    s.blockOrder.push({ kind: 'tool', id: 't1' });
    const r = buildResponse(s);
    expect(r.content).toEqual([
      { type: 'tool_use', id: 't1', name: 'foo', input: { x: 1 }, providerMeta: { extra: 'meta' } },
    ]);
  });

  it('buildResponse skips tools missing an input (defaults to {})', () => {
    const s = createStreamingState('m');
    s.tools.set('t2', { name: 'bar', partial: '' });
    s.blockOrder.push({ kind: 'tool', id: 't2' });
    const r = buildResponse(s);
    expect(r.content[0]).toMatchObject({
      type: 'tool_use',
      id: 't2',
      name: 'bar',
      input: {},
    });
  });
});

describe('per-event handlers', () => {
  it('handleMessageStart updates model', () => {
    const s = createStreamingState('old');
    handleMessageStart(s, 'new');
    expect(s.model).toBe('new');
  });

  it('handleContentBlockStart defaults kind to text when not given', () => {
    const s = createStreamingState('m');
    handleContentBlockStart(s, {});
    expect(s.currentTextIndex).toBe(0);
    expect(s.textBuffers).toEqual(['']);
    expect(s.blockOrder).toEqual([{ kind: 'text', idx: 0 }]);
  });

  it('handleContentBlockStart with tool_use generates an id when missing', () => {
    const s = createStreamingState('m');
    handleContentBlockStart(s, { kind: 'tool_use', name: 'tool' });
    expect(s.tools.size).toBe(1);
    const [id] = [...s.tools.keys()];
    expect(typeof id).toBe('string');
    expect(s.blockOrder[0]).toMatchObject({ kind: 'tool' });
  });

  it('handleContentBlockStart with thinking captures providerMeta', () => {
    const s = createStreamingState('m');
    handleContentBlockStart(s, { kind: 'thinking', providerMeta: { trace_id: 'abc' } });
    expect(s.thinking[0]?.providerMeta).toEqual({ trace_id: 'abc' });
    expect(s.blockOrder[0]).toEqual({ kind: 'thinking', idx: 0 });
  });

  it('handleContentBlockStop is a no-op (currently)', () => {
    const s = createStreamingState('m');
    const before = JSON.stringify(s);
    handleContentBlockStop(s, { index: 0 });
    expect(JSON.stringify(s)).toBe(before);
  });

  it('handleTextDelta opens a new text block when none is active', () => {
    const s = createStreamingState('m');
    handleTextDelta(s, 'hello');
    expect(s.textBuffers).toEqual(['hello']);
    expect(s.blockOrder).toEqual([{ kind: 'text', idx: 0 }]);
  });

  it('handleTextDelta appends to the currently-open text block', () => {
    const s = createStreamingState('m');
    handleContentBlockStart(s, {});
    handleTextDelta(s, 'hi ');
    handleTextDelta(s, 'there');
    expect(s.textBuffers).toEqual(['hi there']);
  });

  it('handleToolUseStart resets text index and registers the tool', () => {
    const s = createStreamingState('m');
    handleContentBlockStart(s, {}); // open a text block
    handleToolUseStart(s, { id: 't1', name: 'tool' });
    expect(s.currentTextIndex).toBe(-1);
    expect(s.tools.has('t1')).toBe(true);
  });

  it('handleToolUseInputDelta accumulates partial fragments', () => {
    const s = createStreamingState('m');
    handleToolUseStart(s, { id: 't1', name: 'tool' });
    handleToolUseInputDelta(s, { id: 't1', partial: '{"a":' });
    handleToolUseInputDelta(s, { id: 't1', partial: '1}' });
    expect(s.tools.get('t1')?.partial).toBe('{"a":1}');
  });

  it('handleToolUseStop uses provided input when given', () => {
    const s = createStreamingState('m');
    handleToolUseStart(s, { id: 't1', name: 'tool' });
    handleToolUseStop(s, { id: 't1', input: { z: 9 } });
    expect(s.tools.get('t1')?.input).toEqual({ z: 9 });
  });

  it('handleToolUseStop parses accumulated partial when input is omitted', () => {
    const s = createStreamingState('m');
    handleToolUseStart(s, { id: 't1', name: 'tool' });
    handleToolUseInputDelta(s, { id: 't1', partial: '{"a":2}' });
    handleToolUseStop(s, { id: 't1' });
    expect(s.tools.get('t1')?.input).toEqual({ a: 2 });
  });

  it('handleToolUseStop falls back to _raw on malformed JSON partial', () => {
    const s = createStreamingState('m');
    handleToolUseStart(s, { id: 't1', name: 'tool' });
    handleToolUseInputDelta(s, { id: 't1', partial: 'not-json' });
    handleToolUseStop(s, { id: 't1' });
    expect(s.tools.get('t1')?.input).toEqual({ _raw: 'not-json' });
  });

  it('handleToolUseStop on an unknown id is a no-op', () => {
    const s = createStreamingState('m');
    handleToolUseStop(s, { id: 'missing' });
    expect(s.tools.size).toBe(0);
  });

  it('safeJsonOrRaw returns {} for empty input', () => {
    expect(safeJsonOrRaw('')).toEqual({});
  });

  it('safeJsonOrRaw returns parsed object for valid JSON', () => {
    expect(safeJsonOrRaw('{"a":1}')).toEqual({ a: 1 });
  });

  it('safeJsonOrRaw wraps invalid JSON in { _raw }', () => {
    expect(safeJsonOrRaw('bad')).toEqual({ _raw: 'bad' });
  });

  it('handleThinkingDelta opens a thinking block if none is active', () => {
    const s = createStreamingState('m');
    handleThinkingDelta(s, 'thoughts');
    expect(s.thinking[0]?.textBuf).toBe('thoughts');
    expect(s.currentThinkingIndex).toBe(0);
  });

  it('handleThinkingSignature opens a thinking block if needed and sets signature', () => {
    const s = createStreamingState('m');
    handleThinkingSignature(s, 'sig-xyz');
    expect(s.thinking[0]?.signature).toBe('sig-xyz');
  });

  it('handleThinkingStop resets currentThinkingIndex', () => {
    const s = createStreamingState('m');
    handleThinkingStart(s, {});
    expect(s.currentThinkingIndex).toBe(0);
    handleThinkingStop(s);
    expect(s.currentThinkingIndex).toBe(-1);
  });

  it('handleMessageStop applies stopReason and usage when provided', () => {
    const s = createStreamingState('m');
    handleMessageStop(s, { stopReason: 'max_tokens', usage: { input: 5, output: 3 } });
    expect(s.stopReason).toBe('max_tokens');
    expect(s.usage).toEqual({ input: 5, output: 3 });
  });

  it('handleMessageStop without args keeps defaults', () => {
    const s = createStreamingState('m');
    handleMessageStop(s, {});
    expect(s.stopReason).toBe('end_turn');
    expect(s.usage).toEqual({ input: 0, output: 0 });
  });
});

describe('streamProviderToResponse', () => {
  it('builds a complete response from a normal stream', async () => {
    const events: Array<Record<string, unknown>> = [
      { type: 'message_start', model: 'm' },
      { type: 'content_block_start', kind: 'text' },
      { type: 'text_delta', text: 'hello ' },
      { type: 'text_delta', text: 'world' },
      { type: 'content_block_stop', index: 0 },
      { type: 'tool_use_start', id: 't1', name: 'doit' },
      { type: 'tool_use_input_delta', id: 't1', partial: '{"x":' },
      { type: 'tool_use_input_delta', id: 't1', partial: '1}' },
      { type: 'tool_use_stop', id: 't1' },
      { type: 'message_stop', stopReason: 'end_turn', usage: { input: 10, output: 5 } },
    ];
    const ctrl = new AbortController();
    const r = await streamProviderToResponse(
      fakeProvider(events),
      req,
      ctrl.signal,
      fakeCtx,
      new EventBus(),
      noopLogger,
    );
    const textBlock = r.content.find((b) => b.type === 'text');
    expect(textBlock).toEqual({ type: 'text', text: 'hello world' });
    const toolBlock = r.content.find((b) => b.type === 'tool_use');
    expect(toolBlock).toMatchObject({ type: 'tool_use', id: 't1', name: 'doit', input: { x: 1 } });
    expect(r.usage).toEqual({ input: 10, output: 5 });
  });

  it('handles thinking deltas and signature', async () => {
    const events: Array<Record<string, unknown>> = [
      { type: 'message_start', model: 'm' },
      { type: 'thinking_start' },
      { type: 'thinking_delta', text: 'pondering' },
      { type: 'thinking_signature', signature: 'sig1' },
      { type: 'thinking_stop' },
      { type: 'message_stop' },
    ];
    const ctrl = new AbortController();
    const r = await streamProviderToResponse(
      fakeProvider(events),
      req,
      ctrl.signal,
      fakeCtx,
      new EventBus(),
      noopLogger,
    );
    const thinkBlock = r.content.find((b) => b.type === 'thinking');
    expect(thinkBlock).toMatchObject({
      type: 'thinking',
      thinking: 'pondering',
      signature: 'sig1',
    });
  });

  it('returns partial state when the signal is aborted mid-stream', async () => {
    const ctrl = new AbortController();
    const provider: Provider = {
      id: 'aborting',
      capabilities: { streaming: true, tools: false, vision: false, reasoning: false },
      async complete() {
        throw new Error('not used');
      },
      async *stream() {
        yield { type: 'message_start', model: 'm' } as never;
        yield { type: 'content_block_start', kind: 'text' } as never;
        yield { type: 'text_delta', text: 'partial-text' } as never;
        // Now abort and throw — emulating provider responding to abort
        ctrl.abort();
        throw new Error('aborted');
      },
    };
    const r = await streamProviderToResponse(
      provider,
      req,
      ctrl.signal,
      fakeCtx,
      new EventBus(),
      noopLogger,
    );
    // Partial text was preserved even though stream threw
    const text = r.content.find((b) => b.type === 'text');
    expect(text).toEqual({ type: 'text', text: 'partial-text' });
    expect(r.stopReason).toBe('end_turn');
  });

  it('rethrows non-abort stream errors', async () => {
    const provider: Provider = {
      id: 'crashy',
      capabilities: { streaming: true, tools: false, vision: false, reasoning: false },
      async complete() {
        throw new Error('not used');
      },
      async *stream() {
        yield { type: 'message_start', model: 'm' } as never;
        throw new Error('upstream-failure');
      },
    };
    const ctrl = new AbortController();
    await expect(
      streamProviderToResponse(provider, req, ctrl.signal, fakeCtx, new EventBus(), noopLogger),
    ).rejects.toThrow(/upstream-failure/);
  });

  it('emits expected EventBus events during streaming', async () => {
    const events: Array<Record<string, unknown>> = [
      { type: 'message_start', model: 'm' },
      { type: 'text_delta', text: 'a' },
      { type: 'tool_use_start', id: 't1', name: 'doit' },
      { type: 'tool_use_stop', id: 't1' },
      { type: 'thinking_delta', text: 'b' },
      { type: 'message_stop' },
    ];
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('provider.text_delta', () => seen.push('text'));
    bus.on('provider.tool_use_start', () => seen.push('tool_start'));
    bus.on('provider.tool_use_stop', () => seen.push('tool_stop'));
    bus.on('provider.thinking_delta', () => seen.push('think'));
    const ctrl = new AbortController();
    await streamProviderToResponse(
      fakeProvider(events),
      req,
      ctrl.signal,
      fakeCtx,
      bus,
      noopLogger,
    );
    expect(seen).toEqual(['text', 'tool_start', 'tool_stop', 'think']);
  });

  it('batches text_delta emissions to reduce fan-out', async () => {
    // 8 text deltas with batch-size 4 should yield exactly 2 emits.
    const events: Array<Record<string, unknown>> = [
      { type: 'message_start', model: 'm' },
      { type: 'text_delta', text: '1' },
      { type: 'text_delta', text: '2' },
      { type: 'text_delta', text: '3' },
      { type: 'text_delta', text: '4' },
      { type: 'text_delta', text: '5' },
      { type: 'text_delta', text: '6' },
      { type: 'text_delta', text: '7' },
      { type: 'text_delta', text: '8' },
      { type: 'message_stop' },
    ];
    const bus = new EventBus();
    const texts: string[] = [];
    bus.on('provider.text_delta', (p) => texts.push(p.text));
    const ctrl = new AbortController();
    await streamProviderToResponse(
      fakeProvider(events),
      req,
      ctrl.signal,
      fakeCtx,
      bus,
      noopLogger,
    );
    // 8 deltas batched at 4 = 2 emits, each containing concatenated text.
    expect(texts).toEqual(['1234', '5678']);
  });

  it('flushes remaining text deltas at stream end', async () => {
    // 3 deltas (< batch-size 4) should still flush as 1 emit at the end.
    const events: Array<Record<string, unknown>> = [
      { type: 'message_start', model: 'm' },
      { type: 'text_delta', text: 'a' },
      { type: 'text_delta', text: 'b' },
      { type: 'text_delta', text: 'c' },
      { type: 'message_stop' },
    ];
    const bus = new EventBus();
    const texts: string[] = [];
    bus.on('provider.text_delta', (p) => texts.push(p.text));
    const ctrl = new AbortController();
    await streamProviderToResponse(
      fakeProvider(events),
      req,
      ctrl.signal,
      fakeCtx,
      bus,
      noopLogger,
    );
    expect(texts).toEqual(['abc']);
  });

  it('flushes pending text before a tool_use_start event', async () => {
    const events: Array<Record<string, unknown>> = [
      { type: 'message_start', model: 'm' },
      { type: 'text_delta', text: 'hello' },
      { type: 'tool_use_start', id: 't1', name: 'doit' },
      { type: 'tool_use_stop', id: 't1' },
      { type: 'message_stop' },
    ];
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('provider.text_delta', (p) => seen.push(`text:${p.text}`));
    bus.on('provider.tool_use_start', () => seen.push('tool_start'));
    const ctrl = new AbortController();
    await streamProviderToResponse(
      fakeProvider(events),
      req,
      ctrl.signal,
      fakeCtx,
      bus,
      noopLogger,
    );
    // Text must appear before tool_start to preserve event ordering.
    expect(seen).toEqual(['text:hello', 'tool_start']);
  });
});
