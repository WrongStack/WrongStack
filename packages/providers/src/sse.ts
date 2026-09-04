import { ParseError } from '@wrongstack/core/types';
import { isNodeReadable } from './object-utils.js';

/**
 * Minimal Server-Sent Events parser for HTTP streaming responses.
 *
 * Yields parsed events as `{ event, data }` pairs. Per spec:
 *   - Each event is separated by a blank line
 *   - `event: foo` sets the event name (defaults to "message")
 *   - `data: ...` lines accumulate into the data buffer
 *   - `:` lines are comments and ignored
 *   - `id` / `retry` fields are accepted and ignored
 *
 * For Anthropic the wire format is canonical SSE with explicit `event:` lines.
 * For OpenAI / OpenAI-compatible the format omits `event:` and just emits
 * `data: <json>` chunks, with a final `data: [DONE]`. Both work with this
 * parser; consumers branch on event name or just on `data`.
 */
export interface SSEMessage {
  event: string;
  data: string;
}

/**
 * Cap on the unconsumed buffer (pending tail). A malicious or buggy upstream
 * that sends megabytes without a newline could otherwise pin a worker.
 * 256 KB comfortably accommodates any sane SSE event while ensuring we fail
 * fast on garbage.
 */
const MAX_BUFFER_BYTES = 256 * 1024;
const TEXT_DECODER = new TextDecoder('utf-8');
const TEXT_ENCODER = new TextEncoder();

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(new ArrayBuffer(a.length + b.length));
  out.set(a);
  out.set(b, a.length);
  return out;
}

function decodeLine(bytes: Uint8Array): string {
  return TEXT_DECODER.decode(bytes);
}

function findJsonSafeSplit(payload: Uint8Array, start: number, maxLineBytes: number): number {
  const hardEnd = Math.min(start + maxLineBytes, payload.length);
  let inString = false;
  let escaped = false;
  let lastSafe = -1;
  // If the window ends inside a JSON string, extend the scan a little so the
  // split lands *after* the closing quote rather than slicing through an
  // escaped sequence. The extra scan is capped at 4 KiB to keep us safe
  // against pathological or hostile payloads; if we still haven't found a
  // close, we fall back to the byte boundary and let parseSSE surface the
  // parse error with the original diagnostic intact.
  let lastStringEnd = -1;

  const step = (i: number): void => {
    const byte = payload[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (byte === 0x5c) {
        escaped = true;
      } else if (byte === 0x22) {
        inString = false;
        lastStringEnd = i + 1;
      }
      return;
    }

    if (byte === 0x22) {
      inString = true;
      return;
    }
    if (byte === 0x2c || byte === 0x7d || byte === 0x5d) {
      lastSafe = i + 1;
    }
  };

  for (let i = start; i < hardEnd; i++) step(i);

  if (lastSafe <= start && inString) {
    const cap = Math.min(payload.length, hardEnd + 4096);
    for (let i = hardEnd; i < cap && inString; i++) step(i);
  }

  if (lastSafe > start) return lastSafe;
  if (lastStringEnd > start) return lastStringEnd;
  return hardEnd;
}

export async function* parseSSE(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
): AsyncIterable<SSEMessage> {
  if (!body) return;

  let pending: Uint8Array = new Uint8Array(0);
  let skipLeadingLf = false;
  let event = 'message';
  const dataLines: string[] = [];

  const flush = (): SSEMessage | undefined => {
    if (dataLines.length === 0 && event === 'message') return undefined;
    const data = dataLines.join('\n');
    const msg: SSEMessage = { event, data };
    event = 'message';
    dataLines.length = 0;
    return msg;
  };

  const processLine = (line: string): SSEMessage | undefined => {
    if (line === '') return flush();
    if (line.startsWith(':')) return undefined;
    const colonIdx = line.indexOf(':');
    let field: string;
    let value: string;
    if (colonIdx === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colonIdx);
      value = line.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    if (field === 'event') event = value || 'message';
    else if (field === 'data') dataLines.push(value);
    return undefined;
  };

  const consumeChunk = (chunk: Uint8Array): SSEMessage[] => {
    if (chunk.length === 0) return [];

    const out: SSEMessage[] = [];
    let lineStart = 0;
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i]!;
      if (skipLeadingLf && i === lineStart) {
        skipLeadingLf = false;
        if (byte === 0x0a) {
          lineStart = i + 1;
          continue;
        }
      }
      if (byte !== 0x0a && byte !== 0x0d) continue;
      const lineEnd = i;
      const lineBytes = chunk.subarray(lineStart, lineEnd);
      let completeLine = pending.length === 0 ? lineBytes : concatBytes(pending, lineBytes);
      if (completeLine.length > 0 && completeLine[completeLine.length - 1] === 0x0d) {
        completeLine = completeLine.subarray(0, completeLine.length - 1);
      }
      pending = new Uint8Array(0);
      lineStart = i + 1;
      skipLeadingLf = byte === 0x0d;
      const msg = processLine(decodeLine(completeLine));
      if (msg) out.push(msg);
    }

    const tail = chunk.subarray(lineStart);
    pending = pending.length === 0 ? new Uint8Array(tail) : concatBytes(pending, tail);
    if (pending.length > MAX_BUFFER_BYTES) {
      throw new ParseError({
        message: `SSE: pending line exceeds ${MAX_BUFFER_BYTES} bytes — upstream is not framing events`,
        source: 'sse',
      });
    }
    return out;
  };

  const asBytes = (chunk: unknown): Uint8Array => {
    if (typeof chunk === 'string') return TEXT_ENCODER.encode(chunk);
    if (chunk instanceof Uint8Array) return chunk;
    return new Uint8Array(
      (chunk as Buffer).buffer,
      (chunk as Buffer).byteOffset,
      (chunk as Buffer).byteLength,
    );
  };

  if (isNodeReadable(body)) {
    for await (const chunk of body as NodeJS.ReadableStream) {
      for (const msg of consumeChunk(asBytes(chunk))) yield msg;
    }
  } else {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (const msg of consumeChunk(value)) yield msg;
      }
    } finally {
      // cancel(), not just releaseLock(): an early consumer exit — break/throw/
      // return out of the generator that drives parseSSE — must close the HTTP
      // body, otherwise the socket stays open until the outer AbortSignal (if
      // any) fires. cancel() also releases the lock; on a fully-drained stream
      // it is a harmless no-op.
      void reader.cancel().catch(() => {});
    }
  }

  if (pending.length > 0) {
    const line =
      pending[pending.length - 1] === 0x0d
        ? decodeLine(pending.subarray(0, pending.length - 1))
        : decodeLine(pending);
    const msg = processLine(line);
    if (msg) yield msg;
  }
  const final = flush();
  if (final) yield final;
}

