import { Readable } from 'node:stream';
import { StreamHangError } from '@wrongstack/contracts/types';
import { isNodeReadable } from './object-utils.js';
import { pushDebugChunkStats } from './stream-debug-state.js';

/**
 * Stream wrappers the wire adapter puts around a response body: a per-chunk
 * debug logger and a hang detector. Free functions so the adapter class only
 * decides *whether* to wrap.
 */

/** Who is streaming and how long a silent body may stall before it is a hang. */
export interface StreamHangContext {
  providerId: string;
  model: string;
  timeoutMs: number;
}

const STREAM_DEBUG_TEXT_ENCODER = new TextEncoder();

/**
 * Feed debug-chunk stats into the shared singleton sink. The sink batches
 * and throttles writes so the TUI can render them inside Ink's StatusBar
 * line 3 (~5 Hz) instead of raw stderr interfering with the terminal layout.
 */
function logRawChunk(
  _providerId: string,
  _chunkIndex: number,
  bytes: Uint8Array,
  deltaMs: number,
): void {
  pushDebugChunkStats(bytes.length, deltaMs);
}

/**
 * Wrap a readable stream body to log a compact status line per incoming
 * byte chunk to stderr. This is a diagnostic tool for tracking stream
 * activity — chunk count, sizes, and inter-chunk deltas — without
 * printing payload contents.
 */
export function wrapDebugStream(
  providerId: string,
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
): ReadableStream<Uint8Array> | NodeJS.ReadableStream {
  // Node.js Readable stream — use async iterator
  if (isNodeReadable(body)) {
    return wrapDebugNodeStream(providerId, body as NodeJS.ReadableStream) as NodeJS.ReadableStream;
  }
  // Web ReadableStream — wrap reader
  return wrapDebugWebStream(providerId, body as ReadableStream<Uint8Array>);
}

function wrapDebugNodeStream(
  providerId: string,
  body: NodeJS.ReadableStream,
): NodeJS.ReadableStream {
  let lastChunkTime = Date.now();
  let chunkIndex = 0;
  let streamSource: NodeJS.ReadableStream;
  if (
    Symbol.asyncIterator in body &&
    typeof (body as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  ) {
    streamSource = body;
  } else if (body instanceof Readable) {
    streamSource = body;
  } else {
    const r = new Readable({ read() {} });
    body.on('data', (chunk: unknown) => r.push(chunk));
    body.on('end', () => r.push(null));
    body.on('error', (err: Error) => r.destroy(err));
    streamSource = r;
  }

  return Readable.from(
    (async function* () {
      for await (const chunk of streamSource) {
        const bytes: Uint8Array =
          typeof chunk === 'string'
            ? STREAM_DEBUG_TEXT_ENCODER.encode(chunk)
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const now = Date.now();
        logRawChunk(providerId, chunkIndex++, bytes, now - lastChunkTime);
        lastChunkTime = now;
        yield chunk;
      }
    })(),
  );
}

function wrapDebugWebStream(
  providerId: string,
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  let lastChunkTime = Date.now();
  let chunkIndex = 0;
  const reader = body.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value) {
        const now = Date.now();
        logRawChunk(providerId, chunkIndex++, value, now - lastChunkTime);
        lastChunkTime = now;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * Wrap a readable stream to detect hangs — when no data arrives for
 * longer than `hang.timeoutMs`. When a hang is detected, throws
 * `StreamHangError` so the caller can retry or fall back.
 */
export function wrapWithHangDetection(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
  hang: StreamHangContext,
): ReadableStream<Uint8Array> | NodeJS.ReadableStream {
  if (isNodeReadable(body)) {
    return wrapHangNodeStream(body as NodeJS.ReadableStream, hang);
  }
  return wrapHangWebStream(body as ReadableStream<Uint8Array>, hang);
}

function wrapHangNodeStream(
  body: NodeJS.ReadableStream,
  hang: StreamHangContext,
): NodeJS.ReadableStream {
  // Node Readable → Web ReadableStream, then use the race-based
  // web wrapper that properly detects hangs even when no chunks arrive.
  // The for-await approach only checks BETWEEN chunks — a stalled stream
  // that never yields another chunk would freeze indefinitely.
  let readable: Readable;
  if (body instanceof Readable) {
    readable = body;
  } else if (
    Symbol.asyncIterator in body &&
    typeof (body as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  ) {
    readable = Readable.from(body as unknown as AsyncIterable<unknown>);
  } else {
    readable = new Readable({ read() {} });
    body.on('data', (chunk: unknown) => readable.push(chunk));
    body.on('end', () => readable.push(null));
    body.on('error', (err: Error) => readable.destroy(err));
  }
  const webStream = Readable.toWeb(readable);
  const wrappedWeb = wrapHangWebStream(webStream as ReadableStream<Uint8Array>, hang);
  // `as never`: the global ReadableStream differs from node:stream/web's
  // when the DOM lib is in scope (vitest types), so don't name either.
  return Readable.fromWeb(wrappedWeb as never) as never as NodeJS.ReadableStream;
}

function wrapHangWebStream(
  body: ReadableStream<Uint8Array>,
  { providerId, model, timeoutMs: timeout }: StreamHangContext,
): ReadableStream<Uint8Array> {
  const startTime = Date.now();
  let bytesReceived = 0;
  const reader = body.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Race the read against a hang timeout
      const readPromise = reader.read();
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
        timeoutHandle = setTimeout(() => resolve({ timedOut: true }), timeout);
      });

      let result: { done: boolean; value?: Uint8Array | undefined } | { timedOut: true };
      try {
        result = await Promise.race([readPromise, timeoutPromise]);
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }

      if ('timedOut' in result && result.timedOut) {
        // The read is still pending — this is a hang.
        // Cancel the reader and throw.
        reader
          .cancel('stream hang detected')
          .catch((err) => console.debug(`[wire-adapter] cancel after stream hang failed: ${err}`));
        const elapsedMs = Date.now() - startTime;
        throw new StreamHangError({
          providerId,
          model,
          hangTimeoutMs: timeout,
          bytesReceived,
          elapsedMs,
        });
      }

      const { done, value } = result as Awaited<ReturnType<typeof reader.read>>;
      if (done) {
        controller.close();
        return;
      }
      if (value) {
        bytesReceived += value.length;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
