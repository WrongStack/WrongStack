import { createHash } from 'node:crypto';
import { AUTONOMY_TIERS, type AutonomyTier, decideOperationAutonomy } from './autonomy-envelope.js';
import type { GovernanceEvidenceCandidateLedgerEntry } from './evidence-candidate.js';
import type { TaskAggregate } from './task-aggregate.js';
import { EVIDENCE_KINDS, type EvidenceKind } from './task-contract.js';
import {
  isVerificationCheckBindingIntegrityValid,
  type VerificationCheckBindingV1,
} from './verification-check-binding.js';
import {
  calculateVerificationPlanDraftId,
  type VerificationPlanDraftV1,
} from './verification-planner.js';

export const VERIFICATION_RUN_REQUEST_SCHEMA_VERSION = 1 as const;
const VERIFICATION_RUN_CONTRACT_V1_SCHEMA_VERSION = 1 as const;
const VERIFICATION_RUN_CONTRACT_SCHEMA_VERSION = 2 as const;
export const MAX_VERIFICATION_RUN_TTL_MS = 15 * 60 * 1_000;
const MAX_VERIFICATION_RUN_DURATION_MS = 10 * 60 * 1_000;

export interface VerificationRunRequestV1 {
  readonly schemaVersion: typeof VERIFICATION_RUN_REQUEST_SCHEMA_VERSION;
  readonly draftId: string;
  readonly requiredCheckId: string;
  readonly candidateId: string;
}

/** Supplied by the deterministic daemon/transport, never by the model request payload. */
interface VerificationRunAuthorityContext {
  readonly verifierClientId: string;
  readonly issuedAt: string;
  readonly ttlMs: number;
  readonly maxDurationMs: number;
}

interface BoundVerificationRunAuthorityContext extends VerificationRunAuthorityContext {
  /** Derived from the trusted immutable registry, never from the model request. */
  readonly checkBinding: VerificationCheckBindingV1;
}

export interface VerificationRunContractV1 {
  readonly schemaVersion: typeof VERIFICATION_RUN_CONTRACT_V1_SCHEMA_VERSION;
  readonly runId: string;
  readonly status: 'authorized';
  readonly draftId: string;
  readonly taskId: string;
  readonly contractVersion: number;
  readonly planFingerprint: string;
  readonly workspaceManifestHash: string;
  readonly requiredCheckId: string;
  readonly expectedEvidenceKind: EvidenceKind;
  readonly candidateId: string;
  readonly candidateSource: string;
  readonly verifierClientId: string;
  readonly authorization: {
    readonly operation: 'focused_check';
    readonly mode: 'automatic';
    readonly autonomyTier: AutonomyTier;
  };
  readonly limits: {
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly ttlMs: number;
    readonly maxDurationMs: number;
  };
  readonly resultPolicy: {
    readonly executorMayApprove: false;
    readonly independentToolEvidenceRequired: true;
    readonly freshWorkspaceIdentityRequired: true;
  };
}

export interface VerificationRunContractV2
  extends Omit<VerificationRunContractV1, 'schemaVersion' | 'runId'> {
  readonly schemaVersion: typeof VERIFICATION_RUN_CONTRACT_SCHEMA_VERSION;
  readonly runId: string;
  readonly checkBinding: VerificationCheckBindingV1;
}

export type VerificationRunContract = VerificationRunContractV1 | VerificationRunContractV2;

type VerificationRunContractWithoutId =
  | Omit<VerificationRunContractV1, 'runId'>
  | Omit<VerificationRunContractV2, 'runId'>;

