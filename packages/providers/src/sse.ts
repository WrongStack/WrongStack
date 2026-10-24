import { ParseError } from '@wrongstack/contracts/types';
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
 * that sends megabytes without a newline could otherwise grow it unbounded.
 *
 * It must still fit one legitimate event: Gemini delivers a `functionCall`
 * with its complete `args` in a single `data:` line, so a `write` of a few
 * hundred KB of source is one line. The old 256 KB cap failed exactly those
 * turns (and every retry of them). The tail is buffered as a chunk list and
 * joined once, so a large line costs O(n), not O(n²) re-copying.
 */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const TEXT_DECODER = new TextDecoder('utf-8');
const TEXT_ENCODER = new TextEncoder();

function decodeLine(bytes: Uint8Array): string {
  return TEXT_DECODER.decode(bytes);
}

/** JSON lexer position carried between fold windows of one payload. */
interface JsonScanState {
  inString: boolean;
  escaped: boolean;
}

function findJsonSafeSplit(
  payload: Uint8Array,
  start: number,
  maxLineBytes: number,
  scan: JsonScanState,
): number {
  const hardEnd = Math.min(start + maxLineBytes, payload.length);
  // Resume the lexer where the previous window stopped. Restarting every
  // window at "outside a string" misread any window that began inside a long
  // string value: escaped quotes flipped the state and the "safe" split landed
  // inside the string, so the rejoined JSON failed to parse and the event was
  // silently dropped.
  let inString = scan.inString;
  let escaped = scan.escaped;
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
  const atHardEnd: JsonScanState = { inString, escaped };

  if (lastSafe <= start && inString) {
    const cap = Math.min(payload.length, hardEnd + 4096);
    for (let i = hardEnd; i < cap && inString; i++) step(i);
  }

  // Both safe split kinds sit outside any string.
  if (lastSafe > start || lastStringEnd > start) {
    scan.inString = false;
    scan.escaped = false;
    return lastSafe > start ? lastSafe : lastStringEnd;
  }
  scan.inString = atHardEnd.inString;
  scan.escaped = atHardEnd.escaped;
  return hardEnd;
}

