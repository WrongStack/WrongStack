import type { IntakeOperation } from './authorization.js';
import type { IntakeStatus } from './constants.js';
import { IntakeConflictError } from './errors.js';
import { assertTransition } from './lifecycle.js';
import type { IntakeLogger } from './logger.js';
import type { IntakeMetrics } from './metrics.js';
import type { RequirementIntakeStore, StoreUpdateOptions } from './store.js';
import type {
  IntakeContext,
  IntakeEvent,
  IntakeEventName,
  RequirementIntakeRecord,
} from './types.js';

export interface IntakeSubmitResult {
  record: RequirementIntakeRecord;
  idempotent: boolean;
}

/** The service members the submit / cancel / archive transitions need. */
export interface IntakeLifecycleHost {
  requireRecord(
    id: string,
    ctx: IntakeContext,
    operation: IntakeOperation,
  ): Promise<RequirementIntakeRecord>;
  assertSubmitReady(record: RequirementIntakeRecord): void;
  metrics: IntakeMetrics;
  logger: IntakeLogger;
  store: RequirementIntakeStore;
  emit(event: IntakeEventName, data: Omit<IntakeEvent, 'event' | 'timestamp'>): void;
}

export async function submitIntake(
  host: IntakeLifecycleHost,
  id: string,
  ctx: IntakeContext,
  expectedVersion?: number | undefined,
): Promise<IntakeSubmitResult> {
  const record = await host.requireRecord(id, ctx, 'submit');
  if (record.status === 'submitted') {
    if (
      expectedVersion !== undefined &&
      record.version !== expectedVersion &&
      record.version !== expectedVersion + 1
    ) {
      throw new IntakeConflictError(id, expectedVersion, record.version);
    }
    host.metrics.increment('intake.duplicate_submit');
    return { record, idempotent: true };
  }
  assertTransition(record.status, 'submitted');
  host.assertSubmitReady(record);

  const now = Date.now();
  let previousStatus: IntakeStatus = record.status;
  const updateOptions: StoreUpdateOptions = {
    actorId: ctx.id,
    actorType: ctx.type,
    action: 'submitted',
    expectedVersion: expectedVersion ?? record.version,
  };
  try {
    const updated = await host.store.update(id, updateOptions, (next) => {
      assertTransition(next.status, 'submitted');
      host.assertSubmitReady(next);
      previousStatus = next.status;
      updateOptions.from = next.status;
      updateOptions.to = 'submitted';
      next.status = 'submitted';
      next.submittedAt = now;
      next.submittedBy = ctx.id;
      next.submittedByType = ctx.type;
    });

    host.metrics.increment('intake.submitted');
    host.metrics.recordDuration('intake.time_to_submit', now - updated.createdAt);
    host.logger.info('intake', 'intake.submitted', {
      intakeId: updated.id,
      projectId: updated.projectId,
      actorId: ctx.id,
    });
    host.emit('RequirementIntakeSubmitted', {
      intakeId: updated.id,
      projectId: updated.projectId,
      actorId: ctx.id,
      actorType: ctx.type,
      previousStatus,
      status: 'submitted',
    });
    return { record: updated, idempotent: false };
  } catch (error) {
    // A concurrent submit won the CAS race. Re-read: if the record is now
    // submitted without an intervening version jump past expectedVersion,
    // this is a safe duplicate — report it idempotently.
    if (error instanceof IntakeConflictError) {
      const latest = await host.store.load(id);
      if (
        latest &&
        latest.status === 'submitted' &&
        (expectedVersion === undefined ||
          latest.version === expectedVersion ||
          latest.version === expectedVersion + 1)
      ) {
        host.metrics.increment('intake.duplicate_submit');
        return { record: latest, idempotent: true };
      }
    }
    throw error;
  }
}

const CLOSE_TRANSITIONS = {
  cancelled: { operation: 'cancel', event: 'RequirementIntakeCancelled' },
  archived: { operation: 'archive', event: 'RequirementIntakeArchived' },
} as const satisfies Record<string, { operation: IntakeOperation; event: IntakeEventName }>;

/** Move an intake to `cancelled` or `archived` — the two closing transitions. */
export async function closeIntake(
  host: IntakeLifecycleHost,
  id: string,
  ctx: IntakeContext,
  to: keyof typeof CLOSE_TRANSITIONS,
  opts: { reason?: string | undefined; expectedVersion?: number | undefined },
): Promise<RequirementIntakeRecord> {
  const { operation, event } = CLOSE_TRANSITIONS[to];
  const record = await host.requireRecord(id, ctx, operation);
  assertTransition(record.status, to);

  // The check above ran on a record read before the lock. Repeat it on the
  // locked copy, or a submit landing in between is overwritten: submitted ->
  // cancelled is not a transition. History and event name the real status.
  let previousStatus = record.status;
  const meta = {
    actorId: ctx.id,
    actorType: ctx.type,
    action: to,
    from: record.status,
    to,
    expectedVersion: opts.expectedVersion,
  };
  const updated = await host.store.update(id, meta, (next) => {
    assertTransition(next.status, to);
    previousStatus = meta.from = next.status;
    next.status = to;
    if (to === 'cancelled') {
      next.cancelledAt = Date.now();
      next.cancelledReason = opts.reason?.trim() || undefined;
    } else {
      next.archivedAt = Date.now();
    }
  });

  host.metrics.increment(`intake.${to}`);
  host.logger.info('intake', `intake.${to}`, {
    intakeId: updated.id,
    projectId: updated.projectId,
    actorId: ctx.id,
  });
  host.emit(event, {
    intakeId: updated.id,
    projectId: updated.projectId,
    actorId: ctx.id,
    actorType: ctx.type,
    previousStatus,
    status: to,
  });
  return updated;
}
