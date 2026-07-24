import { LSPError, LSPErrorCode } from '../types.js';

export async function promiseWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal | undefined,
): Promise<T> {
  if (signal?.aborted) throw abortError(signal);
  let timer: NodeJS.Timeout | undefined;
  return await new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer!);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal!));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new LSPError(LSPErrorCode.RequestTimeout, `LSP request timed out after ${ms}ms`));
    }, ms);
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
