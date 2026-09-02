/**
 * Shared single-flight wrapper for OAuth token refresh.
 *
 * OAuth providers all share the same race: when N concurrent requests arrive
 * near expiry (or after a 401), each requester runs its own full refresh path
 * — token endpoint call, in-memory state mutation, and `onRefresh` callback
 * for persistence. With N concurrent callers, the upstream endpoint is hit N
 * times, `onRefresh` fires N times, and state mutations race with stale-wins.
 *
 * `createSingleFlightRefresh` collapses concurrent callers onto one in-flight
 * promise. After the refresh resolves (or rejects), the slot is cleared so
 * the next refresh can fire normally. The work function passed in must
 * include every side effect (state mutation + persistence callback), because
 * it is the boundary the helper enforces single-flight across.
 *
 * Contract:
 * - `refresh()` called while no refresh is in flight → starts one.
 * - `refresh()` called while a refresh IS in flight → awaits the same promise.
 * - On rejection, every awaiter sees the same error; the slot is cleared so
 *   a later refresh can be retried.
 * - NO caller's `signal` drives the shared refresh. The token exchange (and
 *   its state-mutation + persistence side effects) always runs to completion,
 *   bounded only by each `refreshFn`'s own internal timeout. A caller's signal
 *   cancels only THAT caller's wait — it never cancels the shared work.
 */
export interface SingleFlightRefresh<T> {
  /**
   * Trigger (or join) a refresh. Returns the new value once complete.
   * `signal` aborts only the calling awaiter's wait; the shared refresh keeps
   * running so other awaiters — and the persistence callback — are unaffected.
   */
  refresh(signal?: AbortSignal): Promise<T>;
  /** True iff a refresh is currently in flight. */
  get inFlight(): boolean;
}

export function createSingleFlightRefresh<T>(
  refreshFn: (signal: AbortSignal | undefined) => Promise<T>,
): SingleFlightRefresh<T> {
  let inFlight: Promise<T> | null = null;

  const refresh = (signal?: AbortSignal): Promise<T> => {
    // The shared refresh runs independent of ANY caller's signal. Binding it to
    // the first caller's signal (the old behavior) meant one caller's Esc
    // rejected every other awaiter whose request was still live — and, for
    // providers that rotate the refresh token on each refresh (Codex,
    // ChatGPT), an abort landing after the server rotated the token but before
    // `performRefresh` persisted it discarded the new token, so the NEXT
    // refresh hit `invalid_grant` and forced a re-login. Pass `undefined`:
    // every refreshFn impl already wraps its own `AbortSignal.timeout`, so the
    // shared work stays bounded, just not caller-cancellable.
    if (!inFlight) {
      inFlight = refreshFn(undefined).finally(() => {
        inFlight = null;
      });
    }
    const shared = inFlight;

    // A caller's signal cancels only that caller's wait. Callers that abort
    // reject individually; the refresh and its side effects still complete.
    if (!signal) return shared;
    if (signal.aborted) return Promise.reject(signalAbortReason(signal));
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(signalAbortReason(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      const cleanup = (): void => signal.removeEventListener('abort', onAbort);
      shared.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (err) => {
          cleanup();
          reject(err);
        },
      );
    });
  };

  return {
    refresh,
    get inFlight() {
      return inFlight !== null;
    },
  };
}

/** The signal's own abort reason, or a synthesized AbortError when it has none. */
function signalAbortReason(signal: AbortSignal): unknown {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason !== undefined) return reason;
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}
