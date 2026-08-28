import {
  freezePlanVersionV1,
  type PlanVersionV1,
  validatePlanSupersession,
  validatePlanVersionV1,
} from './plan-version.js';
import {
  freezeTaskContractV1,
  type TaskContractV1,
  validateTaskContractV1,
} from './task-contract.js';
import {
  decideTransition,
  type GovernanceActor,
  type TransitionFacts,
} from './transition-engine.js';
import type { WorkflowState } from './workflow-state.js';

interface GovernanceCommandMetadata {
  readonly commandId: string;
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly actor: GovernanceActor;
  readonly issuedAt: string;
}

export type GovernanceCommand = GovernanceCommandMetadata &
  (
    | {
        readonly type: 'create_task';
        readonly projectId: string;
        readonly contract: TaskContractV1;
      }
    | {
        readonly type: 'attach_plan_version';
        readonly plan: PlanVersionV1;
      }
    | {
        readonly type: 'transition_task';
        readonly to: WorkflowState;
      }
  );

export interface GovernanceDecisionContext {
  /** Trusted facts computed by deterministic policy/adapters, never copied from model arguments. */
  readonly transitionFacts?: TransitionFacts | undefined;
}

type GovernanceEventPayload =
  | {
      readonly type: 'task_created';
      readonly projectId: string;
      readonly contract: TaskContractV1;
    }
  | {
      readonly type: 'plan_version_attached';
      readonly plan: PlanVersionV1;
    }
  | {
      readonly type: 'workflow_transitioned';
      readonly from: WorkflowState;
      readonly to: WorkflowState;
    };

export interface GovernanceEvent {
  readonly eventId: string;
  readonly commandId: string;
  readonly taskId: string;
  readonly revision: number;
  readonly actor: GovernanceActor;
  readonly occurredAt: string;
  readonly payload: GovernanceEventPayload;
}

