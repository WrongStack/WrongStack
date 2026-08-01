import { AUTONOMY_TIERS, GOVERNED_OPERATIONS } from './autonomy-envelope.js';
import { GOVERNANCE_OBSERVATION_CATEGORIES } from './event-store.js';
import { PLAN_VERSION_SCHEMA_VERSION } from './plan-version.js';
import {
  GOVERNANCE_SERVICE_CAPABILITIES,
  GOVERNANCE_SERVICE_PROTOCOL_VERSION,
  type GovernanceServiceRequest,
} from './service-protocol.js';
import {
  BASELINE_POLICIES,
  CONTRACT_ASSUMPTION_STATUSES,
  CONTRACT_SOURCES,
  EVIDENCE_KINDS,
  REVIEW_DIMENSIONS,
  ROLLBACK_CLASSES,
  TASK_CONTRACT_SCHEMA_VERSION,
  type TaskContractV1,
  validateTaskContractV1,
} from './task-contract.js';
import { GOVERNANCE_ACTORS } from './transition-engine.js';
import { WORKFLOW_STATES } from './workflow-state.js';

const MAX_NESTING_DEPTH = 32;
const MAX_ARRAY_ITEMS = 10_000;
const MAX_OBJECT_KEYS = 1_000;
const MAX_STRING_LENGTH = 1_000_000;

export type GovernanceProtocolDecodeIssueCode =
  | 'expected_object'
  | 'expected_array'
  | 'unknown_field'
  | 'invalid_value'
  | 'semantic_invalid'
  | 'resource_limit';

export interface GovernanceProtocolDecodeIssue {
  readonly code: GovernanceProtocolDecodeIssueCode;
  readonly path: string;
  readonly message: string;
}

export type GovernanceServiceRequestDecodeResult =
  | { readonly decoded: true; readonly request: GovernanceServiceRequest }
  | { readonly decoded: false; readonly issues: readonly GovernanceProtocolDecodeIssue[] };

type MutableIssues = GovernanceProtocolDecodeIssue[];
type JsonRecord = Record<string, unknown>;

function issue(
  issues: MutableIssues,
  code: GovernanceProtocolDecodeIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function plainRecord(value: unknown, path: string, issues: MutableIssues): JsonRecord | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    issue(issues, 'expected_object', path, `${path} must be a plain JSON object.`);
    return undefined;
  }
  const record = value as JsonRecord;
  if (Object.keys(record).length > MAX_OBJECT_KEYS) {
    issue(issues, 'resource_limit', path, `${path} exceeds the ${MAX_OBJECT_KEYS}-field limit.`);
  }
  return record;
}

function exactKeys(
  record: JsonRecord,
  allowed: readonly string[],
  path: string,
  issues: MutableIssues,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      issue(issues, 'unknown_field', `${path}.${key}`, `${path}.${key} is not allowed.`);
    }
  }
}

function stringValue(
  value: unknown,
  path: string,
  issues: MutableIssues,
  allowEmpty = false,
): void {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    issue(issues, 'invalid_value', path, `${path} must be a non-empty string.`);
    return;
  }
  if (value.length > MAX_STRING_LENGTH) {
    issue(
      issues,
      'resource_limit',
      path,
      `${path} exceeds the ${MAX_STRING_LENGTH}-character limit.`,
    );
  }
}

function timestamp(value: unknown, path: string, issues: MutableIssues): void {
  stringValue(value, path, issues);
  if (typeof value === 'string' && Number.isNaN(Date.parse(value))) {
    issue(issues, 'invalid_value', path, `${path} must be a valid timestamp.`);
  }
}

function booleanValue(value: unknown, path: string, issues: MutableIssues): void {
  if (typeof value !== 'boolean') {
    issue(issues, 'invalid_value', path, `${path} must be a boolean.`);
  }
}

function integerValue(value: unknown, path: string, issues: MutableIssues, minimum = 0): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    issue(
      issues,
      'invalid_value',
      path,
      `${path} must be a safe integer greater than or equal to ${minimum}.`,
    );
  }
}

