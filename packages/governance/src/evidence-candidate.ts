import { createHash } from 'node:crypto';

export const GOVERNANCE_EVIDENCE_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const GOVERNANCE_EVIDENCE_CANDIDATE_DEFAULT_PAGE_SIZE = 50;
export const GOVERNANCE_EVIDENCE_CANDIDATE_MAX_PAGE_SIZE = 100;

export type GovernanceEvidenceCandidateMissingBinding = 'tool_call' | 'task' | 'plan' | 'workspace';

export interface GovernanceEvidenceTraceSnapshot {
  readonly sessionId: string;
  readonly task:
    | { readonly scope: 'session' }
    | { readonly scope: 'kanban_task'; readonly taskId: string; readonly boardId: string | null };
  readonly plan:
    | { readonly state: 'missing' | 'invalid' | 'unreadable' | 'refreshing' }
    | { readonly state: 'available'; readonly fingerprint: string };
  readonly workspace:
    | { readonly state: 'not_captured' | 'unavailable' }
    | {
        readonly state: 'captured';
        readonly manifestHash: string;
        readonly baseHead: string;
      };
}

export interface GovernanceToolOutcomeMetadata {
  readonly toolCallId?: string | undefined;
  readonly toolName: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly outputBytes?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly outputLines?: number | undefined;
}

export interface GovernanceEvidenceCandidate {
  readonly schemaVersion: typeof GOVERNANCE_EVIDENCE_CANDIDATE_SCHEMA_VERSION;
  readonly candidateType: 'tool_execution';
  readonly status: 'unverified';
  readonly candidateId: string | null;
  readonly binding:
    | { readonly state: 'bound' }
    | {
        readonly state: 'incomplete';
        readonly missing: readonly GovernanceEvidenceCandidateMissingBinding[];
      };
  readonly tool: { readonly callId: string | null; readonly name: string };
  readonly outcome: {
    readonly status: 'succeeded' | 'failed';
    readonly durationMs: number;
    readonly outputBytes?: number | undefined;
    readonly outputTokens?: number | undefined;
    readonly outputLines?: number | undefined;
  };
}

type GovernanceEvidenceCandidateIneligibilityReason =
  | 'payload_invalid'
  | 'unsupported_schema'
  | 'binding_incomplete'
  | 'candidate_identity_missing'
  | 'candidate_identity_mismatch'
  | 'task_binding_mismatch'
  | 'trace_binding_incomplete';

export interface GovernanceEvidenceCandidateLedgerEntry {
  readonly sequence: number;
  readonly observationId: string;
  readonly source: string;
  readonly taskId: string | null;
  readonly observedAt: string;
  readonly recordedAt: string;
  readonly candidateId: string | null;
  readonly toolCallId: string | null;
  readonly toolName: string | null;
  readonly outcomeStatus: 'succeeded' | 'failed' | null;
  readonly planFingerprint: string | null;
  readonly workspaceManifestHash: string | null;
  readonly workspaceBaseHead: string | null;
  readonly evaluation:
    | {
        readonly state: 'eligible_for_evaluation';
        readonly reasons: readonly GovernanceEvidenceCandidateIneligibilityReason[];
      }
    | {
        readonly state: 'ineligible';
        readonly reasons: readonly GovernanceEvidenceCandidateIneligibilityReason[];
      };
}

