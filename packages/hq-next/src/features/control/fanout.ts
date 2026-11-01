/**
 * One command, several sessions — the rules.
 *
 * Fan-out never adds authority: every target gets its own `/api/command`
 * request, so the server authorizes, trust-checks and audits each one exactly
 * as if it had been sent alone. What this module adds is the guardrail around
 * sending many at once:
 *
 *  - only conversational commands fan out (steer, FYI, queue) plus abort;
 *    shell commands, spawns and broadcasts stay one target at a time;
 *  - the review freezes the exact target list, and the operator types the
 *    number of targets (abort: `ABORT <n>`) before anything is sent;
 *  - a target that disappears after review is skipped and reported, never
 *    swapped for another;
 *  - an authorization refusal stops the run, because the rest would be
 *    refused the same way.
 */
import type { HqClientRecord, HqSessionSnapshotPayload } from '@wrongstack/hq';
import { canReceiveControl, sessionsForClient } from './model';

export const FANOUT_TYPES = ['steer', 'btw', 'queue', 'abort'] as const;
export type FanoutType = (typeof FANOUT_TYPES)[number];

/** A ceiling on one send; larger fleets are narrowed by scope first. */
export const MAX_FANOUT_TARGETS = 50;

export interface FanoutTarget {
  clientId: string;
  sessionId: string;
  /** "desk · Alpha · TUI", as reviewed. */
  label: string;
  machineId: string;
  projectId: string;
}

/** Every live session in the given fleet that can take a command. */
export function fanoutCandidates(
  clients: readonly HqClientRecord[],
  sessions: readonly HqSessionSnapshotPayload[],
): FanoutTarget[] {
  const targets: FanoutTarget[] = [];
  for (const client of clients) {
    if (!canReceiveControl(client)) continue;
    for (const session of sessionsForClient(client, sessions)) {
      targets.push({
        clientId: client.clientId,
        sessionId: session.sessionId,
        label: `${session.hostname ?? client.hostname ?? client.machineId} · ${session.projectName} · ${session.clientKind.toUpperCase()}`,
        machineId: session.machineId,
        projectId: session.projectId,
      });
    }
  }
  return targets.sort((a, b) => a.label.localeCompare(b.label));
}

export interface FanoutReview {
  type: FanoutType;
  /** The payload without a session; each request adds its own. */
  payload: Record<string, unknown>;
  summary: string;
  targets: FanoutTarget[];
  confirmWord: string;
}

function fanoutConfirmWord(type: FanoutType, count: number): string {
  return type === 'abort' ? `ABORT ${count}` : String(count);
}

export function freezeFanout(input: Omit<FanoutReview, 'confirmWord'>): FanoutReview {
  return {
    type: input.type,
    payload: JSON.parse(JSON.stringify(input.payload)) as Record<string, unknown>,
    summary: input.summary,
    targets: input.targets.map((target) => ({ ...target })),
    confirmWord: fanoutConfirmWord(input.type, input.targets.length),
  };
}

/** Why the review cannot be sent at all, or null. */
export function fanoutBlocker(targetCount: number): string | null {
  if (targetCount === 0) return 'Pick at least one session.';
  if (targetCount > MAX_FANOUT_TARGETS)
    return `At most ${MAX_FANOUT_TARGETS} sessions at once — narrow the scope or the selection.`;
  return null;
}

/** Reviewed targets that can no longer receive the command, by session id. */
export function vanishedTargets(
  review: FanoutReview,
  clients: readonly HqClientRecord[],
  sessions: readonly HqSessionSnapshotPayload[],
): Set<string> {
  const live = new Set(
    fanoutCandidates(clients, sessions).map((target) => `${target.clientId}|${target.sessionId}`),
  );
  return new Set(
    review.targets
      .filter((target) => !live.has(`${target.clientId}|${target.sessionId}`))
      .map((target) => target.sessionId),
  );
}

export type FanoutOutcome =
  | { state: 'sent'; commandId: string }
  | { state: 'failed'; reason: string }
  | { state: 'skipped'; reason: string };

/**
 * A refusal that would repeat for every remaining target. Read from the HTTP
 * status the request layer attaches (`HqHttpError.status`), never from the
 * message: the server's 403 text does not start with the code.
 */
function isAuthorizationRefusal(cause: unknown): boolean {
  const status =
    typeof cause === 'object' && cause !== null
      ? (cause as { status?: unknown }).status
      : undefined;
  return status === 401 || status === 403;
}

/**
 * Send the reviewed command to each target in order, one request each. The
 * caller passes the dispatcher and the current liveness check, so this stays
 * free of I/O and can be tested directly.
 */
export async function runFanout(
  review: FanoutReview,
  send: (clientId: string, type: string, payload: unknown) => Promise<{ commandId: string }>,
  stillLive: (target: FanoutTarget) => boolean,
  onOutcome: (sessionId: string, outcome: FanoutOutcome) => void,
): Promise<void> {
  let stopped: string | null = null;
  for (const target of review.targets) {
    if (stopped !== null) {
      onOutcome(target.sessionId, { state: 'skipped', reason: `Not sent: ${stopped}` });
      continue;
    }
    if (!stillLive(target)) {
      onOutcome(target.sessionId, {
        state: 'skipped',
        reason: 'The session ended or stopped accepting commands. Nothing was sent to it.',
      });
      continue;
    }
    try {
      const result = await send(target.clientId, review.type, {
        ...review.payload,
        sessionId: target.sessionId,
      });
      onOutcome(target.sessionId, { state: 'sent', commandId: result.commandId });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      onOutcome(target.sessionId, { state: 'failed', reason });
      if (isAuthorizationRefusal(cause)) stopped = 'the server refused the first one.';
    }
  }
}