function boundedString(
  value: unknown,
  path: string,
  issues: MutableIssues,
  maxLength: number,
): void {
  stringValue(value, path, issues);
  if (typeof value === 'string' && value.length > maxLength) {
    issue(issues, 'resource_limit', path, `${path} exceeds the ${maxLength}-character limit.`);
  }
}

function enumValue(
  value: unknown,
  allowed: readonly string[],
  path: string,
  issues: MutableIssues,
): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    issue(issues, 'invalid_value', path, `${path} has an unsupported value.`);
  }
}

function arrayValue(
  value: unknown,
  path: string,
  issues: MutableIssues,
  validate: (entry: unknown, entryPath: string, issues: MutableIssues) => void,
): void {
  if (!Array.isArray(value)) {
    issue(issues, 'expected_array', path, `${path} must be an array.`);
    return;
  }
  if (value.length > MAX_ARRAY_ITEMS) {
    issue(issues, 'resource_limit', path, `${path} exceeds the ${MAX_ARRAY_ITEMS}-item limit.`);
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    validate(value[index], `${path}[${index}]`, issues);
  }
}

function stringArray(value: unknown, path: string, issues: MutableIssues): void {
  arrayValue(value, path, issues, stringValue);
}

function enumArray(
  value: unknown,
  allowed: readonly string[],
  path: string,
  issues: MutableIssues,
): void {
  arrayValue(value, path, issues, (entry, entryPath, target) =>
    enumValue(entry, allowed, entryPath, target),
  );
}

function capabilityArray(value: unknown, path: string, issues: MutableIssues): void {
  if (!Array.isArray(value)) {
    issue(issues, 'expected_array', path, `${path} must be an array.`);
    return;
  }
  if (value.length === 0 || value.length > GOVERNANCE_SERVICE_CAPABILITIES.length) {
    issue(
      issues,
      'resource_limit',
      path,
      `${path} must contain between 1 and ${GOVERNANCE_SERVICE_CAPABILITIES.length} capabilities.`,
    );
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    enumValue(value[index], GOVERNANCE_SERVICE_CAPABILITIES, entryPath, issues);
    if (typeof value[index] === 'string') {
      if (seen.has(value[index])) {
        issue(issues, 'semantic_invalid', entryPath, `${entryPath} duplicates a capability.`);
      }
      seen.add(value[index]);
    }
  }
}

