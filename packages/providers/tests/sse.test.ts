import type { StreamEvent } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { aggregateStream } from '../src/aggregate.js';
import { createSseLineFoldingTransform, parseSSE } from '../src/sse.js';

function bodyFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

describe('parseSSE', () => {
  it('parses single event with named type and data', async () => {
    const body = bodyFrom(['event: message_start\ndata: {"type":"message_start"}\n\n']);
    const events = [];
    for await (const msg of parseSSE(body)) events.push(msg);
    expect(events).toEqual([{ event: 'message_start', data: '{"type":"message_start"}' }]);
  });

  it('accumulates multi-line data fields', async () => {
    const body = bodyFrom(['data: line1\ndata: line2\n\n']);
    const events = [];
    for await (const msg of parseSSE(body)) events.push(msg);
    expect(events).toEqual([{ event: 'message', data: 'line1\nline2' }]);
  });

  it('ignores comments and unknown fields', async () => {
    const body = bodyFrom([':keepalive\nretry: 1000\nid: 7\ndata: x\n\n']);
    const events = [];
    for await (const msg of parseSSE(body)) events.push(msg);
    expect(events).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('handles chunks that split mid-line', async () => {
    const body = bodyFrom(['event: a\ndata: hel', 'lo\n\nev', 'ent: b\ndata: world\n\n']);
    const events = [];
    for await (const msg of parseSSE(body)) events.push(msg);
    expect(events).toEqual([
      { event: 'a', data: 'hello' },
      { event: 'b', data: 'world' },
    ]);
  });

  it('handles UTF-8 code points split across chunks without corrupting lines', async () => {
    const enc = new TextEncoder();
    const full = enc.encode('data: 😀\n\n');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(full.subarray(0, 7));
        controller.enqueue(full.subarray(7));
        controller.close();
      },
    });
    const events = [];
    for await (const msg of parseSSE(body)) events.push(msg);
    expect(events).toEqual([{ event: 'message', data: '😀' }]);
  });

  it('handles CRLF line endings', async () => {
    const body = bodyFrom(['event: x\r\ndata: y\r\n\r\n']);
    const events = [];
    for await (const msg of parseSSE(body)) events.push(msg);
    expect(events).toEqual([{ event: 'x', data: 'y' }]);
  });

  it('handles CRLF line endings split across chunk boundaries (BIZ-008)', async () => {
    // \r is the last byte of chunk 1, \n is the first byte of chunk 2
    const body = bodyFrom(['event: message_stop\r', '\ndata: {"stop":true}\r', '\n\r', '\n']);
    const events = [];
    for await (const msg of parseSSE(body)) events.push(msg);
    expect(events).toEqual([{ event: 'message_stop', data: '{"stop":true}' }]);
  });

  it('parseSSE handles trailing content after final event with no blank line', async () => {
    // Lines 114-116: after the loop, if buffer has content it should be flushed.
    // A trailing data: line (even without a trailing \n in that chunk) still
    // gets processed by processLine at line 115.
    const body = bodyFrom(['event: x\ndata: end\nflush-me']);
    const events = [];
    for await (const msg of parseSSE(body)) events.push(msg);
    // event x flushes on blank line; then 'flush-me' is in buffer at loop end
    // processLine('flush-me') → '' (no colon) → undefined, but flush() at 118
    // also returns undefined since event='message' and dataLines=[]
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: 'x', data: 'end' });
  });

  it('parseSSE handles empty body (null)', async () => {
    const events = [];
    for await (const msg of parseSSE(null)) events.push(msg);
    expect(events).toHaveLength(0);
  });

  it('parseSSE reads web ReadableStream via getReader path (lines 94-112)', async () => {
    // Lines 94-112: the else branch uses body.getReader() — exercises the
    // web ReadableStream path. A properly formed SSE body should yield events.
    const body = bodyFrom(['event: web\ndata: streamed\n\n']);
    const events = [];
    for await (const msg of parseSSE(body)) events.push(msg);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: 'web', data: 'streamed' });
  });

  it('parseSSE cancels the web stream body when the consumer exits early', async () => {
    let cancelled = false;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        // Two complete events, then the stream stays open (never closed) —
        // a real body a consumer may abandon mid-way.
        c.enqueue(enc.encode('data: {"a":1}\n\n'));
        c.enqueue(enc.encode('data: {"b":2}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const iterator = parseSSE(body)[Symbol.asyncIterator]();
    await iterator.next(); // pull the first event, then abandon iteration
    await iterator.return?.(undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled).toBe(true);
  });
});

