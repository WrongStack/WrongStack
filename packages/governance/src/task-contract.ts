import {
  type AutonomyEnvelope,
  compareAutonomyTiers,
  type GovernedOperation,
  OPERATION_MINIMUM_TIER,
} from './autonomy-envelope.js';

export const TASK_CONTRACT_SCHEMA_VERSION = 1 as const;

export const CONTRACT_SOURCES = [
  'explicit_user',
  'project_policy',
  'deterministic_inference',
  'model_proposal',
] as const;
type ContractSource = (typeof CONTRACT_SOURCES)[number];

export const EVIDENCE_KINDS = [
  'test',
  'typecheck',
  'lint',
  'build',
  'static_analysis',
  'security',
  'api_compatibility',
  'schema',
  'performance',
  'review',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const REVIEW_DIMENSIONS = [
  'correctness',
  'requirements_traceability',
  'security_permissions',
  'api_schema_compatibility',
  'testing_evidence',
  'performance_resources',
  'concurrency_recovery',
  'maintainability_architecture',
] as const;
type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number];

export const ROLLBACK_CLASSES = [
  'isolated_discard',
  'git_revert',
  'verified_compensation',
  'manual_only',
  'irreversible',
] as const;
type RollbackClass = (typeof ROLLBACK_CLASSES)[number];

export const CONTRACT_ASSUMPTION_STATUSES = [
  'unverified',
  'verified',
  'rejected',
  'expired',
] as const;

export const BASELINE_POLICIES = ['required', 'optional', 'read_only'] as const;

interface TaskRequirement {
  readonly id: string;
  readonly text: string;
  readonly acceptanceCriteriaIds: readonly string[];
}

interface AcceptanceCriterion {
  readonly id: string;
  readonly statement: string;
  readonly evidenceKinds: readonly EvidenceKind[];
}

interface RequiredCheck {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly required: boolean;
  readonly requirementIds: readonly string[];
}

interface ContractAssumption {
  readonly id: string;
  readonly statement: string;
  readonly source: ContractSource;
  readonly status: (typeof CONTRACT_ASSUMPTION_STATUSES)[number];
}

export interface TaskContractV1 {
  readonly schemaVersion: typeof TASK_CONTRACT_SCHEMA_VERSION;
  readonly taskId: string;
  readonly contractVersion: number;
  readonly projectId: string;
  readonly sourceRequest: string;
  readonly policyVersion: string;
  readonly repository: {
    readonly rootIdentity: string;
    readonly baselinePolicy: (typeof BASELINE_POLICIES)[number];
  };
  readonly requirements: readonly TaskRequirement[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly autonomy: AutonomyEnvelope;
  readonly requiredChecks: readonly RequiredCheck[];
  readonly requiredReviewDimensions: readonly ReviewDimension[];
  readonly rollbackClass: RollbackClass;
  readonly assumptions: readonly ContractAssumption[];
  readonly sources: {
    readonly requirements: ContractSource;
    readonly scope: ContractSource;
    readonly checks: ContractSource;
    readonly autonomy: ContractSource;
  };
}

type ContractValidationIssueCode =
  | 'invalid_schema_version'
  | 'invalid_contract_version'
  | 'required_value_missing'
  | 'duplicate_id'
  | 'unknown_acceptance_criterion'
  | 'unknown_requirement'
  | 'path_scope_missing'
  | 'path_scope_conflict'
  | 'invalid_budget'
  | 'auto_replan_exceeds_budget'
  | 'approval_operation_not_allowed'
  | 'operation_exceeds_tier';

interface ContractValidationIssue {
  readonly code: ContractValidationIssueCode;
  readonly path: string;
  readonly message: string;
}

type ContractValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly issues: readonly ContractValidationIssue[] };

function addRequiredStringIssue(
  issues: ContractValidationIssue[],
  value: string,
  path: string,
): void {
  if (value.trim().length === 0) {
    issues.push({ code: 'required_value_missing', path, message: `${path} must not be empty.` });
  }
}

function addDuplicateIdIssues(
  issues: ContractValidationIssue[],
  values: readonly { readonly id: string }[],
  path: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) {
      issues.push({
        code: 'duplicate_id',
        path,
        message: `${path} contains duplicate id "${value.id}".`,
      });
    }
    seen.add(value.id);
  }
}

