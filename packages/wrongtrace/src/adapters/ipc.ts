/**
 * IPC transport adapter for WrongTrace — JSON-RPC 2.0 over Named Pipe / UDS.
 *
 * Wire format (daemon 2026-08-24+):
 *   request:  {"jsonrpc":"2.0","id":N,"method":"telemetry/file_health","params":{...}}\n
 *   response: {"jsonrpc":"2.0","id":N,"result":{...}}\n
 *            |{"jsonrpc":"2.0","id":N,"error":{"code":-32601,"message":"..."}}\n
 *
 * Live-verified (2026-08-24, both \\.\pipe\wrongtrace and \\.\pipe\wrongtrace-int):
 * only `telemetry/file_health` and `telemetry/report_run` answer on the pipe;
 * guardrail/atlas exist solely as HTTP routes. The legacy REST-over-pipe
 * framing ({"method":"GET","path":...}) is GONE from the daemon — it now
 * replies -32601 "method not found: GET", so this adapter no longer sends it.
 *
 * Degradation contract (mirrors the HTTP client): `call()` NEVER throws.
 * Transport failures (connect refused, timeout, malformed frames) resolve
 * `{ result: null }`; daemon error envelopes resolve `{ result: null, error }`.
 * Callers fall back to HTTP instead of mistaking an envelope for a result —
 * the exact bug the legacy framing produced in `getAtlas()`.
 */

import { connect } from 'node:net';

const CONNECT_TIMEOUT_MS = 2_000;
const READ_TIMEOUT_MS = 5_000;

export interface IpcTimeouts {
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
}

export interface IpcCallResult<T = unknown> {
  /** JSON-RPC `result` body when the call succeeded, else `null`. */
  result: T | null;
  /** Present only when the daemon replied with a JSON-RPC error envelope. */
  error?: { code: number; message: string };
}

export interface IpcTransport {
  /** Always `false` when constructed without a socketPath. */
  readonly isWired: boolean;
  /**
   * Round-trips one JSON-RPC 2.0 call over a fresh connection. One request
   * per connection means any error envelope on the wire is unambiguously
   * ours — no cross-connection id confusion at these latencies (~0.3ms).
   */
  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<IpcCallResult<T>>;
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`IPC request exceeded ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

function once<T extends unknown[]>(
  emitter: NodeJS.EventEmitter,
  event: string,
  predicate: (...args: T) => boolean = () => true,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAny = (...args: unknown[]) => {
      if (predicate(...(args as T))) {
        emitter.removeListener('error', onError);
        emitter.removeListener(event, onAny);
        resolve(args as T);
      }
    };
    const onError = (err: Error) => {
      emitter.removeListener(event, onAny);
      reject(err);
    };
    emitter.once(event, onAny);
    emitter.once('error', onError);
  });
}

// JSON-RPC ids only need to be unique per connection, but a process-wide
// counter costs nothing and makes correlation observable in logs/probes.
let nextRequestId = 1;

export function createIpcTransport(socketPath?: string, timeouts?: IpcTimeouts): IpcTransport {
  if (!socketPath) {
    return {
      isWired: false,
      async call() {
        return { result: null };
      },
    };
  }

  const connectTimeoutMs = timeouts?.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const readTimeoutMs = timeouts?.readTimeoutMs ?? READ_TIMEOUT_MS;

  return {
    isWired: true,
    async call<T>(method: string, params: Record<string, unknown>): Promise<IpcCallResult<T>> {
      const sock = connect(socketPath);
      const id = nextRequestId++;
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        sock.destroy();
      };
      try {
        await Promise.race([
          once(sock, 'connect'),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new TimeoutError(connectTimeoutMs)), connectTimeoutMs);
          }),
        ]);
        clearTimeout(timer);
        timer = undefined;

        const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
        sock.write(payload);

        timer = setTimeout(() => sock.destroy(new TimeoutError(readTimeoutMs)), readTimeoutMs);

        // Line-buffered frame reader: accumulate until the newline-delimited
        // frame carrying our response arrives. Junk/partial lines are skipped,
        // not fatal — the daemon is allowed to chatter before answering.
        let buffer = '';
        for await (const chunk of sock) {
          buffer += (chunk as Buffer).toString('utf8');
          let newlineAt = buffer.indexOf('\n');
          while (newlineAt !== -1) {
            const line = buffer.slice(0, newlineAt).trim();
            buffer = buffer.slice(newlineAt + 1);
            newlineAt = buffer.indexOf('\n');
            if (line.length === 0) continue;
            let envelope: {
              id?: number | null;
              result?: unknown;
              error?: { code: number; message: string };
            };
            try {
              envelope = JSON.parse(line);
            } catch {
              continue; // malformed line — tolerate, keep scanning
            }
            if (envelope.error) {
              return { result: null, error: envelope.error };
            }
            if (envelope.id === id || envelope.id === null) {
              return { result: (envelope.result ?? null) as T | null };
            }
            // Different id — a frame for someone else; keep scanning.
          }
        }
        // Socket closed without a usable frame.
        return { result: null };
      } catch {
        return { result: null };
      } finally {
        cleanup();
      }
    },
  };
}
// Re-exporting for tests / advanced consumers that want the underlying timeout error.