export async function* parseSSE(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
): AsyncIterable<SSEMessage> {
  if (!body) return;

  // Unterminated line tail, kept as a chunk list and joined once at the newline.
  const pendingParts: Uint8Array[] = [];
  let pendingLength = 0;
  const takePending = (tail: Uint8Array): Uint8Array => {
    if (pendingParts.length === 0) return tail;
    const out = new Uint8Array(new ArrayBuffer(pendingLength + tail.length));
    let at = 0;
    for (const part of pendingParts) {
      out.set(part, at);
      at += part.length;
    }
    out.set(tail, at);
    pendingParts.length = 0;
    pendingLength = 0;
    return out;
  };
  let skipLeadingLf = false;
  let event = 'message';
  const dataLines: string[] = [];
  let eventBytes = 0;

  const flush = (): SSEMessage | undefined => {
    if (dataLines.length === 0 && event === 'message') return undefined;
    const data = dataLines.join('\n');
    const msg: SSEMessage = { event, data };
    event = 'message';
    dataLines.length = 0;
    eventBytes = 0;
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
    else if (field === 'data') {
      eventBytes += TEXT_ENCODER.encode(value).byteLength + (dataLines.length > 0 ? 1 : 0);
      if (eventBytes > MAX_BUFFER_BYTES) {
        throw new ParseError({
          message: `SSE: event data exceeds ${MAX_BUFFER_BYTES} bytes — upstream is not framing events`,
          source: 'sse',
        });
      }
      dataLines.push(value);
    }
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
      if (pendingLength + lineBytes.length > MAX_BUFFER_BYTES) {
        throw new ParseError({
          message: `SSE: pending line exceeds ${MAX_BUFFER_BYTES} bytes — upstream is not framing events`,
          source: 'sse',
        });
      }
      let completeLine = takePending(lineBytes);
      if (completeLine.length > 0 && completeLine[completeLine.length - 1] === 0x0d) {
        completeLine = completeLine.subarray(0, completeLine.length - 1);
      }
      lineStart = i + 1;
      skipLeadingLf = byte === 0x0d;
      const msg = processLine(decodeLine(completeLine));
      if (msg) out.push(msg);
    }

    if (lineStart < chunk.length) {
      // Copy: the source chunk may be a reused/transferred buffer.
      pendingParts.push(new Uint8Array(chunk.subarray(lineStart)));
      pendingLength += chunk.length - lineStart;
    }
    if (pendingLength > MAX_BUFFER_BYTES) {
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
    const nodeStream = body as NodeJS.ReadableStream & {
      destroy?: (err?: Error) => void;
      destroyed?: boolean;
      readableEnded?: boolean;
      [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
    };
    try {
      if (typeof nodeStream[Symbol.asyncIterator] === 'function') {
        for await (const chunk of body as NodeJS.ReadableStream) {
          for (const msg of consumeChunk(asBytes(chunk))) yield msg;
        }
      } else {
        const chunks: Uint8Array[] = [];
        let ended = nodeStream.readableEnded === true;
        let error: Error | null = null;
        let resume: (() => void) | null = null;

        const onData = (chunk: unknown) => {
          chunks.push(asBytes(chunk));
          resume?.();
        };
        const onEnd = () => {
          ended = true;
          resume?.();
        };
        const onError = (err: Error) => {
          error = err;
          resume?.();
        };
        const onClose = () => {
          if (!ended && !error) {
            error = Object.assign(new Error('SSE stream closed before end.'), {
              code: 'ERR_STREAM_PREMATURE_CLOSE',
            });
          }
          resume?.();
        };

        nodeStream.on('data', onData);
        nodeStream.on('end', onEnd);
        nodeStream.on('error', onError);
        nodeStream.on('close', onClose);
        // A close/end that happened before listener registration will not replay.
        if (nodeStream.destroyed) onClose();

        try {
          while (!ended || chunks.length > 0) {
            // An 'error' emitted while the consumer was busy with a yielded
            // message found `resume` null; awaiting now would never resolve.
            if (error) throw error;
            if (chunks.length === 0) {
              await new Promise<void>((r) => {
                resume = r;
              });
              resume = null;
            }
            if (error) throw error;
            while (chunks.length > 0) {
              const nextChunk = chunks.shift()!;
              for (const msg of consumeChunk(nextChunk)) yield msg;
            }
          }
        } finally {
          nodeStream.removeListener?.('data', onData);
          nodeStream.removeListener?.('end', onEnd);
          nodeStream.removeListener?.('error', onError);
          nodeStream.removeListener?.('close', onClose);
        }
      }
    } finally {
      if (typeof nodeStream.destroy === 'function') {
        nodeStream.destroy();
      }
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
      // any) fires. Cancellation does not release a reader's lock. Release it
      // explicitly without waiting for a possibly slow upstream cancel hook.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  if (pendingLength > 0) {
    const pending = takePending(new Uint8Array(0));
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
  // Unterminated line, kept as a chunk list and joined once at its newline —
  // same scheme as parseSSE. Re-concatenating the whole buffer per chunk was
  // O(n²) for one large event (a Codex `response.completed`).
  const lineParts: Uint8Array[] = [];
  let lineLength = 0;
  const assertLineBudget = (length: number): void => {
    if (length > MAX_BUFFER_BYTES) {
      throw new ParseError({
        message: `SSE: folding line exceeds ${MAX_BUFFER_BYTES} bytes — upstream is not framing events`,
        source: 'sse',
      });
    }
  };
  const takeLine = (tail: Uint8Array): Uint8Array => {
    assertLineBudget(lineLength + tail.length);
    const out = new Uint8Array(new ArrayBuffer(lineLength + tail.length));
    let at = 0;
    for (const part of lineParts) {
      out.set(part, at);
      at += part.length;
    }
    out.set(tail, at);
    lineParts.length = 0;
    lineLength = 0;
    return out;
  };
  let skipLeadingLf = false;

  const emitFoldedDataLine = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    payload: Uint8Array,
  ): void => {
    let offset = 0;
    const scan: JsonScanState = { inString: false, escaped: false };
    while (offset < payload.length) {
      controller.enqueue(encoder.encode('data:'));
      let end = findJsonSafeSplit(payload, offset, maxLineBytes, scan);
      // No safe boundary: the window ends inside a string value longer than
      // the window. A fold there would put a raw newline inside the string
      // (invalid JSON — the event was dropped). Send the rest unfolded; the
      // parser's line cap is sized for one large event.
      if (scan.inString) end = payload.length;
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
  let cancelled = false;
  const pull = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    // Drain the source until we have emitted at least one chunk OR the
    // source is exhausted. Without the inner loop, a chunk that only
    // carries a partial line (no `\n` yet) would return from `pull`
    // without enqueueing anything, and the consumer would block forever
    // because Web Streams only re-invokes `pull` once the previous call
    // made progress.
    for (;;) {
      const { done, value } = await reader.read();
      if (cancelled) return;
      if (done) {
        if (lineLength > 0) {
          let line = takeLine(new Uint8Array(0));
          if (line.length > 0 && line[line.length - 1] === 0x0d) {
            line = line.subarray(0, line.length - 1);
          }
          emitLine(controller, line);
        }
        reader.releaseLock();
        controller.close();
        return;
      }
      if (!value || value.length === 0) continue;

      let chunkStart = 0;
      let emittedThisChunk = false;
      for (let i = 0; i < value.length; i++) {
        const byte = value[i]!;
        if (skipLeadingLf && i === chunkStart) {
          skipLeadingLf = false;
          if (byte === 0x0a) {
            chunkStart = i + 1;
            continue;
          }
        }
        if (byte !== 0x0a && byte !== 0x0d) continue;
        const lineEnd = i;
        const lineTail = value.subarray(chunkStart, lineEnd);
        let line = takeLine(lineTail);
        if (line.length > 0 && line[line.length - 1] === 0x0d) {
          line = line.subarray(0, line.length - 1);
        }
        emitLine(controller, line);
        emittedThisChunk = true;
        chunkStart = i + 1;
        skipLeadingLf = byte === 0x0d;
      }

      if (chunkStart < value.length) {
        assertLineBudget(lineLength + value.length - chunkStart);
        // Copy: the source chunk may be a reused/transferred buffer.
        lineParts.push(new Uint8Array(value.subarray(chunkStart)));
        lineLength += value.length - chunkStart;
      }

      // Made progress (at least one complete line was forwarded) — let the
      // consumer drain before we go back to the source for more. Otherwise
      // (no `\n` in this chunk, partial line still buffered) loop and read
      // the next chunk synchronously to avoid the no-progress deadlock.
      if (emittedThisChunk) return;
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        await pull(controller);
      } catch (error) {
        if (cancelled) return;
        lineParts.length = 0;
        lineLength = 0;
        void reader.cancel(error).catch(() => {});
        reader.releaseLock();
        throw error;
      }
    },
    cancel(reason) {
      cancelled = true;
      lineParts.length = 0;
      lineLength = 0;
      const pending = reader.cancel(reason);
      reader.releaseLock();
      return pending;
    },
  });
}