function validateBudget(issues: ContractValidationIssue[], envelope: AutonomyEnvelope): void {
  for (const [name, value] of Object.entries(envelope.budget)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      issues.push({
        code: 'invalid_budget',
        path: `autonomy.budget.${name}`,
        message: `autonomy.budget.${name} must be a non-negative safe integer.`,
      });
    }
  }

  if (!Number.isSafeInteger(envelope.autoReplanLimit) || envelope.autoReplanLimit < 0) {
    issues.push({
      code: 'invalid_budget',
      path: 'autonomy.autoReplanLimit',
      message: 'autonomy.autoReplanLimit must be a non-negative safe integer.',
    });
  } else if (envelope.autoReplanLimit > envelope.budget.maxReplans) {
    issues.push({
      code: 'auto_replan_exceeds_budget',
      path: 'autonomy.autoReplanLimit',
      message: 'Automatic replans cannot exceed the total replan budget.',
    });
  }
}

function validateOperationEnvelope(
  issues: ContractValidationIssue[],
  envelope: AutonomyEnvelope,
): void {
  const allowed = new Set(envelope.allowedOperations);
  const requiresApproval = new Set(envelope.humanApprovalRequiredFor);

  for (const operation of requiresApproval) {
    if (!allowed.has(operation)) {
      issues.push({
        code: 'approval_operation_not_allowed',
        path: 'autonomy.humanApprovalRequiredFor',
        message: `Operation "${operation}" requires approval but is not in allowedOperations.`,
      });
    }
  }

  for (const operation of allowed) {
    const minimumTier = OPERATION_MINIMUM_TIER[operation];
    if (compareAutonomyTiers(envelope.tier, minimumTier) < 0 && !requiresApproval.has(operation)) {
      issues.push({
        code: 'operation_exceeds_tier',
        path: 'autonomy.allowedOperations',
        message: `Operation "${operation}" requires ${minimumTier} or explicit human approval.`,
      });
    }
  }
}

function hasMutatingOperation(operations: readonly GovernedOperation[]): boolean {
  return operations.some((operation) => operation !== 'repository_read');
}

