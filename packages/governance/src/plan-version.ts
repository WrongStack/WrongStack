import { createHash } from 'node:crypto';
import {
  decideOperationAutonomy,
  type GovernedOperation,
  type OperationAutonomyDecision,
} from './autonomy-envelope.js';
import { type TaskContractV1, validateTaskContractV1 } from './task-contract.js';

export const PLAN_VERSION_SCHEMA_VERSION = 1 as const;

interface PlanStepV1 {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly operations: readonly GovernedOperation[];
  readonly expectedPaths: readonly string[];
  readonly requirementIds: readonly string[];
  readonly acceptanceCriteriaIds: readonly string[];
  readonly requiredCheckIds: readonly string[];
}

interface PlanEdgeV1 {
  readonly fromStepId: string;
  readonly toStepId: string;
}

export interface PlanVersionV1 {
  readonly schemaVersion: typeof PLAN_VERSION_SCHEMA_VERSION;
  readonly planId: string;
  readonly taskId: string;
  readonly planVersion: number;
  readonly parentPlanVersion: number | null;
  readonly contractVersion: number;
  readonly createdBy: 'model' | 'human' | 'policy' | 'system';
  readonly createdAt: string;
  readonly changeReason: string;
  readonly steps: readonly PlanStepV1[];
  readonly edges: readonly PlanEdgeV1[];
}

function canonicalPlanValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalPlanValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entryValue]) => [key, canonicalPlanValue(entryValue)]),
    );
  }
  return value;
}

export function calculatePlanVersionFingerprint(plan: PlanVersionV1): string {
  return createHash('sha256')
    .update('wrongstack-plan-version-v1\0', 'utf8')
    .update(JSON.stringify(canonicalPlanValue(plan)), 'utf8')
    .digest('hex');
}

interface PlanStepAutonomy {
  readonly stepId: string;
  readonly automatic: boolean;
  readonly decisions: readonly OperationAutonomyDecision[];
}

interface PlanAutonomySummary {
  readonly fullyAutonomous: boolean;
  readonly automaticStepIds: readonly string[];
  readonly humanApprovalStepIds: readonly string[];
  readonly steps: readonly PlanStepAutonomy[];
}

type PlanValidationIssueCode =
  | 'contract_invalid'
  | 'invalid_schema_version'
  | 'invalid_plan_version'
  | 'invalid_parent_version'
  | 'required_value_missing'
  | 'duplicate_step_id'
  | 'duplicate_edge'
  | 'unknown_edge_step'
  | 'self_edge'
  | 'cycle_detected'
  | 'task_mismatch'
  | 'contract_version_mismatch'
  | 'operation_not_allowed'
  | 'expected_path_missing'
  | 'path_outside_scope'
  | 'unknown_requirement'
  | 'unknown_acceptance_criterion'
  | 'unknown_required_check'
  | 'requirement_unplanned'
  | 'required_check_unplanned';

interface PlanValidationIssue {
  readonly code: PlanValidationIssueCode;
  readonly path: string;
  readonly message: string;
}

type PlanValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly issues: readonly PlanValidationIssue[] };

type PlanSupersessionIssueCode =
  | 'plan_id_mismatch'
  | 'task_id_mismatch'
  | 'version_not_sequential'
  | 'parent_version_mismatch'
  | 'contract_version_regressed';

interface PlanSupersessionIssue {
  readonly code: PlanSupersessionIssueCode;
  readonly message: string;
}

type PlanSupersessionResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly issues: readonly PlanSupersessionIssue[] };

type ReplanValidationIssue =
  | PlanValidationIssue
  | PlanSupersessionIssue
  | {
      readonly code: 'invalid_completed_auto_replans';
      readonly message: string;
    };

type ReplanAuthorizationDecision =
  | {
      readonly valid: true;
      readonly automatic: true;
      readonly requiresHumanApproval: false;
      readonly nextPlanVersion: number;
    }
  | {
      readonly valid: true;
      readonly automatic: false;
      readonly requiresHumanApproval: true;
      readonly nextPlanVersion: number;
      readonly reason: 'auto_authorization_disabled' | 'auto_replan_budget_exhausted';
    }
  | {
      readonly valid: false;
      readonly issues: readonly ReplanValidationIssue[];
    };

const READ_ONLY_OPERATIONS = new Set<GovernedOperation>(['repository_read', 'focused_check']);

