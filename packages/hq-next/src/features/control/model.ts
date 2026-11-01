/**
 * Control rules as pure functions: which sessions a client hosts, the frozen
 * review of a command, and how an audited command reads.
 *
 * The review is the security boundary of this screen. What the operator
 * reviewed — client, session, type, payload — is copied at review time and is
 * exactly what is sent. If that client or session goes away while the review is
 * open, sending is refused; the command never falls through to another target.
 */
import type { HqClientRecord, HqCommandAuditEntry, HqSessionSnapshotPayload } from '@wrongstack/hq';

export function canReceiveControl(client: HqClientRecord): boolean {
  return client.connected && client.capabilities.includes('control.receive');
}

/** Sessions hosted by a client: by id, or by the same process on the same machine and project. */
export function sessionsForClient(
  client: HqClientRecord,
  sessions: readonly HqSessionSnapshotPayload[],
): HqSessionSnapshotPayload[] {
  return sessions.filter(
    (session) =>
      session.clientId === client.clientId ||
      (session.machineId === client.machineId &&
        session.projectId === client.projectId &&
        session.pid !== undefined &&
        session.pid === client.pid),
  );
}

export interface Review {
  clientId: string;
  /** The target in words, as reviewed. */
  target: string;
  sessionId: string | undefined;
  type: string;
  payload: Record<string, unknown>;
  summary: string;
  danger: boolean;
  /** The word that must be typed before a destructive command is sent. */
  confirmWord: string | null;
}

export function freezeReview(input: Review): Review {
  // A deep copy: later edits to the form can never reach what was reviewed.
  return {
    ...input,
    payload: JSON.parse(JSON.stringify(input.payload)) as Record<string, unknown>,
  };
}

/** Why a frozen review can no longer be sent, or null when it still can. */
export function reviewProblem(
  review: Review,
  clients: readonly HqClientRecord[],
  sessions: readonly HqSessionSnapshotPayload[],
): string | null {
  const client = clients.find((candidate) => candidate.clientId === review.clientId);
  if (client === undefined || !client.connected) {
    return 'The target client disconnected. Nothing was sent — pick a target again.';
  }
  if (!client.capabilities.includes('control.receive')) {
    return 'The target client no longer accepts commands. Nothing was sent.';
  }
  if (
    review.sessionId !== undefined &&
    !sessionsForClient(client, sessions).some((session) => session.sessionId === review.sessionId)
  ) {
    return 'The target session ended. Nothing was sent — pick a session again.';
  }
  return null;
}

export function canSend(review: Review, confirmText: string, problem: string | null): boolean {
  return problem === null && (review.confirmWord === null || confirmText === review.confirmWord);
}

/** After this long without delivery, a queued command is probably stuck. */
export const STUCK_AFTER_MS = 60_000;

export interface AuditReading {
  label: string;
  tone: 'muted' | 'ok' | 'warn' | 'bad';
  stuck: boolean;
}

export function readAudit(entry: HqCommandAuditEntry, now: number): AuditReading {
  if (entry.status === 'acked') {
    switch (entry.ackStatus) {
      case 'completed':
        return { label: 'Done', tone: 'ok', stuck: false };
      case 'accepted':
        return { label: 'Accepted, running', tone: 'ok', stuck: false };
      case 'failed':
        return { label: 'Failed', tone: 'bad', stuck: false };
      case 'rejected':
        return { label: 'Refused by the client', tone: 'bad', stuck: false };
      default:
        return { label: 'Answered', tone: 'ok', stuck: false };
    }
  }
  if (entry.status === 'delivered') {
    return { label: 'Delivered, no answer yet', tone: 'muted', stuck: false };
  }
  const queuedFor = now - Date.parse(entry.enqueuedAt);
  const stuck = Number.isFinite(queuedFor) && queuedFor > STUCK_AFTER_MS;
  return {
    label: stuck ? 'Not delivered — is the client still connected?' : 'Waiting to be delivered',
    tone: stuck ? 'warn' : 'muted',
    stuck,
  };
}

/** Merge live lifecycle updates into the polled list, newest first. */
export function mergeAudit(
  polled: readonly HqCommandAuditEntry[],
  live: readonly HqCommandAuditEntry[],
  limit: number,
): HqCommandAuditEntry[] {
  const merged = new Map(polled.map((entry) => [entry.commandId, entry]));
  for (const entry of live) merged.set(entry.commandId, entry);
  return [...merged.values()]
    .sort((left, right) => right.enqueuedAt.localeCompare(left.enqueuedAt))
    .slice(0, limit);
}
