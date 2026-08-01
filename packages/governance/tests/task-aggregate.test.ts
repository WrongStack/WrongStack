import { describe, expect, it } from 'vitest';
import {
  applyGovernanceEvent,
  decideGovernanceCommand,
  type GovernanceCommand,
  type GovernanceEvent,
  PLAN_VERSION_SCHEMA_VERSION,
  type PlanVersionV1,
  replayTaskEvents,
  TASK_CONTRACT_SCHEMA_VERSION,
  type TaskAggregate,
  type TaskContractV1,
  type TransitionFacts,
} from '../src/index.js';

const facts: TransitionFacts = {
  contractApproved: true,
  planApproved: true,
  withinAutonomyEnvelope: true,
  authorization: 'automatic',
  executionGrantValid: true,
  snapshotCurrent: true,
  requiredEvidenceSatisfied: true,
  blockingFindings: 0,
  rollbackVerified: true,
};

function contract(): TaskContractV1 {
  return {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    taskId: 'task-1',
    contractVersion: 1,
    projectId: 'project-1',
    sourceRequest: 'Exercise the governance aggregate without runtime integration.',
    policyVersion: 'policy-1',
    repository: { rootIdentity: 'repo-hash', baselinePolicy: 'required' },
    requirements: [
      { id: 'req-1', text: 'Keep state deterministic.', acceptanceCriteriaIds: ['ac-1'] },
    ],
    acceptanceCriteria: [
      { id: 'ac-1', statement: 'Replay is deterministic.', evidenceKinds: ['test'] },
    ],
    autonomy: {
      tier: 'A2',
      allowedOperations: ['repository_read', 'file_edit', 'focused_check'],
      humanApprovalRequiredFor: [],
      allowedPaths: ['packages/governance/**'],
      deniedPaths: [],
      budget: {
        maxChangedFiles: 10,
        maxChangedLines: 1_000,
        maxNewDependencies: 0,
        maxRetries: 3,
        maxReplans: 2,
        maxSubagents: 2,
        maxWallClockMs: 900_000,
      },
      autoAuthorizePlan: true,
      autoReplanLimit: 2,
      autoResolveReviewFixes: true,
    },
    requiredChecks: [{ id: 'check-1', kind: 'test', required: true, requirementIds: ['req-1'] }],
    requiredReviewDimensions: ['correctness'],
    rollbackClass: 'git_revert',
    assumptions: [],
    sources: {
      requirements: 'explicit_user',
      scope: 'project_policy',
      checks: 'deterministic_inference',
      autonomy: 'project_policy',
    },
  };
}

function plan(version = 1, parentPlanVersion: number | null = null): PlanVersionV1 {
  return {
    schemaVersion: PLAN_VERSION_SCHEMA_VERSION,
    planId: 'plan-1',
    taskId: 'task-1',
    planVersion: version,
    parentPlanVersion,
    contractVersion: 1,
    createdBy: 'model',
    createdAt: `2026-08-01T00:00:0${version}.000Z`,
    changeReason: version === 1 ? 'Initial plan.' : 'Bounded replan.',
    steps: [
      {
        id: 'implement',
        title: 'Implement',
        description: 'Implement the bounded change.',
        operations: ['file_edit'],
        expectedPaths: ['packages/governance/src/task-aggregate.ts'],
        requirementIds: ['req-1'],
        acceptanceCriteriaIds: ['ac-1'],
        requiredCheckIds: ['check-1'],
      },
    ],
    edges: [],
  };
}

function command(
  type: GovernanceCommand['type'],
  expectedRevision: number,
  extra: Record<string, unknown>,
): GovernanceCommand {
  return {
    type,
    commandId: `command-${expectedRevision + 1}-${type}`,
    taskId: 'task-1',
    expectedRevision,
    actor: 'model',
    issuedAt: `2026-08-01T00:01:${String(expectedRevision).padStart(2, '0')}.000Z`,
    ...extra,
  } as GovernanceCommand;
}

function decideAndApply(
  aggregate: TaskAggregate | null,
  nextCommand: GovernanceCommand,
): { aggregate: TaskAggregate; event: GovernanceEvent } {
  const decision = decideGovernanceCommand(aggregate, nextCommand, { transitionFacts: facts });
  expect(decision).toMatchObject({ accepted: true });
  if (!decision.accepted) throw new Error(decision.message);
  const applied = applyGovernanceEvent(aggregate, decision.event);
  expect(applied).toMatchObject({ applied: true });
  if (!applied.applied) throw new Error(applied.message);
  return { aggregate: applied.aggregate, event: decision.event };
}

function createdTask(): { aggregate: TaskAggregate; events: GovernanceEvent[] } {
  const created = decideAndApply(
    null,
    command('create_task', 0, { projectId: 'project-1', contract: contract() }),
  );
  return { aggregate: created.aggregate, events: [created.event] };
}

function scopedTask(): { aggregate: TaskAggregate; events: GovernanceEvent[] } {
  const created = createdTask();
  const scoped = decideAndApply(
    created.aggregate,
    command('transition_task', created.aggregate.revision, { to: 'scoped' }),
  );
  return { aggregate: scoped.aggregate, events: [...created.events, scoped.event] };
}