function jsonValue(value: unknown, path: string, issues: MutableIssues, depth = 0): void {
  if (depth > MAX_NESTING_DEPTH) {
    issue(
      issues,
      'resource_limit',
      path,
      `${path} exceeds the ${MAX_NESTING_DEPTH}-level nesting limit.`,
    );
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    stringValue(value, path, issues, true);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      issue(issues, 'invalid_value', path, `${path} must contain a finite JSON number.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    arrayValue(value, path, issues, (entry, entryPath, target) =>
      jsonValue(entry, entryPath, target, depth + 1),
    );
    return;
  }
  const record = plainRecord(value, path, issues);
  if (!record) return;
  for (const [key, entry] of Object.entries(record)) {
    jsonValue(entry, `${path}.${key}`, issues, depth + 1);
  }
}

function objectArray(
  value: unknown,
  path: string,
  issues: MutableIssues,
  validate: (record: JsonRecord, entryPath: string, issues: MutableIssues) => void,
): void {
  arrayValue(value, path, issues, (entry, entryPath, target) => {
    const record = plainRecord(entry, entryPath, target);
    if (record) validate(record, entryPath, target);
  });
}

function validateAutonomy(value: unknown, path: string, issues: MutableIssues): void {
  const record = plainRecord(value, path, issues);
  if (!record) return;
  exactKeys(
    record,
    [
      'tier',
      'allowedOperations',
      'humanApprovalRequiredFor',
      'allowedPaths',
      'deniedPaths',
      'budget',
      'autoAuthorizePlan',
      'autoReplanLimit',
      'autoResolveReviewFixes',
    ],
    path,
    issues,
  );
  enumValue(record.tier, AUTONOMY_TIERS, `${path}.tier`, issues);
  enumArray(record.allowedOperations, GOVERNED_OPERATIONS, `${path}.allowedOperations`, issues);
  enumArray(
    record.humanApprovalRequiredFor,
    GOVERNED_OPERATIONS,
    `${path}.humanApprovalRequiredFor`,
    issues,
  );
  stringArray(record.allowedPaths, `${path}.allowedPaths`, issues);
  stringArray(record.deniedPaths, `${path}.deniedPaths`, issues);
  const budget = plainRecord(record.budget, `${path}.budget`, issues);
  const budgetFields = [
    'maxChangedFiles',
    'maxChangedLines',
    'maxNewDependencies',
    'maxRetries',
    'maxReplans',
    'maxSubagents',
    'maxWallClockMs',
  ] as const;
  if (budget) {
    exactKeys(budget, budgetFields, `${path}.budget`, issues);
    for (const field of budgetFields) {
      integerValue(budget[field], `${path}.budget.${field}`, issues);
    }
  }
  booleanValue(record.autoAuthorizePlan, `${path}.autoAuthorizePlan`, issues);
  integerValue(record.autoReplanLimit, `${path}.autoReplanLimit`, issues);
  booleanValue(record.autoResolveReviewFixes, `${path}.autoResolveReviewFixes`, issues);
}

function validateTaskContract(value: unknown, path: string, issues: MutableIssues): void {
  const issueCount = issues.length;
  const record = plainRecord(value, path, issues);
  if (!record) return;
  exactKeys(
    record,
    [
      'schemaVersion',
      'taskId',
      'contractVersion',
      'projectId',
      'sourceRequest',
      'policyVersion',
      'repository',
      'requirements',
      'acceptanceCriteria',
      'autonomy',
      'requiredChecks',
      'requiredReviewDimensions',
      'rollbackClass',
      'assumptions',
      'sources',
    ],
    path,
    issues,
  );
  if (record.schemaVersion !== TASK_CONTRACT_SCHEMA_VERSION) {
    issue(issues, 'invalid_value', `${path}.schemaVersion`, 'Unsupported task contract schema.');
  }
  stringValue(record.taskId, `${path}.taskId`, issues);
  integerValue(record.contractVersion, `${path}.contractVersion`, issues, 1);
  stringValue(record.projectId, `${path}.projectId`, issues);
  stringValue(record.sourceRequest, `${path}.sourceRequest`, issues);
  stringValue(record.policyVersion, `${path}.policyVersion`, issues);

  const repository = plainRecord(record.repository, `${path}.repository`, issues);
  if (repository) {
    exactKeys(repository, ['rootIdentity', 'baselinePolicy'], `${path}.repository`, issues);
    stringValue(repository.rootIdentity, `${path}.repository.rootIdentity`, issues);
    enumValue(
      repository.baselinePolicy,
      BASELINE_POLICIES,
      `${path}.repository.baselinePolicy`,
      issues,
    );
  }
  objectArray(record.requirements, `${path}.requirements`, issues, (entry, entryPath, target) => {
    exactKeys(entry, ['id', 'text', 'acceptanceCriteriaIds'], entryPath, target);
    stringValue(entry.id, `${entryPath}.id`, target);
    stringValue(entry.text, `${entryPath}.text`, target);
    stringArray(entry.acceptanceCriteriaIds, `${entryPath}.acceptanceCriteriaIds`, target);
  });
  objectArray(
    record.acceptanceCriteria,
    `${path}.acceptanceCriteria`,
    issues,
    (entry, entryPath, target) => {
      exactKeys(entry, ['id', 'statement', 'evidenceKinds'], entryPath, target);
      stringValue(entry.id, `${entryPath}.id`, target);
      stringValue(entry.statement, `${entryPath}.statement`, target);
      enumArray(entry.evidenceKinds, EVIDENCE_KINDS, `${entryPath}.evidenceKinds`, target);
    },
  );
  validateAutonomy(record.autonomy, `${path}.autonomy`, issues);
  objectArray(
    record.requiredChecks,
    `${path}.requiredChecks`,
    issues,
    (entry, entryPath, target) => {
      exactKeys(entry, ['id', 'kind', 'required', 'requirementIds'], entryPath, target);
      stringValue(entry.id, `${entryPath}.id`, target);
      enumValue(entry.kind, EVIDENCE_KINDS, `${entryPath}.kind`, target);
      booleanValue(entry.required, `${entryPath}.required`, target);
      stringArray(entry.requirementIds, `${entryPath}.requirementIds`, target);
    },
  );
  enumArray(
    record.requiredReviewDimensions,
    REVIEW_DIMENSIONS,
    `${path}.requiredReviewDimensions`,
    issues,
  );
  enumValue(record.rollbackClass, ROLLBACK_CLASSES, `${path}.rollbackClass`, issues);
  objectArray(record.assumptions, `${path}.assumptions`, issues, (entry, entryPath, target) => {
    exactKeys(entry, ['id', 'statement', 'source', 'status'], entryPath, target);
    stringValue(entry.id, `${entryPath}.id`, target);
    stringValue(entry.statement, `${entryPath}.statement`, target);
    enumValue(entry.source, CONTRACT_SOURCES, `${entryPath}.source`, target);
    enumValue(entry.status, CONTRACT_ASSUMPTION_STATUSES, `${entryPath}.status`, target);
  });
  const sources = plainRecord(record.sources, `${path}.sources`, issues);
  if (sources) {
    exactKeys(sources, ['requirements', 'scope', 'checks', 'autonomy'], `${path}.sources`, issues);
    for (const field of ['requirements', 'scope', 'checks', 'autonomy'] as const) {
      enumValue(sources[field], CONTRACT_SOURCES, `${path}.sources.${field}`, issues);
    }
  }

  if (issues.length === issueCount) {
    const semantic = validateTaskContractV1(record as unknown as TaskContractV1);
    if (!semantic.valid) {
      for (const contractIssue of semantic.issues) {
        issue(issues, 'semantic_invalid', `${path}.${contractIssue.path}`, contractIssue.message);
      }
    }
  }
}

function validatePlan(value: unknown, path: string, issues: MutableIssues): void {
  const record = plainRecord(value, path, issues);
  if (!record) return;
  exactKeys(
    record,
    [
      'schemaVersion',
      'planId',
      'taskId',
      'planVersion',
      'parentPlanVersion',
      'contractVersion',
      'createdBy',
      'createdAt',
      'changeReason',
      'steps',
      'edges',
    ],
    path,
    issues,
  );
  if (record.schemaVersion !== PLAN_VERSION_SCHEMA_VERSION) {
    issue(issues, 'invalid_value', `${path}.schemaVersion`, 'Unsupported plan schema.');
  }
  stringValue(record.planId, `${path}.planId`, issues);
  stringValue(record.taskId, `${path}.taskId`, issues);
  integerValue(record.planVersion, `${path}.planVersion`, issues, 1);
  if (record.parentPlanVersion !== null) {
    integerValue(record.parentPlanVersion, `${path}.parentPlanVersion`, issues, 1);
  }
  integerValue(record.contractVersion, `${path}.contractVersion`, issues, 1);
  enumValue(record.createdBy, GOVERNANCE_ACTORS, `${path}.createdBy`, issues);
  timestamp(record.createdAt, `${path}.createdAt`, issues);
  stringValue(record.changeReason, `${path}.changeReason`, issues);
  objectArray(record.steps, `${path}.steps`, issues, (entry, entryPath, target) => {
    exactKeys(
      entry,
      [
        'id',
        'title',
        'description',
        'operations',
        'expectedPaths',
        'requirementIds',
        'acceptanceCriteriaIds',
        'requiredCheckIds',
      ],
      entryPath,
      target,
    );
    stringValue(entry.id, `${entryPath}.id`, target);
    stringValue(entry.title, `${entryPath}.title`, target);
    stringValue(entry.description, `${entryPath}.description`, target);
    enumArray(entry.operations, GOVERNED_OPERATIONS, `${entryPath}.operations`, target);
    stringArray(entry.expectedPaths, `${entryPath}.expectedPaths`, target);
    stringArray(entry.requirementIds, `${entryPath}.requirementIds`, target);
    stringArray(entry.acceptanceCriteriaIds, `${entryPath}.acceptanceCriteriaIds`, target);
    stringArray(entry.requiredCheckIds, `${entryPath}.requiredCheckIds`, target);
  });
  objectArray(record.edges, `${path}.edges`, issues, (entry, entryPath, target) => {
    exactKeys(entry, ['fromStepId', 'toStepId'], entryPath, target);
    stringValue(entry.fromStepId, `${entryPath}.fromStepId`, target);
    stringValue(entry.toStepId, `${entryPath}.toStepId`, target);
  });
}

function validateCommand(value: unknown, path: string, issues: MutableIssues): void {
  const record = plainRecord(value, path, issues);
  if (!record) return;
  const type = record.type;
  const commonKeys = ['type', 'commandId', 'taskId', 'expectedRevision', 'actor', 'issuedAt'];
  if (type === 'create_task') {
    exactKeys(record, [...commonKeys, 'projectId', 'contract'], path, issues);
  } else if (type === 'attach_plan_version') {
    exactKeys(record, [...commonKeys, 'plan'], path, issues);
  } else if (type === 'transition_task') {
    exactKeys(record, [...commonKeys, 'to'], path, issues);
  } else {
    issue(issues, 'invalid_value', `${path}.type`, `${path}.type is not a supported command.`);
    return;
  }
  stringValue(record.commandId, `${path}.commandId`, issues);
  stringValue(record.taskId, `${path}.taskId`, issues);
  integerValue(record.expectedRevision, `${path}.expectedRevision`, issues);
  enumValue(record.actor, GOVERNANCE_ACTORS, `${path}.actor`, issues);
  timestamp(record.issuedAt, `${path}.issuedAt`, issues);
  if (type === 'create_task') {
    stringValue(record.projectId, `${path}.projectId`, issues);
    validateTaskContract(record.contract, `${path}.contract`, issues);
  } else if (type === 'attach_plan_version') {
    validatePlan(record.plan, `${path}.plan`, issues);
  } else {
    enumValue(record.to, WORKFLOW_STATES, `${path}.to`, issues);
  }
}

function validateObservation(value: unknown, path: string, issues: MutableIssues): void {
  const record = plainRecord(value, path, issues);
  if (!record) return;
  exactKeys(
    record,
    ['observationId', 'projectId', 'taskId', 'source', 'category', 'observedAt', 'payload'],
    path,
    issues,
  );
  stringValue(record.observationId, `${path}.observationId`, issues);
  stringValue(record.projectId, `${path}.projectId`, issues);
  if (record.taskId !== null) stringValue(record.taskId, `${path}.taskId`, issues);
  stringValue(record.source, `${path}.source`, issues);
  enumValue(record.category, GOVERNANCE_OBSERVATION_CATEGORIES, `${path}.category`, issues);
  timestamp(record.observedAt, `${path}.observedAt`, issues);
  const payload = plainRecord(record.payload, `${path}.payload`, issues);
  if (payload) jsonValue(payload, `${path}.payload`, issues);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function decodeGovernanceServiceRequest(
  input: unknown,
): GovernanceServiceRequestDecodeResult {
  const issues: MutableIssues = [];
  const record = plainRecord(input, '$', issues);
  if (!record) return { decoded: false, issues: Object.freeze(issues) };

  if (record.protocolVersion !== GOVERNANCE_SERVICE_PROTOCOL_VERSION) {
    issue(
      issues,
      'invalid_value',
      '$.protocolVersion',
      `Only protocol version ${GOVERNANCE_SERVICE_PROTOCOL_VERSION} is supported.`,
    );
  }
  stringValue(record.requestId, '$.requestId', issues);

  switch (record.type) {
    case 'health':
      exactKeys(record, ['protocolVersion', 'requestId', 'type'], '$', issues);
      break;
    case 'read_task':
    case 'read_events':
      exactKeys(record, ['protocolVersion', 'requestId', 'type', 'taskId'], '$', issues);
      stringValue(record.taskId, '$.taskId', issues);
      break;
    case 'read_receipt':
      exactKeys(record, ['protocolVersion', 'requestId', 'type', 'commandId'], '$', issues);
      stringValue(record.commandId, '$.commandId', issues);
      break;
    case 'read_observations':
      exactKeys(record, ['protocolVersion', 'requestId', 'type', 'taskId'], '$', issues);
      if (record.taskId !== undefined) stringValue(record.taskId, '$.taskId', issues);
      break;
    case 'read_audit_observations':
    case 'read_own_capability_grant':
      exactKeys(record, ['protocolVersion', 'requestId', 'type'], '$', issues);
      break;
    case 'submit_command':
      exactKeys(record, ['protocolVersion', 'requestId', 'type', 'command'], '$', issues);
      validateCommand(record.command, '$.command', issues);
      break;
    case 'record_observation':
      exactKeys(record, ['protocolVersion', 'requestId', 'type', 'observation'], '$', issues);
      validateObservation(record.observation, '$.observation', issues);
      break;
    case 'issue_capability_grant':
      exactKeys(
        record,
        ['protocolVersion', 'requestId', 'type', 'clientId', 'capabilities', 'ttlMs'],
        '$',
        issues,
      );
      boundedString(record.clientId, '$.clientId', issues, 512);
      capabilityArray(record.capabilities, '$.capabilities', issues);
      integerValue(record.ttlMs, '$.ttlMs', issues, 1);
      break;
    case 'list_capability_grants':
      exactKeys(record, ['protocolVersion', 'requestId', 'type', 'cursor', 'limit'], '$', issues);
      if (record.cursor !== undefined) {
        boundedString(record.cursor, '$.cursor', issues, 128);
        if (typeof record.cursor === 'string' && !/^[A-Za-z0-9_-]{1,128}$/.test(record.cursor)) {
          issue(issues, 'invalid_value', '$.cursor', '$.cursor must be a token-safe identifier.');
        }
      }
      if (record.limit !== undefined) {
        integerValue(record.limit, '$.limit', issues, 1);
        if (typeof record.limit === 'number' && record.limit > 100) {
          issue(issues, 'resource_limit', '$.limit', '$.limit must not exceed 100.');
        }
      }
      break;
    case 'revoke_capability_grant':
      exactKeys(record, ['protocolVersion', 'requestId', 'type', 'grantId', 'reason'], '$', issues);
      boundedString(record.grantId, '$.grantId', issues, 128);
      if (typeof record.grantId === 'string' && !/^[A-Za-z0-9_-]{1,128}$/.test(record.grantId)) {
        issue(issues, 'invalid_value', '$.grantId', '$.grantId must be a token-safe identifier.');
      }
      if (record.reason !== undefined) boundedString(record.reason, '$.reason', issues, 512);
      break;
    case 'rotate_capability_grant':
      exactKeys(
        record,
        ['protocolVersion', 'requestId', 'type', 'grantId', 'ttlMs', 'reason'],
        '$',
        issues,
      );
      boundedString(record.grantId, '$.grantId', issues, 128);
      if (typeof record.grantId === 'string' && !/^[A-Za-z0-9_-]{1,128}$/.test(record.grantId)) {
        issue(issues, 'invalid_value', '$.grantId', '$.grantId must be a token-safe identifier.');
      }
      integerValue(record.ttlMs, '$.ttlMs', issues, 1);
      if (record.reason !== undefined) boundedString(record.reason, '$.reason', issues, 512);
      break;
    default:
      issue(issues, 'invalid_value', '$.type', '$.type is not a supported request type.');
  }

  if (issues.length > 0) return { decoded: false, issues: Object.freeze(issues) };
  return {
    decoded: true,
    request: deepFreeze(structuredClone(record)) as unknown as GovernanceServiceRequest,
  };
}
