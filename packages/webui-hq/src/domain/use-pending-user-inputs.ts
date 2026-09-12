import type {
  HqEventEnvelope,
  HqUserInputRequestedPayload,
  HqUserInputResolvedPayload,
} from '@wrongstack/core/hq';
import type { UserInputResponse } from '@wrongstack/core/types';
import { useCallback, useMemo, useState } from 'react';
import { postCommand } from '../data/api.js';
import { useToastStore } from '../data/toast-store.js';
import { useBackfilledEvents } from './use-backfilled-events.js';

export interface PendingUserInput extends HqUserInputRequestedPayload {
  clientId: string;
  projectId: string;
  sessionId?: string | undefined;
}
export function usePendingUserInputs(): readonly PendingUserInput[] {
  const { events: requested } = useBackfilledEvents('user_input.requested', 200);
  const { events: resolved } = useBackfilledEvents('user_input.resolved', 200);
  return useMemo(() => project(requested, resolved), [requested, resolved]);
}
function project(
  requested: readonly HqEventEnvelope[],
  resolved: readonly HqEventEnvelope[],
): PendingUserInput[] {
  const settled = new Set(
    resolved.map((event) => (event.payload as HqUserInputResolvedPayload).requestId),
  );
  const pending = new Map<string, PendingUserInput>();
  for (const event of requested) {
    const payload = event.payload as HqUserInputRequestedPayload;
    if (!payload.request?.id || settled.has(payload.request.id)) continue;
    pending.set(payload.request.id, {
      ...payload,
      clientId: event.clientId,
      projectId: event.projectId,
      sessionId: event.sessionId,
    });
  }
  return [...pending.values()];
}
export function useAnswerUserInput() {
  const addToast = useToastStore((state) => state.addToast);
  const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set());
  const answer = useCallback(
    async (input: PendingUserInput, response: UserInputResponse) => {
      setSending((old) => new Set(old).add(input.request.id));
      try {
        await postCommand(input.clientId, 'answer-input', {
          requestId: input.request.id,
          response,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        });
        addToast('Answers submitted to the waiting model', 'success');
      } catch (error) {
        addToast(error instanceof Error ? error.message : String(error), 'warning');
      } finally {
        setSending((old) => {
          const next = new Set(old);
          next.delete(input.request.id);
          return next;
        });
      }
    },
    [addToast],
  );
  return { answer, pendingFor: (id: string) => sending.has(id) };
}
