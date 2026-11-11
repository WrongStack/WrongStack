import { SYNC_OUTPUT_OFF, SYNC_OUTPUT_ON } from './terminal-modes.js';

const BSU_BUF = Buffer.from(SYNC_OUTPUT_ON, 'utf8');
const ESU_BUF = Buffer.from(SYNC_OUTPUT_OFF, 'utf8');

/** Default ceiling (512 KiB) before forcing an immediate synchronized flush. */
export const DEFAULT_SYNC_STDOUT_MAX_BATCH_BYTES = 512 * 1024;

export interface SynchronizedStdoutOptions {
  /** Enable DECSET 2026 BSU/ESU framing and microtask coalescing. Default: true. */
  enabled?: boolean | undefined;
  /** Maximum queued bytes per microtask before immediate flush. Default: 512 KiB. */
  maxBatchBytes?: number | undefined;
}

export interface SynchronizedStdoutHandle {
  /** Stream proxy suitable for passing to Ink's `render({ stdout })` and `/clear`. */
  stream: NodeJS.WriteStream;
  /** Synchronously flush any queued chunks wrapped in BSU/ESU. Safe to call on exit. */
  flushSync: () => void;
  /** Stop coalescing and flush remaining chunks immediately. */
  dispose: () => void;
}

type WriteCallback = ((err?: Error | null) => void) | undefined;

function toChunkBuffer(chunk: unknown, encoding?: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array)
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(String(chunk), encoding ?? 'utf8');
}

/**
 * Wrap a terminal `WriteStream` so burst writes within the same synchronous turn
 * (e.g. resize `\x1b[J` erase + Ink re-render, or multi-chunk frame diffs) are
 * coalesced into a single atomic `BSU ... ESU` (`\x1b[?2026h ... \x1b[?2026l`)
 * write syscall.
 */
export function createSynchronizedStdout(
  target: NodeJS.WriteStream,
  opts: SynchronizedStdoutOptions = {},
): SynchronizedStdoutHandle {
  const enabled = opts.enabled ?? true;
  if (!enabled) {
    return {
      stream: target,
      flushSync: () => {},
      dispose: () => {},
    };
  }

  const maxBatchBytes = Math.max(4096, opts.maxBatchBytes ?? DEFAULT_SYNC_STDOUT_MAX_BATCH_BYTES);
  let disposed = false;
  let scheduled = false;
  let pendingChunks: Buffer[] = [];
  let pendingCallbacks: Array<(err?: Error | null) => void> = [];
  let pendingBytes = 0;

  const flushSync = (): void => {
    scheduled = false;
    if (pendingChunks.length === 0) return;

    const chunks = pendingChunks;
    const callbacks = pendingCallbacks;
    pendingChunks = [];
    pendingCallbacks = [];
    pendingBytes = 0;

    const framed = Buffer.concat([BSU_BUF, ...chunks, ESU_BUF]);
    let callbackInvoked = false;
    const invokeCallbacks = (err?: Error | null): void => {
      if (callbackInvoked) return;
      callbackInvoked = true;
      for (const cb of callbacks) {
        try {
          cb(err);
        } catch {
          // Never allow a write listener callback to crash the render pipeline.
        }
      }
    };

    try {
      if (callbacks.length > 0 && target.write.length >= 2) {
        target.write(framed, (err) => invokeCallbacks(err));
      } else {
        target.write(framed);
        invokeCallbacks(null);
      }
    } catch (err) {
      invokeCallbacks(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const synchronizedWrite = (
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | WriteCallback,
    cb?: WriteCallback,
  ): boolean => {
    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;

    if (disposed) {
      if (callback) {
        return target.write(chunk as never, encoding as never, callback as never);
      }
      return encoding ? target.write(chunk as never, encoding) : target.write(chunk as never);
    }

    const buf = toChunkBuffer(chunk, encoding);
    if (buf.byteLength === 0) {
      callback?.(null);
      return true;
    }

    pendingChunks.push(buf);
    if (callback) pendingCallbacks.push(callback);
    pendingBytes += buf.byteLength;

    if (pendingBytes >= maxBatchBytes) {
      flushSync();
      return true;
    }

    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flushSync);
    }
    return true;
  };

  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'write') return synchronizedWrite;
      const value: unknown = Reflect.get(obj, prop, receiver);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(obj)
        : value;
    },
  });

  return {
    stream: proxy,
    flushSync,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      flushSync();
    },
  };
}

/**
 * Defense-in-depth stdin filter: strips any Kitty Graphics Protocol (`APC G`)
 * status reply (`\x1b_G...\x1b\\`) that a non-compliant terminal might emit
 * despite `q=2` quiet mode, preventing accidental keystroke injection.
 */
const KITTY_APC_REPLY_RE = /\x1b_G[^\x1b]{0,1024}\x1b\\/g;

export function stripTerminalGraphicsResponses(data: Buffer | string): Buffer | string {
  const text = typeof data === 'string' ? data : data.toString('utf8');
  if (!text.includes('\x1b_G')) return data;
  const cleaned = text.replace(KITTY_APC_REPLY_RE, '');
  return typeof data === 'string' ? cleaned : Buffer.from(cleaned, 'utf8');
}