function isMutatingStep(step: PlanStepV1): boolean {
  return step.operations.some((operation) => !READ_ONLY_OPERATIONS.has(operation));
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function pathMatchesPattern(value: string, pattern: string): boolean {
  const path = normalizePath(value);
  const normalizedPattern = normalizePath(pattern);
  if (normalizedPattern === '*' || normalizedPattern === '**') return true;
  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (normalizedPattern.endsWith('/*')) {
    const prefix = normalizedPattern.slice(0, -2);
    if (!path.startsWith(`${prefix}/`)) return false;
    const remainder = path.slice(prefix.length + 1);
    return remainder.length > 0 && !remainder.includes('/');
  }
  return path === normalizedPattern;
}

function pathIsAllowed(contract: TaskContractV1, value: string): boolean {
  if (contract.autonomy.deniedPaths.some((pattern) => pathMatchesPattern(value, pattern))) {
    return false;
  }
  return contract.autonomy.allowedPaths.some((pattern) => pathMatchesPattern(value, pattern));
}

function addRequiredStringIssue(issues: PlanValidationIssue[], value: string, path: string): void {
  if (value.trim().length === 0) {
    issues.push({ code: 'required_value_missing', path, message: `${path} must not be empty.` });
  }
}

function findCycle(
  steps: readonly PlanStepV1[],
  edges: readonly PlanEdgeV1[],
): readonly string[] | null {
  const adjacency = new Map(steps.map((step) => [step.id, [] as string[]]));
  for (const edge of edges) adjacency.get(edge.fromStepId)?.push(edge.toStepId);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  // Depth-first search over an explicit frame stack rather than the call stack.
  // The recursive form descended once per edge, so a plan shaped as a single
  // chain recursed as deep as it had steps — and the protocol decoder accepts up
  // to 10 000 steps, which overflows the call stack outright. A plan the
  // protocol accepted could therefore not be validated at all; it surfaced as an
  // unrelated `store_failure` from the server's catch-all rather than as a
  // validation issue. Colouring is unchanged: `visiting` is grey, `visited` is
  // black, and `path` is the grey chain a back edge closes.
  interface Frame {
    readonly id: string;
    readonly next: readonly string[];
    index: number;
  }

  for (const step of steps) {
    if (visited.has(step.id)) continue;
    visiting.add(step.id);
    path.push(step.id);
    const frames: Frame[] = [{ id: step.id, next: adjacency.get(step.id) ?? [], index: 0 }];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      if (frame.index < frame.next.length) {
        const next = frame.next[frame.index]!;
        frame.index += 1;
        if (visiting.has(next)) return [...path.slice(path.indexOf(next)), next];
        if (visited.has(next)) continue;
        visiting.add(next);
        path.push(next);
        frames.push({ id: next, next: adjacency.get(next) ?? [], index: 0 });
        continue;
      }
      frames.pop();
      path.pop();
      visiting.delete(frame.id);
      visited.add(frame.id);
    }
  }
  return null;
}

function classifyPlanStepAutonomy(
  contract: TaskContractV1,
  step: PlanStepV1,
): PlanStepAutonomy {
  const decisions = step.operations.map((operation) =>
    decideOperationAutonomy(contract.autonomy, operation),
  );
  return {
    stepId: step.id,
    automatic: decisions.every((decision) => decision.allowed),
    decisions,
  };
}

export function summarizePlanAutonomy(
  contract: TaskContractV1,
  plan: PlanVersionV1,
): PlanAutonomySummary {
  const steps = plan.steps.map((step) => classifyPlanStepAutonomy(contract, step));
  const automaticStepIds = steps.filter((step) => step.automatic).map((step) => step.stepId);
  const humanApprovalStepIds = steps.filter((step) => !step.automatic).map((step) => step.stepId);
  return {
    fullyAutonomous: humanApprovalStepIds.length === 0,
    automaticStepIds,
    humanApprovalStepIds,
    steps,
  };
}