/**
 * SSE line-folding transform stream.
 *
 * Wraps an upstream `ReadableStream<Uint8Array>` so oversized `data:` fields
 * are split into multiple `data:` lines at JSON-safe boundaries. `parseSSE`
 * rejoins those lines with `\n`, which preserves semantic content for the
 * structured JSON envelopes emitted by provider streams while keeping the
 * per-line pending buffer under the safety cap.
 */
export function createSseLineFoldingTransform(
  source: ReadableStream<Uint8Array>,
  maxLineBytes = 200 * 1024,
): ReadableStream<Uint8Array> {
  if (maxLineBytes <= 0) return source;

  const encoder = new TextEncoder();
  let lineBuf = new Uint8Array(0);

  const emitFoldedDataLine = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    payload: Uint8Array,
  ): void => {
    let offset = 0;
    while (offset < payload.length) {
      controller.enqueue(encoder.encode('data:'));
      const end = findJsonSafeSplit(payload, offset, maxLineBytes);
      controller.enqueue(payload.subarray(offset, end));
      controller.enqueue(encoder.encode('\n'));
      offset = end;
    }
  };

  const emitLine = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    line: Uint8Array,
  ): void => {
    const isData =
      line.length >= 5 &&
      line[0] === 0x64 &&
      line[1] === 0x61 &&
      line[2] === 0x74 &&
      line[3] === 0x61 &&
      line[4] === 0x3a;
    if (isData && line.length > maxLineBytes) {
      emitFoldedDataLine(controller, line.subarray(5));
      return;
    }
    controller.enqueue(line);
    controller.enqueue(encoder.encode('\n'));
  };

  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Drain the source until we have emitted at least one chunk OR the
      // source is exhausted. Without the inner loop, a chunk that only
      // carries a partial line (no `\n` yet) would return from `pull`
      // without enqueueing anything, and the consumer would block forever
      // because Web Streams only re-invokes `pull` once the previous call
      // made progress.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          if (lineBuf.length > 0) {
            controller.enqueue(lineBuf);
          }
          controller.close();
          return;
        }
        if (!value || value.length === 0) continue;

        let chunkStart = 0;
        let emittedThisChunk = false;
        for (let i = 0; i < value.length; i++) {
          if (value[i] !== 0x0a) continue;
          const isCr = i > chunkStart && value[i - 1] === 0x0d;
          const lineEnd = isCr ? i - 1 : i;
          const lineTail = value.subarray(chunkStart, lineEnd);
          let line =
            lineBuf.length === 0 ? Uint8Array.from(lineTail) : concatBytes(lineBuf, lineTail);
          if (line.length > 0 && line[line.length - 1] === 0x0d) {
            line = line.subarray(0, line.length - 1);
          }
          lineBuf = new Uint8Array(0);
          emitLine(controller, line);
          emittedThisChunk = true;
          chunkStart = i + 1;
        }

        if (chunkStart < value.length) {
          const tail = value.subarray(chunkStart);
          if (lineBuf.length === 0) {
            const copiedTail = new Uint8Array(new ArrayBuffer(tail.length));
            copiedTail.set(tail);
            lineBuf = copiedTail;
          } else {
            const merged = concatBytes(lineBuf, tail);
            lineBuf = new Uint8Array(new ArrayBuffer(merged.length));
            lineBuf.set(merged);
          }
        }

        // Made progress (at least one complete line was forwarded) — let the
        // consumer drain before we go back to the source for more. Otherwise
        // (no `\n` in this chunk, partial line still buffered) loop and read
        // the next chunk synchronously to avoid the no-progress deadlock.
        if (emittedThisChunk) return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
