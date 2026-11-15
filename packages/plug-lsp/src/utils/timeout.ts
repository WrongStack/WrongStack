import { LSPError, LSPErrorCode } from '../types.js';

export async function promiseWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal | undefined,
): Promise<T> {
  if (signal?.aborted) {
    void promise.catch(() => {});
    throw abortError(signal);
  }
  const safeMs = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 15_000;
  const MAX_TIMEOUT_MS = 2_147_483_647;
  const deadline = Date.now() + safeMs;
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  return await new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      settled = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal!));
    };
    const armTimer = (remaining: number) => {
      // Called only at creation or by the unsettled timer callback below.
      if (timer) clearTimeout(timer);
      const chunk = Math.min(Math.max(0, remaining), MAX_TIMEOUT_MS);
      timer = setTimeout(() => {
        if (settled) return;
        const left = deadline - Date.now();
        if (left > 0) {
          armTimer(left);
          return;
        }
        cleanup();
        reject(
          new LSPError(LSPErrorCode.RequestTimeout, `LSP request timed out after ${safeMs}ms`),
        );
      }, chunk);
    };
    armTimer(safeMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
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
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

/** Direct-module test seam; not re-exported by the package barrel. */
export const timeoutCoverage = { abortError };
