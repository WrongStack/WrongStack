/**
 * Connection warm-up for provider endpoints (`Provider.warm`).
 *
 * A request to an endpoint nobody has talked to lately pays for a DNS lookup,
 * a TCP handshake and a full TLS handshake before its first byte goes out.
 * Hosts call `warm()` while the user is still typing; a cheap `GET /` to the
 * endpoint's origin does that work early, and the real request takes the
 * open socket from fetch's keep-alive pool (checked against api.z.ai,
 * api.anthropic.com and api.openai.com: one connection for both requests).
 *
 * Measured 2026-09-23 (time to response headers, median of 6, cold vs warmed):
 * api.z.ai 242 → 164 ms, and the ~900 ms cold-DNS outliers (2 of 6) were gone;
 * api.anthropic.com 179 → 159 ms; api.openai.com, a nearby CDN edge, no change.
 *
 * GET, not HEAD: undici does not pool a socket after a HEAD response. The
 * body of an API origin's root is a short error page; it is read to the end
 * (cancelling a body destroys its socket) up to a cap.
 *
 * The pool drops an idle socket after about 4 s unless the server asks for
 * longer, so calls are throttled per origin rather than de-duplicated: a user
 * typing for a minute costs one small request every few seconds.
 */

/** Minimum gap between two warm-ups of one origin. Below the pool's ~4 s idle timeout. */
const WARM_INTERVAL_MS = 3_000;
/** A warm-up that has not answered by now is abandoned. */
const WARM_TIMEOUT_MS = 5_000;
/** Origins remembered for throttling; a handful in practice. */
const MAX_TRACKED_ORIGINS = 64;
/** Most of a warm-up response body read before giving the socket up. */
const MAX_WARM_BODY_BYTES = 64 * 1024;

const lastWarmAt = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();

function originOf(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Open (or keep open) a connection to `baseUrl`'s origin. Never rejects; an
 * unreachable endpoint just stays cold and the real request reports the error.
 */
export function warmConnection(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<void> {
  const safeNow = Number.isFinite(now) ? now : Date.now();
  const origin = originOf(baseUrl);
  if (!origin) return Promise.resolve();
  const pending = inFlight.get(origin);
  if (pending) return pending;
  const last = lastWarmAt.get(origin);
  if (last !== undefined && safeNow - last < WARM_INTERVAL_MS) return Promise.resolve();

  if (lastWarmAt.size >= MAX_TRACKED_ORIGINS) lastWarmAt.clear();
  const warm = Promise.resolve().then(async () => {
    let succeeded = false;
    try {
      // `manual`: a redirect would only warm some other origin.
      const response = await fetchImpl(`${origin}/`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(WARM_TIMEOUT_MS),
      });
      const reader = response.body?.getReader();
      let read = 0;
      while (reader) {
        const chunk = await reader.read();
        if (chunk.done) break;
        read += chunk.value.byteLength;
        if (read > MAX_WARM_BODY_BYTES) {
          await reader.cancel();
          return;
        }
      }
      // Only mark the origin warm after the response body has been read into
      // the keep-alive pool. A rejection or body-cancel drops the socket, so
      // staying in `lastWarmAt` would silently throttle the next attempt
      // inside the interval even though no warm connection is available.
      succeeded = true;
      lastWarmAt.set(origin, safeNow);
    } catch {
      // Best-effort by contract. Drop any stale throttle entry for this
      // origin so a transient outage can be retried without waiting out the
      // full 3 s interval.
      lastWarmAt.delete(origin);
    } finally {
      inFlight.delete(origin);
      if (!succeeded) lastWarmAt.delete(origin);
    }
  });
  inFlight.set(origin, warm);
  return warm;
}