type VerificationRunIssuanceIssueCode =
  | 'task_missing'
  | 'active_contract_missing'
  | 'workflow_state_invalid'
  | 'draft_invalid'
  | 'draft_scope_mismatch'
  | 'request_invalid'
  | 'required_check_missing'
  | 'required_check_drifted'
  | 'candidate_not_proposed'
  | 'candidate_missing'
  | 'candidate_ambiguous'
  | 'candidate_ineligible'
  | 'candidate_scope_mismatch'
  | 'verifier_identity_invalid'
  | 'verifier_not_independent'
  | 'operation_not_authorized'
  | 'check_binding_invalid'
  | 'check_binding_mismatch'
  | 'authority_time_invalid'
  | 'authority_limits_invalid';

export interface VerificationRunIssuanceIssue {
  readonly code: VerificationRunIssuanceIssueCode;
  readonly path: string;
  readonly message: string;
}

type VerificationRunIssuanceResult =
  | { readonly issued: true; readonly contract: VerificationRunContract }
  | { readonly issued: false; readonly issues: readonly VerificationRunIssuanceIssue[] };

export function calculateVerificationRunId(contract: VerificationRunContractWithoutId): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: contract.schemaVersion,
        status: contract.status,
        draftId: contract.draftId,
        taskId: contract.taskId,
        contractVersion: contract.contractVersion,
        planFingerprint: contract.planFingerprint,
        workspaceManifestHash: contract.workspaceManifestHash,
        requiredCheckId: contract.requiredCheckId,
        expectedEvidenceKind: contract.expectedEvidenceKind,
        candidateId: contract.candidateId,
        candidateSource: contract.candidateSource,
        verifierClientId: contract.verifierClientId,
        authorization: {
          operation: contract.authorization.operation,
          mode: contract.authorization.mode,
          autonomyTier: contract.authorization.autonomyTier,
        },
        limits: {
          issuedAt: contract.limits.issuedAt,
          expiresAt: contract.limits.expiresAt,
          ttlMs: contract.limits.ttlMs,
          maxDurationMs: contract.limits.maxDurationMs,
        },
        resultPolicy: {
          executorMayApprove: contract.resultPolicy.executorMayApprove,
          independentToolEvidenceRequired: contract.resultPolicy.independentToolEvidenceRequired,
          freshWorkspaceIdentityRequired: contract.resultPolicy.freshWorkspaceIdentityRequired,
        },
        ...(contract.schemaVersion === VERIFICATION_RUN_CONTRACT_SCHEMA_VERSION
          ? {
              checkBinding: {
                schemaVersion: contract.checkBinding.schemaVersion,
                registryFingerprint: contract.checkBinding.registryFingerprint,
                checkId: contract.checkBinding.checkId,
                evidenceKind: contract.checkBinding.evidenceKind,
                handlerVersion: contract.checkBinding.handlerVersion,
                executionClass: contract.checkBinding.executionClass,
                handlerFingerprint: contract.checkBinding.handlerFingerprint,
              },
            }
          : {}),
      }),
      'utf8',
    )
    .digest('hex');
}