export interface TaskAggregate {
  readonly taskId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly state: WorkflowState;
  readonly contracts: readonly TaskContractV1[];
  readonly activeContractVersion: number;
  readonly plans: readonly PlanVersionV1[];
  readonly activePlanVersion: number | null;
  readonly replanRequestedFromPlanVersion: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type CommandRejectionCode =
  | 'stale_revision'
  | 'task_already_exists'
  | 'task_missing'
  | 'task_identity_mismatch'
  | 'project_identity_mismatch'
  | 'initial_contract_version_invalid'
  | 'contract_invalid'
  | 'plan_invalid'
  | 'plan_supersession_invalid'
  | 'plan_attach_state_invalid'
  | 'active_plan_missing'
  | 'replan_version_missing'
  | 'transition_facts_missing'
  | 'transition_rejected';

export type GovernanceCommandDecision =
  | { readonly accepted: true; readonly event: GovernanceEvent }
  | {
      readonly accepted: false;
      readonly code: CommandRejectionCode;
      readonly message: string;
      readonly details?: readonly unknown[] | undefined;
    };

type EventApplyRejectionCode =
  | 'first_event_not_task_created'
  | 'duplicate_task_created'
  | 'task_id_mismatch'
  | 'event_revision_gap'
  | 'event_state_mismatch'
  | 'event_requires_existing_task';

type EventApplyResult =
  | { readonly applied: true; readonly aggregate: TaskAggregate }
  | {
      readonly applied: false;
      readonly code: EventApplyRejectionCode;
      readonly message: string;
    };

type TaskReplayResult =
  | { readonly replayed: true; readonly aggregate: TaskAggregate }
  | {
      readonly replayed: false;
      readonly eventIndex: number;
      readonly code: EventApplyRejectionCode;
      readonly message: string;
    };

function rejectCommand(
  code: CommandRejectionCode,
  message: string,
  details?: readonly unknown[],
): GovernanceCommandDecision {
  return { accepted: false, code, message, ...(details ? { details } : {}) };
}

function makeEvent(
  command: GovernanceCommand,
  revision: number,
  payload: GovernanceEventPayload,
): GovernanceEvent {
  return Object.freeze({
    eventId: `${command.commandId}:${revision}`,
    commandId: command.commandId,
    taskId: command.taskId,
    revision,
    actor: command.actor,
    occurredAt: command.issuedAt,
    payload: Object.freeze(payload),
  });
}

function currentContract(aggregate: TaskAggregate): TaskContractV1 {
  const contract = aggregate.contracts.find(
    (candidate) => candidate.contractVersion === aggregate.activeContractVersion,
  );
  if (!contract) throw new Error('Task aggregate has no active contract.');
  return contract;
}

function activePlan(aggregate: TaskAggregate): PlanVersionV1 | undefined {
  if (aggregate.activePlanVersion === null) return undefined;
  return aggregate.plans.find((plan) => plan.planVersion === aggregate.activePlanVersion);
}

export function decideGovernanceCommand(
  aggregate: TaskAggregate | null,
  command: GovernanceCommand,
  context: GovernanceDecisionContext = {},
): GovernanceCommandDecision {
  const currentRevision = aggregate?.revision ?? 0;
  if (command.expectedRevision !== currentRevision) {
    return rejectCommand(
      'stale_revision',
      `Expected revision ${command.expectedRevision}, current revision is ${currentRevision}.`,
    );
  }

  if (command.type === 'create_task') {
    if (aggregate) return rejectCommand('task_already_exists', 'The task already exists.');
    if (command.contract.taskId !== command.taskId) {
      return rejectCommand('task_identity_mismatch', 'Command and contract task ids must match.');
    }
    if (command.contract.projectId !== command.projectId) {
      return rejectCommand(
        'project_identity_mismatch',
        'Command and contract project ids must match.',
      );
    }
    if (command.contract.contractVersion !== 1) {
      return rejectCommand(
        'initial_contract_version_invalid',
        'The initial task contract must be version 1.',
      );
    }
    const validation = validateTaskContractV1(command.contract);
    if (!validation.valid) {
      return rejectCommand(
        'contract_invalid',
        'The initial task contract is invalid.',
        validation.issues,
      );
    }
    return {
      accepted: true,
      event: makeEvent(command, 1, {
        type: 'task_created',
        projectId: command.projectId,
        contract: freezeTaskContractV1(command.contract),
      }),
    };
  }

  if (!aggregate) return rejectCommand('task_missing', 'The task does not exist.');
  if (command.taskId !== aggregate.taskId) {
    return rejectCommand('task_identity_mismatch', 'Command and aggregate task ids must match.');
  }

  if (command.type === 'attach_plan_version') {
    const contract = currentContract(aggregate);
    const validation = validatePlanVersionV1(command.plan, contract);
    if (!validation.valid) {
      return rejectCommand('plan_invalid', 'The plan version is invalid.', validation.issues);
    }
    if (command.plan.taskId !== aggregate.taskId) {
      return rejectCommand('task_identity_mismatch', 'Plan and aggregate task ids must match.');
    }

    const previous = activePlan(aggregate);
    if (!previous) {
      if (aggregate.state !== 'scoped') {
        return rejectCommand(
          'plan_attach_state_invalid',
          'The initial plan can only be attached while the task is scoped.',
        );
      }
    } else {
      if (aggregate.state !== 'replan_requested') {
        return rejectCommand(
          'plan_attach_state_invalid',
          'A replacement plan requires an explicit replan_requested transition.',
        );
      }
      const supersession = validatePlanSupersession(previous, command.plan);
      if (!supersession.valid) {
        return rejectCommand(
          'plan_supersession_invalid',
          'The replacement plan does not correctly supersede the active version.',
          supersession.issues,
        );
      }
    }

    return {
      accepted: true,
      event: makeEvent(command, aggregate.revision + 1, {
        type: 'plan_version_attached',
        plan: freezePlanVersionV1(command.plan),
      }),
    };
  }

  if (!context.transitionFacts) {
    return rejectCommand(
      'transition_facts_missing',
      'Trusted deterministic facts are required to evaluate a workflow transition.',
    );
  }
  if ((command.to === 'planned' || command.to === 'authorized') && !activePlan(aggregate)) {
    return rejectCommand('active_plan_missing', 'The transition requires an active plan version.');
  }
  if (
    aggregate.state === 'replan_requested' &&
    command.to === 'planned' &&
    aggregate.activePlanVersion === aggregate.replanRequestedFromPlanVersion
  ) {
    return rejectCommand(
      'replan_version_missing',
      'A new plan version must be attached before returning to planned.',
    );
  }

  const transition = decideTransition({
    from: aggregate.state,
    to: command.to,
    actor: command.actor,
    currentRevision: aggregate.revision,
    expectedRevision: command.expectedRevision,
    facts: context.transitionFacts,
  });
  if (!transition.allowed) {
    return rejectCommand('transition_rejected', transition.message, [transition]);
  }
  return {
    accepted: true,
    event: makeEvent(command, transition.nextRevision, {
      type: 'workflow_transitioned',
      from: transition.from,
      to: transition.to,
    }),
  };
}

function rejectEvent(code: EventApplyRejectionCode, message: string): EventApplyResult {
  return { applied: false, code, message };
}

export function applyGovernanceEvent(
  aggregate: TaskAggregate | null,
  event: GovernanceEvent,
): EventApplyResult {
  if (!aggregate) {
    if (event.payload.type !== 'task_created') {
      return rejectEvent('first_event_not_task_created', 'The first event must create the task.');
    }
    if (event.revision !== 1) {
      return rejectEvent('event_revision_gap', 'The first task event must have revision 1.');
    }
    if (event.payload.contract.taskId !== event.taskId) {
      return rejectEvent('task_id_mismatch', 'Event and contract task ids must match.');
    }
    return {
      applied: true,
      aggregate: Object.freeze({
        taskId: event.taskId,
        projectId: event.payload.projectId,
        revision: event.revision,
        state: 'draft',
        contracts: Object.freeze([freezeTaskContractV1(event.payload.contract)]),
        activeContractVersion: event.payload.contract.contractVersion,
        plans: Object.freeze([]),
        activePlanVersion: null,
        replanRequestedFromPlanVersion: null,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      }),
    };
  }

  if (event.taskId !== aggregate.taskId) {
    return rejectEvent('task_id_mismatch', 'Event and aggregate task ids must match.');
  }
  if (event.revision !== aggregate.revision + 1) {
    return rejectEvent(
      'event_revision_gap',
      `Expected event revision ${aggregate.revision + 1}, received ${event.revision}.`,
    );
  }
  if (event.payload.type === 'task_created') {
    return rejectEvent('duplicate_task_created', 'A task cannot be created twice.');
  }

  if (event.payload.type === 'plan_version_attached') {
    return {
      applied: true,
      aggregate: Object.freeze({
        ...aggregate,
        revision: event.revision,
        plans: Object.freeze([...aggregate.plans, freezePlanVersionV1(event.payload.plan)]),
        activePlanVersion: event.payload.plan.planVersion,
        updatedAt: event.occurredAt,
      }),
    };
  }

  if (event.payload.from !== aggregate.state) {
    return rejectEvent(
      'event_state_mismatch',
      `Event expected state ${event.payload.from}, aggregate state is ${aggregate.state}.`,
    );
  }
  return {
    applied: true,
    aggregate: Object.freeze({
      ...aggregate,
      revision: event.revision,
      state: event.payload.to,
      replanRequestedFromPlanVersion:
        event.payload.to === 'replan_requested'
          ? aggregate.activePlanVersion
          : event.payload.to === 'planned'
            ? null
            : aggregate.replanRequestedFromPlanVersion,
      updatedAt: event.occurredAt,
    }),
  };
}

export function replayTaskEvents(events: readonly GovernanceEvent[]): TaskReplayResult {
  let aggregate: TaskAggregate | null = null;
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex]!;
    const result = applyGovernanceEvent(aggregate, event);
    if (!result.applied)
      return { replayed: false, eventIndex, code: result.code, message: result.message };
    aggregate = result.aggregate;
  }
  if (!aggregate) {
    return {
      replayed: false,
      eventIndex: 0,
      code: 'first_event_not_task_created',
      message: 'At least one task_created event is required.',
    };
  }
  return { replayed: true, aggregate };
}
