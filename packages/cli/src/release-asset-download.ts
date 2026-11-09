import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Pauses before each retry. GitHub's release CDN answers a 100+ MB asset with
 * a passing 5xx (#438, #439) that the same request clears seconds later, so a
 * single failed attempt must not end an update or an install.
 */
const RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 10_000];
/** Ceiling on a server's `Retry-After`, so one header cannot stall an update. */
const MAX_RETRY_AFTER_MS = 30_000;

export interface DownloadRetryOptions {
  /** Pause before each retry; its length is the number of retries. */
  retryDelaysMs?: readonly number[] | undefined;
}

/** A failure the same request may not repeat: a 5xx/408/429 reply or a dropped connection. */
class TransientDownloadError extends Error {
  constructor(
    readonly failure: unknown,
    readonly retryAfterMs = 0,
  ) {
    super(failure instanceof Error ? failure.message : String(failure));
  }
}

function retryAfterMs(res: Response): number {
  const header = res.headers.get('retry-after');
  if (!header) return 0;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : 0;
}

async function requestAsset(url: string, signal: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal,
      headers: { 'User-Agent': 'wrongstack-cli' },
      redirect: 'follow',
    });
  } catch (err) {
    // An abort is the caller's or the deadline's decision, never a network hiccup.
    throw signal.aborted ? err : new TransientDownloadError(err);
  }
  if (res.ok) return res;
  // Release the connection before the next attempt.
  await res.body?.cancel().catch(() => undefined);
  const error = new Error(`download ${url} responded ${res.status}`);
  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    throw new TransientDownloadError(error, retryAfterMs(res));
  }
  throw error;
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  try {
    return await reader.read();
  } catch (err) {
    throw signal.aborted ? err : new TransientDownloadError(err);
  }
}

/**
 * Run `attempt` until it succeeds, fails for good, or runs out of retries. A
 * final failure is thrown as the error the attempt met, so callers keep
 * matching `download <url> responded <status>`.
 */
async function withRetries<T>(
  signal: AbortSignal,
  delays: readonly number[],
  attempt: () => Promise<T>,
): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof TransientDownloadError)) throw err;
      const delay = delays[retry];
      // A cancellation that lands while the attempt failed outranks the
      // transient failure: the caller asked to stop, it did not hit a 5xx.
      if (signal.aborted) throw signal.reason ?? err.failure;
      if (delay === undefined) throw err.failure;
      try {
        await sleep(Math.max(delay, err.retryAfterMs), undefined, { signal });
      } catch {
        // The backoff was cut short by the caller's cancellation or by the
        // deadline, so report that decision instead of the network hiccup.
        if (signal.aborted) throw signal.reason ?? err.failure;
        throw err.failure;
      }
    }
  }
}

/** Download one release asset without buffering beyond its configured ceiling. */
export async function downloadReleaseAsset(
  url: string,
  timeoutMs: number,
  maxBytes: number,
  options: DownloadRetryOptions = {},
): Promise<Buffer> {
  // One deadline across every attempt: retries never extend the caller's budget.
  const signal = AbortSignal.timeout(timeoutMs);
  return withRetries(signal, options.retryDelaysMs ?? RETRY_DELAYS_MS, async () => {
    const res = await requestAsset(url, signal);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      // Release the connection before rejecting the oversized asset.
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`download ${url} is too large`);
    }
    if (!res.body) return Buffer.alloc(0);

    const chunks: Buffer[] = [];
    let received = 0;
    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await readChunk(reader, signal);
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel();
          throw new Error(`download ${url} is too large`);
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, received);
  });
}

/**
 * Stream one release asset into `file` (created exclusively) and return its
 * SHA-256. The background self-update uses this so a 100+ MB executable never
 * sits in the session's heap. `file` is removed when the download fails, so a
 * retry starts from an empty path.
 */
export async function downloadReleaseAssetToFile(
  url: string,
  file: string,
  options: {
    timeoutMs: number;
    maxBytes: number;
    signal?: AbortSignal | undefined;
  } & DownloadRetryOptions,
): Promise<string> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return withRetries(signal, options.retryDelaysMs ?? RETRY_DELAYS_MS, async () => {
    const res = await requestAsset(url, signal);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > options.maxBytes) {
      // Release the connection before rejecting the oversized asset.
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`download ${url} is too large`);
    }

    const hash = createHash('sha256');
    const out = await fsp.open(file, 'wx', 0o600);
    let received = 0;
    try {
      if (res.body) {
        const reader = res.body.getReader();
        try {
          while (true) {
            const { done, value } = await readChunk(reader, signal);
            if (done) break;
            received += value.byteLength;
            if (received > options.maxBytes) {
              await reader.cancel();
              throw new Error(`download ${url} is too large`);
            }
            hash.update(value);
            await out.writeFile(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      await out.sync();
    } catch (err) {
      await out.close().catch(() => undefined);
      await fsp.rm(file, { force: true });
      throw err;
    }
    await out.close();
    return hash.digest('hex');
  });
}