async function readAll(rs: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder();
  const reader = rs.getReader();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += dec.decode(value, { stream: true });
  }
  return out;
}

describe('createSseLineFoldingTransform', () => {
  it('passes small lines through unchanged', async () => {
    const src = bodyFrom(['data: hello\n\n']);
    const folded = createSseLineFoldingTransform(src, 200);
    const out = await readAll(folded);
    expect(out).toBe('data: hello\n\n');
  });

  it('folds a single oversized JSON data: line into multiple data: lines that parse back to the same object', async () => {
    const bigPayload = {
      items: Array.from({ length: 30_000 }, (_, i) => ({ id: i, text: 'x'.repeat(16) })),
    };
    const sse = `data: ${JSON.stringify(bigPayload)}\n\n`;
    const src = bodyFrom([sse]);
    const folded = createSseLineFoldingTransform(src, 200 * 1024);
    const events: { event: string; data: string }[] = [];
    for await (const msg of parseSSE(folded)) events.push(msg);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('message');
    expect(JSON.parse(events[0]?.data ?? 'null')).toEqual(bigPayload);
  });

  it('never folds non-data fields (event:, id:, retry:, comments)', async () => {
    // event:/id:/retry: lines must remain single-line per SSE spec.
    const eventName = 'e'.repeat(300 * 1024);
    const src = bodyFrom([`event: ${eventName}\ndata: short\n\n`]);
    const folded = createSseLineFoldingTransform(src, 200 * 1024);
    await expect(async () => {
      for await (const _msg of parseSSE(folded)) {
        // drain
      }
    }).rejects.toThrow(/pending line exceeds/);
  });

  it('folds JSON data: lines split across multiple chunks', async () => {
    // Each individual chunk is small, but the line spans multiple chunks and
    // still needs one safe fold before parseSSE consumes it.
    const bigPayload = {
      items: Array.from({ length: 6_500 }, (_, i) => ({ id: i, text: 'y'.repeat(16) })),
    };
    const json = JSON.stringify(bigPayload);
    const splitAt = 120 * 1024;
    const head = `data: ${json.slice(0, splitAt)}`;
    const tail = json.slice(splitAt);
    const src = bodyFrom([head, `${tail}\n\n`]);
    const folded = createSseLineFoldingTransform(src, 150 * 1024);
    const events: { event: string; data: string }[] = [];
    for await (const msg of parseSSE(folded)) events.push(msg);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]?.data ?? 'null')).toEqual(bigPayload);
  });
});

async function* arr<T>(items: T[]): AsyncIterable<T> {
  for (const i of items) yield i;
}