export function validatePlanVersionV1(
  plan: PlanVersionV1,
  contract: TaskContractV1,
): PlanValidationResult {
  const issues: PlanValidationIssue[] = [];

  if (!validateTaskContractV1(contract).valid) {
    issues.push({
      code: 'contract_invalid',
      path: 'contract',
      message: 'The referenced task contract is not valid.',
    });
  }
  if (plan.schemaVersion !== PLAN_VERSION_SCHEMA_VERSION) {
    issues.push({
      code: 'invalid_schema_version',
      path: 'schemaVersion',
      message: `Expected schemaVersion ${PLAN_VERSION_SCHEMA_VERSION}.`,
    });
  }
  if (!Number.isSafeInteger(plan.planVersion) || plan.planVersion < 1) {
    issues.push({
      code: 'invalid_plan_version',
      path: 'planVersion',
      message: 'planVersion must be a positive safe integer.',
    });
  }
  if (
    (plan.planVersion === 1 && plan.parentPlanVersion !== null) ||
    (plan.planVersion > 1 &&
      (plan.parentPlanVersion === null || plan.parentPlanVersion >= plan.planVersion))
  ) {
    issues.push({
      code: 'invalid_parent_version',
      path: 'parentPlanVersion',
      message: 'The first plan has no parent; later plans must reference an earlier version.',
    });
  }

  addRequiredStringIssue(issues, plan.planId, 'planId');
  addRequiredStringIssue(issues, plan.taskId, 'taskId');
  addRequiredStringIssue(issues, plan.createdAt, 'createdAt');
  addRequiredStringIssue(issues, plan.changeReason, 'changeReason');

  if (plan.taskId !== contract.taskId) {
    issues.push({
      code: 'task_mismatch',
      path: 'taskId',
      message: 'The plan and task contract must reference the same task.',
    });
  }
  if (plan.contractVersion !== contract.contractVersion) {
    issues.push({
      code: 'contract_version_mismatch',
      path: 'contractVersion',
      message: 'The plan must reference the exact task contract version it was created for.',
    });
  }
  if (plan.steps.length === 0) {
    issues.push({
      code: 'required_value_missing',
      path: 'steps',
      message: 'A plan requires at least one step.',
    });
  }

  const stepIds = new Set<string>();
  const requirementIds = new Set(contract.requirements.map((requirement) => requirement.id));
  const criterionIds = new Set(contract.acceptanceCriteria.map((criterion) => criterion.id));
  const checkIds = new Set(contract.requiredChecks.map((check) => check.id));
  const plannedRequirements = new Set<string>();
  const plannedChecks = new Set<string>();

  for (const step of plan.steps) {
    if (stepIds.has(step.id)) {
      issues.push({
        code: 'duplicate_step_id',
        path: 'steps',
        message: `Duplicate plan step id "${step.id}".`,
      });
    }
    stepIds.add(step.id);
    addRequiredStringIssue(issues, step.id, 'steps[].id');
    addRequiredStringIssue(issues, step.title, `steps[${step.id}].title`);
    addRequiredStringIssue(issues, step.description, `steps[${step.id}].description`);

    if (step.operations.length === 0) {
      issues.push({
        code: 'required_value_missing',
        path: `steps[${step.id}].operations`,
        message: 'Each plan step requires at least one operation.',
      });
    }
    for (const operation of step.operations) {
      if (!contract.autonomy.allowedOperations.includes(operation)) {
        issues.push({
          code: 'operation_not_allowed',
          path: `steps[${step.id}].operations`,
          message: `Operation "${operation}" is not allowed by the task contract.`,
        });
      }
    }
    if (isMutatingStep(step) && step.expectedPaths.length === 0) {
      issues.push({
        code: 'expected_path_missing',
        path: `steps[${step.id}].expectedPaths`,
        message: 'Mutating plan steps require at least one expected path.',
      });
    }
    for (const expectedPath of step.expectedPaths) {
      if (!pathIsAllowed(contract, expectedPath)) {
        issues.push({
          code: 'path_outside_scope',
          path: `steps[${step.id}].expectedPaths`,
          message: `Path "${expectedPath}" is outside the task contract scope.`,
        });
      }
    }
    for (const requirementId of step.requirementIds) {
      if (!requirementIds.has(requirementId)) {
        issues.push({
          code: 'unknown_requirement',
          path: `steps[${step.id}].requirementIds`,
          message: `Unknown requirement "${requirementId}".`,
        });
      } else {
        plannedRequirements.add(requirementId);
      }
    }
    for (const criterionId of step.acceptanceCriteriaIds) {
      if (!criterionIds.has(criterionId)) {
        issues.push({
          code: 'unknown_acceptance_criterion',
          path: `steps[${step.id}].acceptanceCriteriaIds`,
          message: `Unknown acceptance criterion "${criterionId}".`,
        });
      }
    }
    for (const checkId of step.requiredCheckIds) {
      if (!checkIds.has(checkId)) {
        issues.push({
          code: 'unknown_required_check',
          path: `steps[${step.id}].requiredCheckIds`,
          message: `Unknown required check "${checkId}".`,
        });
      } else {
        plannedChecks.add(checkId);
      }
    }
  }

  for (const requirement of contract.requirements) {
    if (!plannedRequirements.has(requirement.id)) {
      issues.push({
        code: 'requirement_unplanned',
        path: 'steps[].requirementIds',
        message: `Requirement "${requirement.id}" is not covered by any plan step.`,
      });
    }
  }
  for (const check of contract.requiredChecks) {
    if (check.required && !plannedChecks.has(check.id)) {
      issues.push({
        code: 'required_check_unplanned',
        path: 'steps[].requiredCheckIds',
        message: `Required check "${check.id}" is not covered by any plan step.`,
      });
    }
  }

  const seenEdges = new Set<string>();
  for (const edge of plan.edges) {
    const edgeKey = `${edge.fromStepId}\u0000${edge.toStepId}`;
    if (seenEdges.has(edgeKey)) {
      issues.push({ code: 'duplicate_edge', path: 'edges', message: 'Duplicate plan edge.' });
    }
    seenEdges.add(edgeKey);
    if (edge.fromStepId === edge.toStepId) {
      issues.push({
        code: 'self_edge',
        path: 'edges',
        message: 'A plan step cannot depend on itself.',
      });
    }
    if (!stepIds.has(edge.fromStepId) || !stepIds.has(edge.toStepId)) {
      issues.push({
        code: 'unknown_edge_step',
        path: 'edges',
        message: `Edge ${edge.fromStepId} -> ${edge.toStepId} references an unknown step.`,
      });
    }
  }

  const cycle = findCycle(plan.steps, plan.edges);
  if (cycle) {
    issues.push({
      code: 'cycle_detected',
      path: 'edges',
      message: `Plan graph contains a cycle: ${cycle.join(' -> ')}.`,
    });
  }

  return issues.length === 0 ? { valid: true } : { valid: false, issues };
}