export function isVerificationRunContractIntegrityValid(
  contract: VerificationRunContract,
): boolean {
  try {
    const issuedAtMs = Date.parse(contract.limits.issuedAt);
    const expiresAtMs = Date.parse(contract.limits.expiresAt);
    return (
      (contract.schemaVersion === VERIFICATION_RUN_CONTRACT_V1_SCHEMA_VERSION ||
        contract.schemaVersion === VERIFICATION_RUN_CONTRACT_SCHEMA_VERSION) &&
      contract.status === 'authorized' &&
      /^[a-f0-9]{64}$/u.test(contract.runId) &&
      calculateVerificationRunId(contract) === contract.runId &&
      /^[a-f0-9]{64}$/u.test(contract.draftId) &&
      /^[a-f0-9]{64}$/u.test(contract.planFingerprint) &&
      /^[a-f0-9]{64}$/u.test(contract.workspaceManifestHash) &&
      /^[a-f0-9]{64}$/u.test(contract.candidateId) &&
      contract.taskId.trim().length > 0 &&
      contract.taskId.length <= 512 &&
      Number.isSafeInteger(contract.contractVersion) &&
      contract.contractVersion >= 1 &&
      contract.requiredCheckId.trim().length > 0 &&
      contract.requiredCheckId.length <= 512 &&
      EVIDENCE_KINDS.includes(contract.expectedEvidenceKind) &&
      contract.candidateSource.trim().length > 0 &&
      contract.candidateSource.length <= 512 &&
      contract.verifierClientId.trim().length > 0 &&
      contract.verifierClientId.length <= 512 &&
      contract.candidateSource !== contract.verifierClientId &&
      contract.authorization.operation === 'focused_check' &&
      contract.authorization.mode === 'automatic' &&
      AUTONOMY_TIERS.includes(contract.authorization.autonomyTier) &&
      Number.isSafeInteger(issuedAtMs) &&
      issuedAtMs >= 0 &&
      Number.isSafeInteger(expiresAtMs) &&
      expiresAtMs === issuedAtMs + contract.limits.ttlMs &&
      Number.isSafeInteger(contract.limits.ttlMs) &&
      contract.limits.ttlMs >= 1 &&
      contract.limits.ttlMs <= MAX_VERIFICATION_RUN_TTL_MS &&
      Number.isSafeInteger(contract.limits.maxDurationMs) &&
      contract.limits.maxDurationMs >= 1 &&
      contract.limits.maxDurationMs <= MAX_VERIFICATION_RUN_DURATION_MS &&
      contract.limits.maxDurationMs <= contract.limits.ttlMs &&
      contract.resultPolicy.executorMayApprove === false &&
      contract.resultPolicy.independentToolEvidenceRequired === true &&
      contract.resultPolicy.freshWorkspaceIdentityRequired === true &&
      (contract.schemaVersion === VERIFICATION_RUN_CONTRACT_V1_SCHEMA_VERSION ||
        (isVerificationCheckBindingIntegrityValid(contract.checkBinding) &&
          contract.checkBinding.checkId === contract.requiredCheckId &&
          contract.checkBinding.evidenceKind === contract.expectedEvidenceKind))
    );
  } catch {
    return false;
  }
}

function issue(
  code: VerificationRunIssuanceIssueCode,
  path: string,
  message: string,
): VerificationRunIssuanceResult {
  return Object.freeze({
    issued: false,
    issues: Object.freeze([Object.freeze({ code, path, message })]),
  });
}

