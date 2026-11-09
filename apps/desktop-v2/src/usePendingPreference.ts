import { useEffect, useState } from 'react';

/** How long a saved choice waits for the engine stream to report it before the stream wins. */
export const PREFERENCE_ECHO_TIMEOUT_MS = 10_000;

/**
 * A toggle backed by an engine preference. The engine confirms a change in its reply, but the
 * reducer learns it only when the journal stream catches up, and older frames (the profile's
 * value at session start) can still arrive in between. Dropping the user's choice as soon as the
 * save resolves would flip the toggle back for a moment, and a message sent in that moment would
 * use the stale value (a refinement review the user had just switched off). The choice is held
 * until the stream reports the same value, a failed save drops it, and a stream that never echoes
 * it (another window changed it in the same batch) wins after a timeout.
 */
export function usePendingPreference(streamed: boolean, saving: boolean) {
  const [pending, setPending] = useState<boolean | null>(null);
  useEffect(() => {
    if (pending === null || saving) return;
    if (pending === streamed) {
      setPending(null);
      return;
    }
    const timer = setTimeout(() => setPending(null), PREFERENCE_ECHO_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pending, streamed, saving]);
  return { value: pending ?? streamed, pending, setPending };
}