export interface GovernanceEvidenceCandidateObservation {
  readonly sequence: number;
  readonly observationId: string;
  readonly source: string;
  readonly taskId: string | null;
  readonly category: string;
  readonly observedAt: string;
  readonly recordedAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function optionalNonNegativeInteger(value: unknown): value is number | undefined {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function identityInput(
  trace: GovernanceEvidenceTraceSnapshot,
  outcome: GovernanceToolOutcomeMetadata & { readonly toolCallId: string },
): Record<string, unknown> {
  if (
    trace.task.scope !== 'kanban_task' ||
    trace.plan.state !== 'available' ||
    trace.workspace.state !== 'captured'
  ) {
    throw new Error('A governance evidence candidate identity requires complete trace bindings.');
  }
  return {
    schemaVersion: GOVERNANCE_EVIDENCE_CANDIDATE_SCHEMA_VERSION,
    candidateType: 'tool_execution',
    sessionId: trace.sessionId,
    taskId: trace.task.taskId,
    boardId: trace.task.boardId,
    planFingerprint: trace.plan.fingerprint,
    workspaceManifestHash: trace.workspace.manifestHash,
    workspaceBaseHead: trace.workspace.baseHead,
    toolCallId: outcome.toolCallId,
    toolName: outcome.toolName,
    status: outcome.ok ? 'succeeded' : 'failed',
    durationMs: outcome.durationMs,
    ...optional('outputBytes', outcome.outputBytes),
    ...optional('outputTokens', outcome.outputTokens),
    ...optional('outputLines', outcome.outputLines),
  };
}

function candidateIdentity(
  trace: GovernanceEvidenceTraceSnapshot,
  outcome: GovernanceToolOutcomeMetadata & { readonly toolCallId: string },
): string {
  return createHash('sha256')
    .update(JSON.stringify(identityInput(trace, outcome)), 'utf8')
    .digest('hex');
}

export function createGovernanceEvidenceCandidate(
  trace: GovernanceEvidenceTraceSnapshot,
  outcome: GovernanceToolOutcomeMetadata,
): GovernanceEvidenceCandidate {
  const toolCallId = outcome.toolCallId?.trim() || undefined;
  const missing: GovernanceEvidenceCandidateMissingBinding[] = [];
  if (!toolCallId) missing.push('tool_call');
  if (trace.task.scope !== 'kanban_task') missing.push('task');
  if (trace.plan.state !== 'available') missing.push('plan');
  if (trace.workspace.state !== 'captured') missing.push('workspace');
  const binding =
    missing.length === 0
      ? Object.freeze({ state: 'bound' as const })
      : Object.freeze({ state: 'incomplete' as const, missing: Object.freeze(missing) });
  return Object.freeze({
    schemaVersion: GOVERNANCE_EVIDENCE_CANDIDATE_SCHEMA_VERSION,
    candidateType: 'tool_execution',
    status: 'unverified',
    candidateId:
      missing.length === 0 && toolCallId
        ? candidateIdentity(trace, { ...outcome, toolCallId })
        : null,
    binding,
    tool: Object.freeze({ callId: toolCallId ?? null, name: outcome.toolName }),
    outcome: Object.freeze({
      status: outcome.ok ? 'succeeded' : 'failed',
      durationMs: outcome.durationMs,
      ...optional('outputBytes', outcome.outputBytes),
      ...optional('outputTokens', outcome.outputTokens),
      ...optional('outputLines', outcome.outputLines),
    }),
  });
}

function baseEntry(observation: GovernanceEvidenceCandidateObservation) {
  return {
    sequence: observation.sequence,
    observationId: observation.observationId,
    source: observation.source,
    taskId: observation.taskId,
    observedAt: observation.observedAt,
    recordedAt: observation.recordedAt,
  };
}

function ineligible(
  observation: GovernanceEvidenceCandidateObservation,
  reasons: readonly GovernanceEvidenceCandidateIneligibilityReason[],
  fields: {
    candidateId?: string | null;
    toolCallId?: string | null;
    toolName?: string | null;
    outcomeStatus?: 'succeeded' | 'failed' | null;
    planFingerprint?: string | null;
    workspaceManifestHash?: string | null;
    workspaceBaseHead?: string | null;
  } = {},
): GovernanceEvidenceCandidateLedgerEntry {
  return Object.freeze({
    ...baseEntry(observation),
    candidateId: fields.candidateId ?? null,
    toolCallId: fields.toolCallId ?? null,
    toolName: fields.toolName ?? null,
    outcomeStatus: fields.outcomeStatus ?? null,
    planFingerprint: fields.planFingerprint ?? null,
    workspaceManifestHash: fields.workspaceManifestHash ?? null,
    workspaceBaseHead: fields.workspaceBaseHead ?? null,
    evaluation: Object.freeze({ state: 'ineligible', reasons: Object.freeze([...reasons]) }),
  });
}

export function evaluateGovernanceEvidenceCandidateObservation(
  observation: GovernanceEvidenceCandidateObservation,
): GovernanceEvidenceCandidateLedgerEntry {
  if (observation.category !== 'evidence_candidate') {
    return ineligible(observation, ['payload_invalid']);
  }
  const payload = plainRecord(observation.payload);
  if (!payload) return ineligible(observation, ['payload_invalid']);
  if (payload['schemaVersion'] !== GOVERNANCE_EVIDENCE_CANDIDATE_SCHEMA_VERSION) {
    return ineligible(observation, ['unsupported_schema']);
  }
  const binding = plainRecord(payload['binding']);
  const tool = plainRecord(payload['tool']);
  const outcome = plainRecord(payload['outcome']);
  const trace = plainRecord(payload['trace']);
  const outcomeStatus = outcome?.['status'];
  if (
    payload['candidateType'] !== 'tool_execution' ||
    payload['status'] !== 'unverified' ||
    !binding ||
    !tool ||
    !outcome ||
    typeof tool['name'] !== 'string' ||
    tool['name'].trim().length === 0 ||
    tool['name'].length > 512 ||
    (tool['callId'] !== null &&
      (typeof tool['callId'] !== 'string' ||
        tool['callId'].trim().length === 0 ||
        tool['callId'].length > 512)) ||
    (outcomeStatus !== 'succeeded' && outcomeStatus !== 'failed') ||
    !nonNegativeNumber(outcome['durationMs']) ||
    !optionalNonNegativeInteger(outcome['outputBytes']) ||
    !optionalNonNegativeInteger(outcome['outputTokens']) ||
    !optionalNonNegativeInteger(outcome['outputLines'])
  ) {
    return ineligible(observation, ['payload_invalid']);
  }
  const fields = {
    candidateId: typeof payload['candidateId'] === 'string' ? payload['candidateId'] : null,
    toolCallId: typeof tool['callId'] === 'string' ? tool['callId'] : null,
    toolName: tool['name'],
    outcomeStatus,
  } as const;
  if (binding['state'] === 'incomplete') {
    return ineligible(observation, ['binding_incomplete'], fields);
  }
  if (binding['state'] !== 'bound') return ineligible(observation, ['payload_invalid'], fields);
  if (!fields.candidateId || !/^[a-f0-9]{64}$/u.test(fields.candidateId) || !fields.toolCallId) {
    return ineligible(observation, ['candidate_identity_missing'], fields);
  }
  const task = plainRecord(trace?.['task']);
  const plan = plainRecord(trace?.['plan']);
  const workspace = plainRecord(trace?.['workspace']);
  if (
    !trace ||
    typeof trace['sessionId'] !== 'string' ||
    trace['sessionId'].trim().length === 0 ||
    trace['sessionId'].length > 512 ||
    task?.['scope'] !== 'kanban_task' ||
    typeof task['taskId'] !== 'string' ||
    (task['boardId'] !== null && typeof task['boardId'] !== 'string') ||
    plan?.['state'] !== 'available' ||
    typeof plan['fingerprint'] !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(plan['fingerprint']) ||
    workspace?.['state'] !== 'captured' ||
    typeof workspace['manifestHash'] !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(workspace['manifestHash']) ||
    typeof workspace['baseHead'] !== 'string' ||
    !/^[a-f0-9]{40,64}$/u.test(workspace['baseHead'])
  ) {
    return ineligible(observation, ['trace_binding_incomplete'], fields);
  }
  if (observation.taskId !== task['taskId']) {
    return ineligible(observation, ['task_binding_mismatch'], fields);
  }
  const expected = candidateIdentity(trace as unknown as GovernanceEvidenceTraceSnapshot, {
    toolCallId: fields.toolCallId,
    toolName: fields.toolName,
    ok: outcomeStatus === 'succeeded',
    durationMs: outcome['durationMs'] as number,
    ...(outcome['outputBytes'] === undefined
      ? {}
      : { outputBytes: outcome['outputBytes'] as number }),
    ...(outcome['outputTokens'] === undefined
      ? {}
      : { outputTokens: outcome['outputTokens'] as number }),
    ...(outcome['outputLines'] === undefined
      ? {}
      : { outputLines: outcome['outputLines'] as number }),
  });
  if (expected !== fields.candidateId) {
    return ineligible(observation, ['candidate_identity_mismatch'], fields);
  }
  return Object.freeze({
    ...baseEntry(observation),
    ...fields,
    planFingerprint: plan['fingerprint'],
    workspaceManifestHash: workspace['manifestHash'],
    workspaceBaseHead: workspace['baseHead'],
    evaluation: Object.freeze({ state: 'eligible_for_evaluation', reasons: Object.freeze([]) }),
  });
}
