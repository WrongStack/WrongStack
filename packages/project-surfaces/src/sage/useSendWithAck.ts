import { useCallback, useRef } from 'react';
import type { SurfaceClient } from '../host';
import type { SageEntry } from './model-types';

interface SendWithAckDeps {
  client: SurfaceClient;
  mutationGenerationRef: { current: number };
  mutationCleanupRef: { current: (() => void) | null };
  mountedRef: { current: boolean };
  setMutationError: (error: string | null) => void;
}

/**
 * Send a SAGE mutation and settle on its reply: a newer mutation or an
 * unmount supersedes it, and a silent store surfaces as an error after 20 s.
 *
 * The request carries a correlation id the server echoes. A reply that
 * carries a DIFFERENT id belongs to another operation and must not settle
 * this wait; a reply that carries no id belongs to a request that could not
 * carry one (`memory.sage.update` spreads its payload into the memory patch,
 * `memory.sage.recover` has no id field) and is accepted as before.
 *
 * Returns a promise that settles when the operation is over - acknowledged,
 * superseded, timed out or unmounted. A caller that keeps an "in flight"
 * affordance (the file drawer's per-memory pending state) MUST await it:
 * without it the affordance is dropped on the next microtask, long before
 * the store answered, and a destructive action can be submitted twice.
 */
export function useSendWithAck({
  client,
  mutationGenerationRef,
  mutationCleanupRef,
  mountedRef,
  setMutationError,
}: SendWithAckDeps) {
  const requestSeqRef = useRef(0);
  return useCallback(
    (
      type: 'memory.sage.candidateResolve' | 'memory.sage.recover' | 'memory.sage.update',
      send: (requestId: string) => void,
      onResponse: (payload: { error?: string | undefined; memory?: SageEntry | undefined }) => void,
    ): Promise<void> =>
      new Promise<void>((resolve) => {
        const generation = ++mutationGenerationRef.current;
        mutationCleanupRef.current?.();
        setMutationError(null);
        requestSeqRef.current += 1;
        const requestId = `ack_${Date.now()}_${requestSeqRef.current}`;

        let off = () => {};
        let timeout: ReturnType<typeof setTimeout> | null = null;
        let settled = false;
        const cleanup = () => {
          if (settled) return;
          settled = true;
          if (timeout !== null) clearTimeout(timeout);
          off();
          if (mutationCleanupRef.current === cleanup) mutationCleanupRef.current = null;
          // Every path out of this operation ends here, so the promise is
          // resolved exactly once - the caller's in-flight state ends with
          // the operation, never before it.
          resolve();
        };

        off = client.on(type, (message) => {
          const echoed = (message.payload as { requestId?: string | undefined }).requestId;
          // A reply tagged with another operation's id is not ours.
          if (echoed !== undefined && echoed !== requestId) return;
          if (generation !== mutationGenerationRef.current || !mountedRef.current) {
            cleanup();
            return;
          }
          cleanup();
          onResponse(message.payload);
        });

        timeout = setTimeout(() => {
          if (generation !== mutationGenerationRef.current || !mountedRef.current) return;
          cleanup();
          setMutationError(
            'The memory store did not respond. Check the WebSocket connection and try again.',
          );
        }, 20_000);

        mutationCleanupRef.current = cleanup;
        send(requestId);
      }),
    [client, mountedRef, mutationCleanupRef, mutationGenerationRef, setMutationError],
  );
}
