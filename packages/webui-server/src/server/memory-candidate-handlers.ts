import type { MemoryPort } from '@wrongstack/contracts/types';
import { getSageSurface } from '@wrongstack/sage';
import type { WebSocket } from 'ws';
import { errMessage, send, withRequestId } from './ws-utils.js';

export function requiresSage(command: string): string {
  return `\`${command}\` requires the SAGE backend (Sage.enabled).`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPayload(msg: unknown): Record<string, unknown> {
  if (!isPlainObject(msg)) return {};
  return isPlainObject(msg['payload']) ? msg['payload'] : {};
}

/**
 * List review-queue candidates (hygiene / triage proposals).
 * Request:  { type: 'memory.sage.listCandidates', payload?: { includeResolved?: boolean } }
 * Response: { type: 'memory.sage.listCandidates', payload: { candidates } }
 */
export async function handleSageListCandidates(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryPort,
): Promise<void> {
  const Sage = getSageSurface(memoryStore);
  if (!Sage) {
    send(ws, {
      type: 'memory.sage.listCandidates',
      payload: withRequestId(msg, { error: requiresSage('memory.sage.listCandidates') }),
    });
    return;
  }
  try {
    const payload = readPayload(msg);
    const includeResolved = payload['includeResolved'] === true;
    if (typeof Sage.listCandidates !== 'function') {
      send(ws, {
        type: 'memory.sage.listCandidates',
        payload: withRequestId(msg, {
          error: 'listCandidates is not available on this SAGE surface',
        }),
      });
      return;
    }
    const candidates = await Sage.listCandidates(includeResolved);
    send(ws, {
      type: 'memory.sage.listCandidates',
      payload: withRequestId(msg, { candidates }),
    });
  } catch (err) {
    send(ws, {
      type: 'memory.sage.listCandidates',
      payload: withRequestId(msg, { error: errMessage(err) }),
    });
  }
}

/**
 * Resolve a pending hygiene review candidate (PR #1).
 * Request:  { type: 'memory.sage.candidateResolve', payload: { candidateId, action: 'accept'|'reject', reason?, requestId? } }
 * Response: { type: 'memory.sage.candidateResolve', payload: { candidate, resolvedAction, requestId? } }
 *
 * Every response (success and error) echoes the request's `requestId`, so a
 * client with several resolves in flight settles each wait on its own reply.
 *
 * The store handles audit + status mutation; the handler just relays the
 * payload. If the candidate id is unknown, the store returns null and we
 * surface a structured error.
 */
export async function handleSageCandidateResolve(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryPort,
): Promise<void> {
  const Sage = getSageSurface(memoryStore);
  if (!Sage) {
    send(ws, {
      type: 'memory.sage.candidateResolve',
      payload: withRequestId(msg, { error: requiresSage('memory.sage.candidateResolve') }),
    });
    return;
  }
  // `?? {}` mirrors the sibling handlers (listCandidates L29,
  // backfillRecoverable L177): client frames reach this handler without a
  // payload (the protocol decoder only requires one for server frames), and
  // the `candidateId is required` validation below — not a TypeError that
  // escapes the handler and leaves the client without a response frame —
  // is the documented answer for that input.
  const payload = readPayload(msg);
  const rawCandidateId = payload['candidateId'];
  const candidateId =
    typeof rawCandidateId === 'string' && rawCandidateId.trim().length > 0
      ? rawCandidateId
      : undefined;
  const action = payload['action'] as 'accept' | 'reject' | undefined;
  if (!candidateId) {
    send(ws, {
      type: 'memory.sage.candidateResolve',
      payload: withRequestId(msg, { error: 'candidateId is required' }),
    });
    return;
  }
  if (action !== 'accept' && action !== 'reject') {
    send(ws, {
      type: 'memory.sage.candidateResolve',
      payload: withRequestId(msg, { error: 'action must be "accept" or "reject"' }),
    });
    return;
  }
  const rawReason = payload['reason'];
  if (rawReason !== undefined && typeof rawReason !== 'string') {
    send(ws, {
      type: 'memory.sage.candidateResolve',
      payload: withRequestId(msg, { error: 'reason must be a string' }),
    });
    return;
  }
  const reason = rawReason;
  try {
    let candidate: { id: string; status: string } | undefined;
    let applied: boolean | undefined;
    if (action === 'accept') {
      // Hygiene and triage file `memory_review` proposals. Accepting one is a
      // decision about its TARGET, not a request to store the proposal text as
      // a new memory — the store refuses that — so route it through resolve.
      // Advisory investigations/updates are not authorization to delete.
      const review = await findReviewCandidate(Sage, candidateId);
      if (review) {
        if (review.suggestedAction !== 'archive' && review.suggestedAction !== 'delete') {
          throw new Error(
            'This review requires investigation. Open the target memory to verify/correct it, or keep it; accepting this proposal cannot delete or archive the memory.',
          );
        }
        const decision = review.suggestedAction === 'archive' ? 'archive' : 'delete';
        const resolution = await Sage.resolveCandidate(candidateId, decision, reason);
        if (resolution?.error) throw new Error(resolution.error);
        candidate = resolution ? { id: candidateId, status: 'accepted' } : undefined;
        applied = resolution?.applied;
      } else {
        const accepted = await Sage.acceptCandidate(candidateId);
        candidate = accepted ? { id: accepted.id, status: accepted.status ?? 'active' } : undefined;
      }
    } else {
      const rejected = await Sage.rejectCandidate(candidateId, reason ?? 'Rejected via WebUI');
      candidate = rejected ? { id: candidateId, status: 'rejected' } : undefined;
    }
    if (!candidate) {
      send(ws, {
        type: 'memory.sage.candidateResolve',
        payload: withRequestId(msg, { error: `Candidate "${candidateId}" not found` }),
      });
      return;
    }
    send(ws, {
      type: 'memory.sage.candidateResolve',
      payload: withRequestId(msg, {
        candidate,
        resolvedAction: action,
        ...(applied !== undefined ? { applied } : {}),
      }),
    });
  } catch (err) {
    send(ws, {
      type: 'memory.sage.candidateResolve',
      payload: withRequestId(msg, { error: errMessage(err) }),
    });
  }
}

export async function findReviewCandidate(
  Sage: NonNullable<ReturnType<typeof getSageSurface>>,
  candidateId: string,
): Promise<{ suggestedAction?: string | undefined } | undefined> {
  if (typeof Sage.listCandidates !== 'function') return undefined;
  const pending = await Sage.listCandidates(false);
  return pending.find((c) => c.id === candidateId && c.kind === 'memory_review');
}

/**
 * Scan deleted records and either preview (dry-run) or apply a backfill
 * that creates fresh active versions for recoverable entries (PR #3).
 *
 * Request:  { type: 'memory.sage.backfillRecoverable', payload: { apply, filter? } }
 * Response: { type: 'memory.sage.backfillRecoverable', payload: { examined, recovered, recoverable, dryRun } }
 *
 * `apply` defaults to false (dry-run preview). When true, the store writes
 * new active versions and links them to the original `deleted` records via
 * `supersedes`. The report count fields are forwarded for dashboard / UI use.
 */
export async function handleSageBackfillRecoverable(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryPort,
): Promise<void> {
  const Sage = getSageSurface(memoryStore);
  if (!Sage?.backfillRecoverable) {
    send(ws, {
      type: 'memory.sage.backfillRecoverable',
      payload: withRequestId(msg, { error: requiresSage('memory.sage.backfillRecoverable') }),
    });
    return;
  }
  const payload = readPayload(msg);
  const apply = payload['apply'] === true;
  const rawFilterInput = payload['filter'];
  if (rawFilterInput !== undefined && !isPlainObject(rawFilterInput)) {
    send(ws, {
      type: 'memory.sage.backfillRecoverable',
      payload: withRequestId(msg, { error: 'filter must be a plain object' }),
    });
    return;
  }
  const rawFilter = rawFilterInput ?? {};
  const filter: {
    kinds?: string[];
    scopes?: string[];
    updatedAfter?: string;
    updatedBefore?: string;
  } = {};
  if (rawFilter['kinds'] !== undefined) {
    if (
      !Array.isArray(rawFilter['kinds']) ||
      !rawFilter['kinds'].every((item) => typeof item === 'string')
    ) {
      send(ws, {
        type: 'memory.sage.backfillRecoverable',
        payload: withRequestId(msg, { error: 'filter.kinds must be an array of strings' }),
      });
      return;
    }
    filter.kinds = rawFilter['kinds'];
  }
  if (rawFilter['scopes'] !== undefined) {
    if (
      !Array.isArray(rawFilter['scopes']) ||
      !rawFilter['scopes'].every((item) => typeof item === 'string')
    ) {
      send(ws, {
        type: 'memory.sage.backfillRecoverable',
        payload: withRequestId(msg, { error: 'filter.scopes must be an array of strings' }),
      });
      return;
    }
    filter.scopes = rawFilter['scopes'];
  }
  if (rawFilter['updatedAfter'] !== undefined) {
    if (typeof rawFilter['updatedAfter'] !== 'string') {
      send(ws, {
        type: 'memory.sage.backfillRecoverable',
        payload: withRequestId(msg, { error: 'filter.updatedAfter must be a string' }),
      });
      return;
    }
    filter.updatedAfter = rawFilter['updatedAfter'];
  }
  if (rawFilter['updatedBefore'] !== undefined) {
    if (typeof rawFilter['updatedBefore'] !== 'string') {
      send(ws, {
        type: 'memory.sage.backfillRecoverable',
        payload: withRequestId(msg, { error: 'filter.updatedBefore must be a string' }),
      });
      return;
    }
    filter.updatedBefore = rawFilter['updatedBefore'];
  }
  try {
    const report = await Sage.backfillRecoverable({
      dryRun: !apply,
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    } as never);
    send(ws, {
      type: 'memory.sage.backfillRecoverable',
      payload: withRequestId(msg, {
        examined: report.examined,
        recovered: report.recovered,
        recoverable: report.recoverable,
        dryRun: !apply,
      }),
    });
  } catch (err) {
    send(ws, {
      type: 'memory.sage.backfillRecoverable',
      payload: withRequestId(msg, { error: errMessage(err) }),
    });
  }
}