export function validatePlanSupersession(
  previous: PlanVersionV1,
  next: PlanVersionV1,
): PlanSupersessionResult {
  const issues: PlanSupersessionIssue[] = [];
  if (next.planId !== previous.planId) {
    issues.push({ code: 'plan_id_mismatch', message: 'A replan must preserve planId.' });
  }
  if (next.taskId !== previous.taskId) {
    issues.push({ code: 'task_id_mismatch', message: 'A replan must preserve taskId.' });
  }
  if (next.planVersion !== previous.planVersion + 1) {
    issues.push({
      code: 'version_not_sequential',
      message: 'A replan must create exactly the next plan version.',
    });
  }
  if (next.parentPlanVersion !== previous.planVersion) {
    issues.push({
      code: 'parent_version_mismatch',
      message: 'A replan must reference the exact plan version it supersedes.',
    });
  }
  if (next.contractVersion < previous.contractVersion) {
    issues.push({
      code: 'contract_version_regressed',
      message: 'A replan cannot target an older task contract version.',
    });
  }
  return issues.length === 0 ? { valid: true } : { valid: false, issues };
}

export function decideReplanAuthorization(
  contract: TaskContractV1,
  previous: PlanVersionV1,
  next: PlanVersionV1,
  completedAutomaticReplans: number,
): ReplanAuthorizationDecision {
  const planValidation = validatePlanVersionV1(next, contract);
  const supersession = validatePlanSupersession(previous, next);
  const issues: ReplanValidationIssue[] = [];

  if (!planValidation.valid) issues.push(...planValidation.issues);
  if (!supersession.valid) issues.push(...supersession.issues);
  if (!Number.isSafeInteger(completedAutomaticReplans) || completedAutomaticReplans < 0) {
    issues.push({
      code: 'invalid_completed_auto_replans',
      message: 'completedAutomaticReplans must be a non-negative safe integer.',
    });
  }
  if (issues.length > 0) return { valid: false, issues };

  if (!contract.autonomy.autoAuthorizePlan) {
    return {
      valid: true,
      automatic: false,
      requiresHumanApproval: true,
      nextPlanVersion: next.planVersion,
      reason: 'auto_authorization_disabled',
    };
  }
  if (completedAutomaticReplans >= contract.autonomy.autoReplanLimit) {
    return {
      valid: true,
      automatic: false,
      requiresHumanApproval: true,
      nextPlanVersion: next.planVersion,
      reason: 'auto_replan_budget_exhausted',
    };
  }
  return {
    valid: true,
    automatic: true,
    requiresHumanApproval: false,
    nextPlanVersion: next.planVersion,
  };
}

export function freezePlanVersionV1(plan: PlanVersionV1): PlanVersionV1 {
  const steps = plan.steps.map((step) =>
    Object.freeze({
      ...step,
      operations: Object.freeze([...step.operations]),
      expectedPaths: Object.freeze([...step.expectedPaths]),
      requirementIds: Object.freeze([...step.requirementIds]),
      acceptanceCriteriaIds: Object.freeze([...step.acceptanceCriteriaIds]),
      requiredCheckIds: Object.freeze([...step.requiredCheckIds]),
    }),
  );
  const edges = plan.edges.map((edge) => Object.freeze({ ...edge }));
  return Object.freeze({
    ...plan,
    steps: Object.freeze(steps),
    edges: Object.freeze(edges),
  });
}