describe('aggregateStream', () => {
  it('builds a text-only Response from text_delta sequence', async () => {
    const events: StreamEvent[] = [
      { type: 'message_start', model: 'm' },
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
      { type: 'message_stop', stopReason: 'end_turn', usage: { input: 5, output: 2 } },
    ];
    const res = await aggregateStream(arr(events));
    expect(res.content).toEqual([{ type: 'text', text: 'Hello world' }]);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage).toEqual({ input: 5, output: 2 });
    expect(res.model).toBe('m');
  });

  it('accumulates tool_use input from partial JSON deltas', async () => {
    const events: StreamEvent[] = [
      { type: 'message_start', model: 'm' },
      { type: 'tool_use_start', id: 'u1', name: 'echo' },
      { type: 'tool_use_input_delta', id: 'u1', partial: '{"text":' },
      { type: 'tool_use_input_delta', id: 'u1', partial: '"hi"}' },
      { type: 'tool_use_stop', id: 'u1', input: undefined as unknown },
      { type: 'message_stop', stopReason: 'tool_use', usage: { input: 5, output: 2 } },
    ];
    const res = await aggregateStream(arr(events));
    expect(res.content).toEqual([
      { type: 'tool_use', id: 'u1', name: 'echo', input: { text: 'hi' } },
    ]);
    expect(res.stopReason).toBe('tool_use');
  });

  it('preserves text + tool_use block order', async () => {
    const events: StreamEvent[] = [
      { type: 'message_start', model: 'm' },
      { type: 'text_delta', text: 'thinking' },
      { type: 'tool_use_start', id: 't1', name: 'fn' },
      { type: 'tool_use_stop', id: 't1', input: { x: 1 } },
      { type: 'text_delta', text: 'done' },
      { type: 'message_stop', stopReason: 'end_turn', usage: { input: 5, output: 2 } },
    ];
    const res = await aggregateStream(arr(events));
    expect(res.content).toEqual([
      { type: 'text', text: 'thinking' },
      { type: 'tool_use', id: 't1', name: 'fn', input: { x: 1 } },
      { type: 'text', text: 'done' },
    ]);
  });

  it('calls onEvent for every event in order', async () => {
    const events: StreamEvent[] = [
      { type: 'message_start', model: 'm' },
      { type: 'text_delta', text: 'a' },
      { type: 'message_stop', stopReason: 'end_turn', usage: { input: 0, output: 0 } },
    ];
    const seen: string[] = [];
    await aggregateStream(arr(events), (e) => seen.push(e.type));
    expect(seen).toEqual(['message_start', 'text_delta', 'message_stop']);
  });

  it('aggregateStream handles thinking_signature without preceding thinking_start (lines 104-111)', async () => {
    // Lines 105-107: when currentThinkingIndex === -1, thinking_signature defensively
    // re-initializes a thinking buffer. This tests that orphan thinking_signature
    // events (no prior thinking_start) are handled without crashing.
    const events: StreamEvent[] = [
      { type: 'message_start', model: 'm' },
      // thinking_signature without a preceding thinking_start
      { type: 'thinking_signature', signature: 'sig123' },
      { type: 'thinking_delta', text: 'some reasoning' },
      { type: 'thinking_stop' },
      { type: 'message_stop', stopReason: 'end_turn', usage: { input: 0, output: 0 } },
    ];
    const res = await aggregateStream(arr(events));
    // Should produce a thinking block with the signature
    expect(res.content).toHaveLength(1);
    const block = res.content[0] as { type: 'thinking'; thinking: string; signature?: string };
    expect(block.type).toBe('thinking');
    expect(block.thinking).toBe('some reasoning');
    expect(block.signature).toBe('sig123');
  });

  it('aggregateStream preserves providerMeta on thinking blocks (line 137)', async () => {
    // Line 137: providerMeta is copied to the thinking content block when non-empty.
    const events: StreamEvent[] = [
      { type: 'message_start', model: 'm' },
      {
        type: 'thinking_start',
        providerMeta: { tokens: 42, model: 'o3' },
      },
      { type: 'thinking_delta', text: 'reasoning content' },
      { type: 'thinking_stop' },
      { type: 'message_stop', stopReason: 'end_turn', usage: { input: 0, output: 0 } },
    ];
    const res = await aggregateStream(arr(events));
    expect(res.content).toHaveLength(1);
    const block = res.content[0] as { type: 'thinking'; providerMeta?: Record<string, unknown> };
    expect(block.type).toBe('thinking');
    expect(block.providerMeta).toEqual({ tokens: 42, model: 'o3' });
  });

  it('aggregateStream preserves providerMeta on tool_use blocks (line 153)', async () => {
    // Line 153: providerMeta is copied to the tool_use content block when non-empty.
    const events: StreamEvent[] = [
      { type: 'message_start', model: 'm' },
      { type: 'tool_use_start', id: 'u1', name: 'echo' },
      { type: 'tool_use_input_delta', id: 'u1', partial: '"hi"' },
      {
        type: 'tool_use_stop',
        id: 'u1',
        providerMeta: { latency: 12.5 },
      },
      { type: 'message_stop', stopReason: 'tool_use', usage: { input: 0, output: 0 } },
    ];
    const res = await aggregateStream(arr(events));
    expect(res.content).toHaveLength(1);
    const block = res.content[0] as { type: 'tool_use'; providerMeta?: Record<string, unknown> };
    expect(block.type).toBe('tool_use');
    expect(block.providerMeta).toEqual({ latency: 12.5 });
  });
});
