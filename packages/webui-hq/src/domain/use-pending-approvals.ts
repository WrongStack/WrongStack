/**
 * usePendingApprovals — the permission prompts currently waiting for a human.
 *
 * Derived entirely from the event stream, with no server-side registry, and
 * that is sound for one reason: **a pending approval cannot outlive its own
 * deadline**. The agent gives a human a fixed window and then hands the
 * decision to the Brain arbiter, so any `approval.requested` whose
 * `deadlineAt` has passed is settled by definition, whether or not its
 * matching `approval.resolved` is still in the window we fetched.
 *
 * That bounds staleness to the deadline rather than to the log limit, which is
 * what makes a two-event fold honest here. The publisher also republishes its
 * outstanding set on every HQ (re)connect, so a dashboard opened mid-prompt
 * sees the live board rather than waiting for the next one.
 *
 * @module domain/use-pending-approvals
 */
import type {
  HqApprovalRequestedPayload,
  HqApprovalResolvedPayload,
  HqEventEnvelope,
} from '@wrongstack/core/hq';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { postCommand } from '../data/api.js';
import { useToastStore } from '../data/toast-store.js';
import { useBackfilledEvents } from './use-backfilled-events.js';

/** How often the deadline filter re-evaluates, so a card expires on screen. */
const TICK_MS = 1_000;

/** Enough history to cover a reconnect burst without dragging the whole log in. */
const EVENT_LIMIT = 200;

export interface PendingApproval extends HqApprovalRequestedPayload {
  /** The publisher holding the prompt — the address an `approve` command is sent to. */
  clientId: string;
  projectId: string;
  /** The conversation the prompt belongs to; carried back so the answer lands on it. */
  sessionId?: string | undefined;
  /** When the request envelope was produced. */
  requestedAt: string;
  /** Milliseconds left before the Brain arbiter takes the decision. */
  remainingMs: number;
}

export function usePendingApprovals(): {
  approvals: readonly PendingApproval[];
  loading: boolean;
} {
  const { events: requested, loading } = useBackfilledEvents('approval.requested', EVENT_LIMIT);
  const { events: resolved } = useBackfilledEvents('approval.resolved', EVENT_LIMIT);

  // A deadline passes without any event arriving, so the derived list needs a
  // clock of its own or an expired card sits there looking answerable.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const approvals = useMemo(
    () => derivePendingApprovals(requested, resolved, now),
    [requested, resolved, now],
  );

  return { approvals, loading };
}

/**
 * Fold the two event streams into the prompts still waiting.
 *
 * Pure and exported so the rule that keeps this honest — a request is pending
 * only until its own deadline — is testable without a renderer.
 */
export function derivePendingApprovals(
  requested: readonly HqEventEnvelope[],
  resolved: readonly HqEventEnvelope[],
  now: number,
): readonly PendingApproval[] {
  const settled = new Set<string>();
  for (const event of resolved) {
    const payload = event.payload as HqApprovalResolvedPayload;
    if (typeof payload?.toolUseId === 'string') settled.add(payload.toolUseId);
  }

  // Keyed by toolUseId so a republished request (reconnect replay) updates the
  // existing card instead of stacking a duplicate next to it.
  const open = new Map<string, PendingApproval>();
  for (const event of requested) {
    const payload = event.payload as HqApprovalRequestedPayload;
    if (typeof payload?.toolUseId !== 'string') continue;
    if (settled.has(payload.toolUseId)) continue;
    const remainingMs = payload.deadlineAt - now;
    // Past its deadline the Brain arbiter already owns the decision, so the
    // card would offer an answer that cannot land. This is also what bounds
    // staleness to the deadline rather than to how far back the log was read.
    if (remainingMs <= 0) continue;
    open.set(payload.toolUseId, {
      ...payload,
      clientId: event.clientId,
      projectId: event.projectId,
      sessionId: event.sessionId,
      requestedAt: event.timestamp,
      remainingMs,
    });
  }

  // Most urgent first: the one closest to being decided without you.
  return [...open.values()].sort((a, b) => a.remainingMs - b.remainingMs);
}

/** The four answers an operator can give. Matches the local surfaces exactly. */
export type ApprovalDecision = 'yes' | 'no' | 'always' | 'deny';

export const APPROVAL_DECISION_LABEL: Record<ApprovalDecision, string> = {
  yes: 'Allow once',
  no: 'Refuse once',
  always: 'Always allow',
  deny: 'Deny permanently',
};

/**
 * Send a decision to the machine holding the prompt.
 *
 * Shared by the desktop view and the mobile rail so the two cannot drift on
 * the one detail that decides where the answer lands: the session stamp.
 *
 * Losing the race is a normal outcome, not a fault — the prompt is live on the
 * surface that raised it too. The server's "no longer pending" rejection is
 * surfaced verbatim rather than swallowed, because an operator who is not told
 * will assume their answer applied.
 */
export function useAnswerApproval(): {
  answer: (approval: PendingApproval, decision: ApprovalDecision) => Promise<void>;
  pendingFor: (toolUseId: string) => boolean;
} {
  const addToast = useToastStore((state) => state.addToast);
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(() => new Set());

  const answer = useCallback(
    async (approval: PendingApproval, decision: ApprovalDecision): Promise<void> => {
      setInFlight((current) => new Set(current).add(approval.toolUseId));
      try {
        await postCommand(approval.clientId, 'approve', {
          toolUseId: approval.toolUseId,
          decision,
          // A host can hold several sessions at once (one per browser tab).
          // Without this the command falls back to whichever it calls its
          // leader — a different conversation than the one on screen.
          ...(approval.sessionId ? { sessionId: approval.sessionId } : {}),
        });
        addToast(
          `${approval.toolName}: ${APPROVAL_DECISION_LABEL[decision].toLowerCase()}`,
          'success',
        );
      } catch (error) {
        addToast(error instanceof Error ? error.message : String(error), 'warning');
      } finally {
        setInFlight((current) => {
          const next = new Set(current);
          next.delete(approval.toolUseId);
          return next;
        });
      }
    },
    [addToast],
  );

  return { answer, pendingFor: (toolUseId) => inFlight.has(toolUseId) };
}