function validHash(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function issueVerificationRunContract(
  task: TaskAggregate | null,
  draft: VerificationPlanDraftV1,
  candidates: readonly GovernanceEvidenceCandidateLedgerEntry[],
  request: VerificationRunRequestV1,
  authority: VerificationRunAuthorityContext,
): VerificationRunIssuanceResult {
  return issueVerificationRunContractInternal(task, draft, candidates, request, authority);
}

export function issueBoundVerificationRunContract(
  task: TaskAggregate | null,
  draft: VerificationPlanDraftV1,
  candidates: readonly GovernanceEvidenceCandidateLedgerEntry[],
  request: VerificationRunRequestV1,
  authority: BoundVerificationRunAuthorityContext,
): VerificationRunIssuanceResult {
  return issueVerificationRunContractInternal(
    task,
    draft,
    candidates,
    request,
    authority,
    authority.checkBinding,
  );
}

function issueVerificationRunContractInternal(
  task: TaskAggregate | null,
  draft: VerificationPlanDraftV1,
  candidates: readonly GovernanceEvidenceCandidateLedgerEntry[],
  request: VerificationRunRequestV1,
  authority: VerificationRunAuthorityContext,
  checkBinding?: VerificationCheckBindingV1,
): VerificationRunIssuanceResult {
  if (!task) return issue('task_missing', 'task', 'Canonical task state is required.');
  if (task.state !== 'proposed_complete' && task.state !== 'verifying') {
    return issue(
      'workflow_state_invalid',
      'task.state',
      'Verification runs require proposed_complete or verifying workflow state.',
    );
  }
  const activeContract = task.contracts.find(
    (candidate) => candidate.contractVersion === task.activeContractVersion,
  );
  if (!activeContract) {
    return issue(
      'active_contract_missing',
      'task.activeContractVersion',
      'Canonical task state does not contain its active Task Contract.',
    );
  }
  if (
    draft.schemaVersion !== 1 ||
    draft.status !== 'draft' ||
    !validHash(draft.draftId) ||
    calculateVerificationPlanDraftId(draft) !== draft.draftId
  ) {
    return issue('draft_invalid', 'draft', 'Verification plan draft identity is invalid.');
  }
  if (
    draft.scope.taskId !== task.taskId ||
    draft.scope.contractVersion !== activeContract.contractVersion
  ) {
    return issue(
      'draft_scope_mismatch',
      'draft.scope',
      'Verification plan draft does not match canonical task and contract state.',
    );
  }
  if (
    request.schemaVersion !== VERIFICATION_RUN_REQUEST_SCHEMA_VERSION ||
    request.draftId !== draft.draftId ||
    !validHash(request.candidateId) ||
    request.requiredCheckId.trim().length === 0
  ) {
    return issue('request_invalid', 'request', 'Verification run request is invalid.');
  }
  const checkDraft = draft.checks.find(
    (candidate) => candidate.requiredCheckId === request.requiredCheckId,
  );
  const canonicalCheck = activeContract.requiredChecks.find(
    (candidate) => candidate.id === request.requiredCheckId,
  );
  if (!checkDraft || !canonicalCheck) {
    return issue(
      'required_check_missing',
      'request.requiredCheckId',
      'Requested check does not exist in the draft and active Task Contract.',
    );
  }
  if (
    checkDraft.expectedEvidenceKind !== canonicalCheck.kind ||
    checkDraft.required !== canonicalCheck.required ||
    !equalStrings(checkDraft.requirementIds, canonicalCheck.requirementIds) ||
    checkDraft.evidenceSatisfied !== false
  ) {
    return issue(
      'required_check_drifted',
      'draft.checks',
      'Draft check no longer matches the active Task Contract.',
    );
  }
  if (checkBinding && !isVerificationCheckBindingIntegrityValid(checkBinding)) {
    return issue(
      'check_binding_invalid',
      'authority.checkBinding',
      'Trusted verification check binding failed integrity validation.',
    );
  }
  if (
    checkBinding &&
    (checkBinding.checkId !== checkDraft.requiredCheckId ||
      checkBinding.evidenceKind !== checkDraft.expectedEvidenceKind)
  ) {
    return issue(
      'check_binding_mismatch',
      'authority.checkBinding',
      'Trusted verification check binding does not match the canonical required check.',
    );
  }
  if (!checkDraft.proposedCandidateIds.includes(request.candidateId)) {
    return issue(
      'candidate_not_proposed',
      'request.candidateId',
      'Candidate was not proposed for the requested check.',
    );
  }
  const matchingCandidates = candidates.filter(
    (candidate) => candidate.candidateId === request.candidateId,
  );
  if (matchingCandidates.length === 0) {
    return issue(
      'candidate_missing',
      'request.candidateId',
      'Candidate is absent from the ledger view.',
    );
  }
  if (matchingCandidates.length > 1) {
    return issue(
      'candidate_ambiguous',
      'request.candidateId',
      'Candidate identity resolves to multiple ledger entries.',
    );
  }
  const candidate = matchingCandidates[0]!;
  if (candidate.evaluation.state !== 'eligible_for_evaluation') {
    return issue('candidate_ineligible', 'request.candidateId', 'Candidate is not eligible.');
  }
  if (
    candidate.taskId !== draft.scope.taskId ||
    candidate.planFingerprint !== draft.scope.planFingerprint ||
    candidate.workspaceManifestHash !== draft.scope.workspaceManifestHash
  ) {
    return issue(
      'candidate_scope_mismatch',
      'request.candidateId',
      'Candidate is not bound to the draft task, plan, and workspace identities.',
    );
  }
  if (authority.verifierClientId.trim().length === 0 || authority.verifierClientId.length > 512) {
    return issue(
      'verifier_identity_invalid',
      'authority.verifierClientId',
      'Verifier identity must be a non-empty bounded client identity.',
    );
  }
  if (authority.verifierClientId === candidate.source) {
    return issue(
      'verifier_not_independent',
      'authority.verifierClientId',
      'Evidence producer cannot independently verify its own candidate.',
    );
  }
  const autonomy = decideOperationAutonomy(activeContract.autonomy, 'focused_check');
  if (!autonomy.allowed) {
    return issue(
      'operation_not_authorized',
      'task.contract.autonomy',
      `Focused verification is not automatically authorized (${autonomy.reason}).`,
    );
  }
  const issuedAtMs = Date.parse(authority.issuedAt);
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0) {
    return issue(
      'authority_time_invalid',
      'authority.issuedAt',
      'Authority issuedAt must be a valid timestamp.',
    );
  }
  if (
    !Number.isSafeInteger(authority.ttlMs) ||
    authority.ttlMs < 1 ||
    authority.ttlMs > MAX_VERIFICATION_RUN_TTL_MS ||
    !Number.isSafeInteger(authority.maxDurationMs) ||
    authority.maxDurationMs < 1 ||
    authority.maxDurationMs > MAX_VERIFICATION_RUN_DURATION_MS ||
    authority.maxDurationMs > authority.ttlMs
  ) {
    return issue(
      'authority_limits_invalid',
      'authority',
      'Verification run TTL and duration exceed deterministic policy limits.',
    );
  }
  const expiresAtMs = issuedAtMs + authority.ttlMs;
  if (!Number.isSafeInteger(expiresAtMs) || !Number.isFinite(new Date(expiresAtMs).getTime())) {
    return issue(
      'authority_time_invalid',
      'authority.issuedAt',
      'Authority time cannot produce a valid contract expiration.',
    );
  }
  const expiresAt = new Date(expiresAtMs).toISOString();
  const commonContract = {
    status: 'authorized' as const,
    draftId: draft.draftId,
    taskId: task.taskId,
    contractVersion: activeContract.contractVersion,
    planFingerprint: draft.scope.planFingerprint,
    workspaceManifestHash: draft.scope.workspaceManifestHash,
    requiredCheckId: checkDraft.requiredCheckId,
    expectedEvidenceKind: checkDraft.expectedEvidenceKind,
    candidateId: request.candidateId,
    candidateSource: candidate.source,
    verifierClientId: authority.verifierClientId,
    authorization: Object.freeze({
      operation: 'focused_check' as const,
      mode: 'automatic' as const,
      autonomyTier: activeContract.autonomy.tier,
    }),
    limits: Object.freeze({
      issuedAt: authority.issuedAt,
      expiresAt,
      ttlMs: authority.ttlMs,
      maxDurationMs: authority.maxDurationMs,
    }),
    resultPolicy: Object.freeze({
      executorMayApprove: false as const,
      independentToolEvidenceRequired: true as const,
      freshWorkspaceIdentityRequired: true as const,
    }),
  };
  const contractWithoutRunId: VerificationRunContractWithoutId = checkBinding
    ? Object.freeze({
        schemaVersion: VERIFICATION_RUN_CONTRACT_SCHEMA_VERSION,
        ...commonContract,
        checkBinding: Object.freeze({ ...checkBinding }),
      })
    : Object.freeze({
        schemaVersion: VERIFICATION_RUN_CONTRACT_V1_SCHEMA_VERSION,
        ...commonContract,
      });
  const runId = calculateVerificationRunId(contractWithoutRunId);
  return Object.freeze({
    issued: true,
    contract: Object.freeze({
      ...contractWithoutRunId,
      runId,
    }),
  });
}