describe('governance task aggregate', () => {
  it('creates an immutable revision-1 aggregate from a valid contract', () => {
    const { aggregate, events } = createdTask();
    expect(aggregate).toMatchObject({
      taskId: 'task-1',
      projectId: 'project-1',
      revision: 1,
      state: 'draft',
      activeContractVersion: 1,
      activePlanVersion: null,
    });
    expect(Object.isFrozen(aggregate)).toBe(true);
    expect(Object.isFrozen(aggregate.contracts[0])).toBe(true);
    expect(events[0]).toMatchObject({ eventId: 'command-1-create_task:1', revision: 1 });
  });

  it('rejects stale commands without emitting an event', () => {
    const { aggregate } = createdTask();
    expect(
      decideGovernanceCommand(aggregate, command('transition_task', 0, { to: 'scoped' }), {
        transitionFacts: facts,
      }),
    ).toMatchObject({ accepted: false, code: 'stale_revision' });
  });

  it('requires an active plan before planned or authorized transitions', () => {
    const { aggregate } = scopedTask();
    expect(
      decideGovernanceCommand(
        aggregate,
        command('transition_task', aggregate.revision, { to: 'planned' }),
        { transitionFacts: facts },
      ),
    ).toMatchObject({ accepted: false, code: 'active_plan_missing' });
  });

  it('attaches a model-generated plan and automatically authorizes it inside the envelope', () => {
    const scoped = scopedTask();
    const attached = decideAndApply(
      scoped.aggregate,
      command('attach_plan_version', scoped.aggregate.revision, { plan: plan() }),
    );
    const planned = decideAndApply(
      attached.aggregate,
      command('transition_task', attached.aggregate.revision, { to: 'planned' }),
    );
    const authorized = decideAndApply(
      planned.aggregate,
      command('transition_task', planned.aggregate.revision, { to: 'authorized' }),
    );

    expect(authorized.aggregate).toMatchObject({
      state: 'authorized',
      activePlanVersion: 1,
      revision: 5,
    });
    expect(Object.isFrozen(authorized.aggregate.plans[0])).toBe(true);
  });

  it('requires explicit replan state and a new version before returning to planned', () => {
    const scoped = scopedTask();
    const attached = decideAndApply(
      scoped.aggregate,
      command('attach_plan_version', scoped.aggregate.revision, { plan: plan() }),
    );
    const planned = decideAndApply(
      attached.aggregate,
      command('transition_task', attached.aggregate.revision, { to: 'planned' }),
    );
    const replanRequested = decideAndApply(
      planned.aggregate,
      command('transition_task', planned.aggregate.revision, { to: 'replan_requested' }),
    );

    expect(
      decideGovernanceCommand(
        replanRequested.aggregate,
        command('transition_task', replanRequested.aggregate.revision, { to: 'planned' }),
        { transitionFacts: facts },
      ),
    ).toMatchObject({ accepted: false, code: 'replan_version_missing' });

    const attachedV2 = decideAndApply(
      replanRequested.aggregate,
      command('attach_plan_version', replanRequested.aggregate.revision, { plan: plan(2, 1) }),
    );
    const replanned = decideAndApply(
      attachedV2.aggregate,
      command('transition_task', attachedV2.aggregate.revision, { to: 'planned' }),
    );
    expect(replanned.aggregate).toMatchObject({
      state: 'planned',
      activePlanVersion: 2,
      replanRequestedFromPlanVersion: null,
    });
  });

  it('lets the model propose completion but preserves policy admission authority', () => {
    const scoped = scopedTask();
    const attached = decideAndApply(
      scoped.aggregate,
      command('attach_plan_version', scoped.aggregate.revision, { plan: plan() }),
    );
    let current = decideAndApply(
      attached.aggregate,
      command('transition_task', attached.aggregate.revision, { to: 'planned' }),
    ).aggregate;
    for (const to of ['authorized', 'executing', 'proposed_complete'] as const) {
      current = decideAndApply(
        current,
        command('transition_task', current.revision, { to }),
      ).aggregate;
    }
    expect(current.state).toBe('proposed_complete');
  });

  it('replays the same immutable aggregate and rejects event revision gaps', () => {
    const scoped = scopedTask();
    const attached = decideAndApply(
      scoped.aggregate,
      command('attach_plan_version', scoped.aggregate.revision, { plan: plan() }),
    );
    const events = [...scoped.events, attached.event];
    const replayed = replayTaskEvents(events);
    expect(replayed).toMatchObject({ replayed: true });
    if (replayed.replayed) expect(replayed.aggregate).toEqual(attached.aggregate);

    const gapEvent = { ...attached.event, revision: attached.event.revision + 1 };
    expect(replayTaskEvents([...scoped.events, gapEvent])).toMatchObject({
      replayed: false,
      code: 'event_revision_gap',
    });
  });

  it('rejects replay when a transition event does not match current state', () => {
    const created = createdTask();
    const invalidEvent: GovernanceEvent = {
      eventId: 'invalid:2',
      commandId: 'invalid',
      taskId: 'task-1',
      revision: 2,
      actor: 'policy',
      occurredAt: '2026-08-01T00:02:00.000Z',
      payload: { type: 'workflow_transitioned', from: 'planned', to: 'authorized' },
    };
    expect(replayTaskEvents([...created.events, invalidEvent])).toMatchObject({
      replayed: false,
      code: 'event_state_mismatch',
    });
  });
});