export function validateTaskContractV1(contract: TaskContractV1): ContractValidationResult {
  const issues: ContractValidationIssue[] = [];

  if (contract.schemaVersion !== TASK_CONTRACT_SCHEMA_VERSION) {
    issues.push({
      code: 'invalid_schema_version',
      path: 'schemaVersion',
      message: `Expected schemaVersion ${TASK_CONTRACT_SCHEMA_VERSION}.`,
    });
  }
  if (!Number.isSafeInteger(contract.contractVersion) || contract.contractVersion < 1) {
    issues.push({
      code: 'invalid_contract_version',
      path: 'contractVersion',
      message: 'contractVersion must be a positive safe integer.',
    });
  }

  addRequiredStringIssue(issues, contract.taskId, 'taskId');
  addRequiredStringIssue(issues, contract.projectId, 'projectId');
  addRequiredStringIssue(issues, contract.sourceRequest, 'sourceRequest');
  addRequiredStringIssue(issues, contract.policyVersion, 'policyVersion');
  addRequiredStringIssue(issues, contract.repository.rootIdentity, 'repository.rootIdentity');

  if (contract.requirements.length === 0) {
    issues.push({
      code: 'required_value_missing',
      path: 'requirements',
      message: 'At least one requirement is required.',
    });
  }
  if (contract.acceptanceCriteria.length === 0) {
    issues.push({
      code: 'required_value_missing',
      path: 'acceptanceCriteria',
      message: 'At least one acceptance criterion is required.',
    });
  }

  addDuplicateIdIssues(issues, contract.requirements, 'requirements');
  addDuplicateIdIssues(issues, contract.acceptanceCriteria, 'acceptanceCriteria');
  addDuplicateIdIssues(issues, contract.requiredChecks, 'requiredChecks');
  addDuplicateIdIssues(issues, contract.assumptions, 'assumptions');

  const criterionIds = new Set(contract.acceptanceCriteria.map((criterion) => criterion.id));
  const requirementIds = new Set(contract.requirements.map((requirement) => requirement.id));

  for (const requirement of contract.requirements) {
    addRequiredStringIssue(issues, requirement.id, 'requirements[].id');
    addRequiredStringIssue(issues, requirement.text, `requirements[${requirement.id}].text`);
    for (const criterionId of requirement.acceptanceCriteriaIds) {
      if (!criterionIds.has(criterionId)) {
        issues.push({
          code: 'unknown_acceptance_criterion',
          path: `requirements[${requirement.id}].acceptanceCriteriaIds`,
          message: `Unknown acceptance criterion "${criterionId}".`,
        });
      }
    }
  }

  for (const criterion of contract.acceptanceCriteria) {
    addRequiredStringIssue(issues, criterion.id, 'acceptanceCriteria[].id');
    addRequiredStringIssue(
      issues,
      criterion.statement,
      `acceptanceCriteria[${criterion.id}].statement`,
    );
    if (criterion.evidenceKinds.length === 0) {
      issues.push({
        code: 'required_value_missing',
        path: `acceptanceCriteria[${criterion.id}].evidenceKinds`,
        message: 'Each acceptance criterion requires at least one evidence kind.',
      });
    }
  }

  for (const check of contract.requiredChecks) {
    for (const requirementId of check.requirementIds) {
      if (!requirementIds.has(requirementId)) {
        issues.push({
          code: 'unknown_requirement',
          path: `requiredChecks[${check.id}].requirementIds`,
          message: `Unknown requirement "${requirementId}".`,
        });
      }
    }
  }

  if (
    hasMutatingOperation(contract.autonomy.allowedOperations) &&
    contract.autonomy.allowedPaths.length === 0
  ) {
    issues.push({
      code: 'path_scope_missing',
      path: 'autonomy.allowedPaths',
      message: 'Mutating operations require at least one allowed path.',
    });
  }

  const allowedPaths = new Set(contract.autonomy.allowedPaths);
  for (const deniedPath of contract.autonomy.deniedPaths) {
    if (allowedPaths.has(deniedPath)) {
      issues.push({
        code: 'path_scope_conflict',
        path: 'autonomy.deniedPaths',
        message: `Path "${deniedPath}" is both allowed and denied.`,
      });
    }
  }

  validateBudget(issues, contract.autonomy);
  validateOperationEnvelope(issues, contract.autonomy);

  return issues.length === 0 ? { valid: true } : { valid: false, issues };
}

export function freezeTaskContractV1(contract: TaskContractV1): TaskContractV1 {
  return Object.freeze({
    ...contract,
    repository: Object.freeze({ ...contract.repository }),
    requirements: Object.freeze(
      contract.requirements.map((requirement) =>
        Object.freeze({
          ...requirement,
          acceptanceCriteriaIds: Object.freeze([...requirement.acceptanceCriteriaIds]),
        }),
      ),
    ),
    acceptanceCriteria: Object.freeze(
      contract.acceptanceCriteria.map((criterion) =>
        Object.freeze({
          ...criterion,
          evidenceKinds: Object.freeze([...criterion.evidenceKinds]),
        }),
      ),
    ),
    autonomy: Object.freeze({
      ...contract.autonomy,
      allowedOperations: Object.freeze([...contract.autonomy.allowedOperations]),
      humanApprovalRequiredFor: Object.freeze([...contract.autonomy.humanApprovalRequiredFor]),
      allowedPaths: Object.freeze([...contract.autonomy.allowedPaths]),
      deniedPaths: Object.freeze([...contract.autonomy.deniedPaths]),
      budget: Object.freeze({ ...contract.autonomy.budget }),
    }),
    requiredChecks: Object.freeze(
      contract.requiredChecks.map((check) =>
        Object.freeze({
          ...check,
          requirementIds: Object.freeze([...check.requirementIds]),
        }),
      ),
    ),
    requiredReviewDimensions: Object.freeze([...contract.requiredReviewDimensions]),
    assumptions: Object.freeze(
      contract.assumptions.map((assumption) => Object.freeze({ ...assumption })),
    ),
    sources: Object.freeze({ ...contract.sources }),
  });
}
