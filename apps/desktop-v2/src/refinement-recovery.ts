import { EngineReplyError } from './engine-operations';

export interface RefinerTarget {
  provider: string;
  model: string;
}
export function refinementRecovery(error: unknown) {
  const details = error instanceof EngineReplyError ? error.details : {};
  const kind = details['errorKind'];
  const guidance =
    kind === 'timeout'
      ? 'The refiner ran out of time. Retry with a longer window or choose another model.'
      : kind === 'empty'
        ? 'The refiner did not return a usable rewrite. Retry or choose another model.'
        : kind === 'provider_error'
          ? 'The refiner could not complete the request. Check the connection or choose another model.'
          : 'Check the connection, retry, or return to your original draft.';
  /** The guidance as a catalog code, for wording it in the display language. */
  const code: 'timeout' | 'empty' | 'provider_error' | 'other' =
    kind === 'timeout' || kind === 'empty' || kind === 'provider_error' ? kind : 'other';
  const timeout = details['retryTimeoutMs'];
  // Leave room for the transport grace period below the native timer limit.
  const retryTimeoutMs =
    kind === 'timeout' &&
    typeof timeout === 'number' &&
    Number.isFinite(timeout) &&
    timeout > 0 &&
    timeout <= 2147460000
      ? timeout
      : 180000;
  const ref = typeof details['fallbackRef'] === 'string' ? details['fallbackRef'].trim() : '';
  const slash = ref.indexOf('/');
  const provider = ref.slice(0, slash).trim(),
    model = ref.slice(slash + 1).trim();
  const fallback: RefinerTarget | undefined =
    slash > 0 && provider && model ? { provider, model } : undefined;
  return {
    message: error instanceof Error ? error.message : String(error),
    guidance,
    kind: code,
    retryTimeoutMs,
    fallback,
  };
}
