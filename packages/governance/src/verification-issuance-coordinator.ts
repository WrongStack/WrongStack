import type { GovernanceEventStore } from './event-store.js';
import type { GovernanceEvidenceCandidateLedgerEntry } from './evidence-candidate.js';
import { calculatePlanVersionFingerprint } from './plan-version.js';
import type { TaskAggregate } from './task-aggregate.js';
import type { EvidenceKind } from './task-contract.js';
import type { VerificationCheckBindingResolution } from './verification-check-registry.js';
import type { IssueVerificationExecutionLeaseResult } from './verification-execution-lease.js';
import type { VerificationPlanDraftV1 } from './verification-planner.js';
import {
  issueBoundVerificationRunContract,
  issueVerificationRunContract,
  type VerificationRunIssuanceIssue,
  type VerificationRunRequestV1,
} from './verification-run-contract.js';

type VerificationIssuanceCoordinatorMode = 'legacy' | 'enforced';

interface VerificationCheckBindingResolver {
  bindingFor(checkId: string, evidenceKind: EvidenceKind): VerificationCheckBindingResolution;
}

interface VerificationExecutionLeaseIssuer {
  issueVerificationExecutionLeaseIfCurrent: GovernanceEventStore['issueVerificationExecutionLeaseIfCurrent'];
  recordWorkspaceSnapshot?: GovernanceEventStore['recordWorkspaceSnapshot'];
}

interface VerificationWorkspaceSnapshotRecorder {
  recordWorkspaceSnapshot: GovernanceEventStore['recordWorkspaceSnapshot'];
}

interface VerificationIssuanceCoordinatorOptions {
  /** Defaults to legacy; construction alone cannot enable governed issuance. */
  readonly mode?: VerificationIssuanceCoordinatorMode | undefined;
  readonly verifierClientId: string;
  readonly ttlMs: number;
  readonly maxDurationMs: number;
  readonly now: () => string;
  readonly captureWorkspaceIdentity: () => Promise<{ readonly manifestHash: string }>;
  readonly workspaceSnapshots?: VerificationWorkspaceSnapshotRecorder | undefined;
  readonly checkBindings: VerificationCheckBindingResolver;
  readonly leaseIssuer: VerificationExecutionLeaseIssuer;
}

export interface VerificationIssuanceCoordinatorInput {
  readonly task: TaskAggregate | null;
  readonly draft: VerificationPlanDraftV1;
  readonly candidates: readonly GovernanceEvidenceCandidateLedgerEntry[];
  /** The complete model-proposable surface. Registry bindings are not accepted here. */
  readonly request: VerificationRunRequestV1;
}

type VerificationLeaseFailure = Extract<IssueVerificationExecutionLeaseResult, { issued: false }>;
type VerificationLeaseSuccess = Extract<IssueVerificationExecutionLeaseResult, { issued: true }>;

type VerificationIssuanceCoordinatorResult =
  | {
      readonly route: 'legacy';
      readonly handled: false;
      readonly reason: 'coordinator_disabled';
    }
  | {
      readonly route: 'governed';
      readonly handled: true;
      readonly issued: false;
      readonly phase: 'authority';
      readonly code: 'authority_unavailable';
      readonly message: string;
    }
  | {
      readonly route: 'governed';
      readonly handled: true;
      readonly issued: false;
      readonly phase: 'workspace';
      readonly code:
        | 'workspace_identity_unavailable'
        | 'workspace_mismatch'
        | 'workspace_snapshot_unavailable'
        | 'workspace_snapshot_invalid';
      readonly message: string;
    }
  | {
      readonly route: 'governed';
      readonly handled: true;
      readonly issued: false;
      readonly phase: 'run_contract';
      readonly issues: readonly VerificationRunIssuanceIssue[];
    }
  | {
      readonly route: 'governed';
      readonly handled: true;
      readonly issued: false;
      readonly phase: 'check_registry';
      readonly code:
        | Extract<VerificationCheckBindingResolution, { bound: false }>['code']
        | 'check_registry_unavailable';
      readonly message: string;
    }
  | {
      readonly route: 'governed';
      readonly handled: true;
      readonly issued: false;
      readonly phase: 'internal';
      readonly code: 'bound_run_invariant_failed' | 'lease_result_mismatch';
      readonly message: string;
    }
  | {
      readonly route: 'governed';
      readonly handled: true;
      readonly issued: false;
      readonly phase: 'lease';
      readonly code: VerificationLeaseFailure['code'] | 'lease_unavailable';
      readonly message: string;
    }
  | {
      readonly route: 'governed';
      readonly handled: true;
      readonly issued: true;
      readonly run: Extract<VerificationLeaseSuccess['run'], { schemaVersion: 2 }>;
      readonly lease: VerificationLeaseSuccess['lease'];
      readonly credential: VerificationLeaseSuccess['credential'];
    };

export class VerificationIssuanceCoordinator {
  readonly #mode: VerificationIssuanceCoordinatorMode;
  readonly #verifierClientId: string;
  readonly #ttlMs: number;
  readonly #maxDurationMs: number;
  readonly #now: () => string;
  readonly #captureWorkspaceIdentity: () => Promise<{ readonly manifestHash: string }>;
  readonly #workspaceSnapshots: VerificationWorkspaceSnapshotRecorder | undefined;
  readonly #checkBindings: VerificationCheckBindingResolver;
  readonly #leaseIssuer: VerificationExecutionLeaseIssuer;

  constructor(options: VerificationIssuanceCoordinatorOptions) {
    this.#mode = options.mode === 'enforced' ? 'enforced' : 'legacy';
    this.#verifierClientId = options.verifierClientId;
    this.#ttlMs = options.ttlMs;
    this.#maxDurationMs = options.maxDurationMs;
    this.#now = options.now;
    this.#captureWorkspaceIdentity = options.captureWorkspaceIdentity;
    this.#workspaceSnapshots =
      options.workspaceSnapshots ??
      (options.leaseIssuer.recordWorkspaceSnapshot
        ? {
            recordWorkspaceSnapshot: options.leaseIssuer.recordWorkspaceSnapshot.bind(
              options.leaseIssuer,
            ),
          }
        : undefined);
    this.#checkBindings = options.checkBindings;
    this.#leaseIssuer = options.leaseIssuer;
  }

  async issue(
    input: VerificationIssuanceCoordinatorInput,
  ): Promise<VerificationIssuanceCoordinatorResult> {
    if (this.#mode === 'legacy') {
      return Object.freeze({ route: 'legacy', handled: false, reason: 'coordinator_disabled' });
    }

    let issuedAt: string;
    try {
      issuedAt = this.#now();
    } catch {
      return Object.freeze({
        route: 'governed',
        handled: true,
        issued: false,
        phase: 'authority',
        code: 'authority_unavailable',
        message: 'Trusted verification authority time is unavailable.',
      });
    }
    const authority = Object.freeze({
      verifierClientId: this.#verifierClientId,
      issuedAt,
      ttlMs: this.#ttlMs,
      maxDurationMs: this.#maxDurationMs,
    });

    // Pure preflight derives the canonical check kind without persisting its v1 result.
    const preflight = issueVerificationRunContract(
      input.task,
      input.draft,
      input.candidates,
      input.request,
      authority,
    );
    if (!preflight.issued) {
      return Object.freeze({
        route: 'governed',
        handled: true,
        issued: false,
        phase: 'run_contract',
        issues: preflight.issues,
      });
    }
    let binding: VerificationCheckBindingResolution;
    try {
      binding = this.#checkBindings.bindingFor(
        preflight.contract.requiredCheckId,
        preflight.contract.expectedEvidenceKind,
      );
    } catch {
      return Object.freeze({
        route: 'governed',
        handled: true,
        issued: false,
        phase: 'check_registry',
        code: 'check_registry_unavailable',
        message: 'Trusted verification check registry is unavailable.',
      });
    }
    if (!binding.bound) {
      return Object.freeze({
        route: 'governed',
        handled: true,
        issued: false,
        phase: 'check_registry',
        code: binding.code,
        message: binding.message,
      });
    }

    const boundRun = issueBoundVerificationRunContract(
      input.task,
      input.draft,
      input.candidates,
      input.request,
      Object.freeze({ ...authority, checkBinding: binding.binding }),
    );
    if (!boundRun.issued) {
      return Object.freeze({
        route: 'governed',
        handled: true,
        issued: false,
        phase: 'run_contract',
        issues: boundRun.issues,
      });
    }
    if (boundRun.contract.schemaVersion !== 2) {
      return Object.freeze({
        route: 'governed',
        handled: true,
        issued: false,
        phase: 'internal',
        code: 'bound_run_invariant_failed',
        message: 'Bound verification issuance did not produce a v2 run contract.',
      });
    }

    let workspaceManifestHash: string;
    try {
      const workspace = await this.#captureWorkspaceIdentity();
      workspaceManifestHash = workspace.manifestHash;
    } catch {
      return Object.freeze({
        route: 'governed',
        handled: true,
        issued: false,
        phase: 'workspace',
        code: 'workspace_identity_unavailable',
        message: 'Fresh workspace identity could not be captured for verification issuance.',
      });
    }
    if (
      !/^[a-f0-9]{64}$/.test(workspaceManifestHash) ||
      workspaceManifestHash !== boundRun.contract.workspaceManifestHash
    ) {
      return Object.freeze({
        route: 'governed',
        handled: true,
        issued: false,
        phase: 'workspace',
        code: 'workspace_mismatch',
        message: 'Fresh workspace identity does not match the verification run snapshot.',
      });
    }
    if (
      !input.task ||
      input.task.activePlanVersion === null ||
      (input.task.state !== 'proposed_complete' && input.task.state !== 'verifying')
    ) {
      return Object.freeze({
        route: 'governed',
        handled: true,
        issued: false,
        phase: 'internal',
        code: 'bound_run_invariant_failed',
        message: 'Bound verification issuance lost its canonical task precondition.',
      });
    }
    const selectedCandidate = input.candidates.find(
      (candidate) => candidate.candidateId === boundRun.contract.candidateId,
    );
    if (
      !selectedCandidate ||
      !Number.isSafeInteger(selectedCandidate.sequence) ||
      selectedCandidate.sequence < 1 ||
      selectedCandidate.observationId.trim().length === 0 ||
      selectedCandidate.observationId.length > 512
    ) {
      return Object.freeze({
        route: 'governed',
        handled: true,
        issued: false,
        phase: 'internal',
        code: 'bound_run_invariant_failed',
        message: 'Bound verification issuance lost its canonical candidate reference.',
      });
    }
    const activePlanVersion = input.task.activePlanVersion;
    const activePlan = input.task.plans.find((plan) => plan.planVersion === activePlanVersion);
    if (!activePlan) {
      return Object.freeze({
        route: 'governed',
        handled: true,
        issued: false,
        phase: 'internal',
        code: 'bound_run_invariant_failed',
        message: 'Bound verification issuance lost its canonical active plan.',
      });
    }
    if (!this.#workspaceSnapshots) {
      return Object.freeze({
        route: 'governed',
        handled: true,
        issued: false,
        phase: 'workspace',
        code: 'workspace_snapshot_unavailable',
        message: 'Canonical workspace snapshot recorder is unavailable.',
      });
    }
    let workspaceSnapshot: ReturnType<
      VerificationWorkspaceSnapshotRecorder['recordWorkspaceSnapshot']
    >;
    try {
      workspaceSnapshot = this.#workspaceSnapshots.recordWorkspaceSnapshot(
        input.task.projectId,
        workspaceManifestHash,
      );
    } catch {
      return Object.freeze({
        route: 'governed',
        handled: true,
        issued: false,
        phase: 'workspace',
        code: 'workspace_snapshot_unavailable',
        message: 'Canonical workspace snapshot could not be recorded.',
      });
    }
    if (!workspaceSnapshot.recorded) {
      return Object.freeze({
        route: 'governed',
        handled: true,
        issued: false,
        phase: 'workspace',
        code: 'workspace_snapshot_invalid',
        message: workspaceSnapshot.message,
      });
    }

    let lease: IssueVerificationExecutionLeaseResult;
    try {
      lease = this.#leaseIssuer.issueVerificationExecutionLeaseIfCurrent(boundRun.contract, {
        taskRevision: input.task.revision,
        activeContractVersion: input.task.activeContractVersion,
        activePlanVersion: input.task.activePlanVersion,
        activePlanFingerprint: calculatePlanVersionFingerprint(activePlan),
        workflowState: input.task.state,
        workspaceManifestHash,
        workspaceSnapshot: workspaceSnapshot.snapshot,
        candidateObservation: {
          sequence: selectedCandidate.sequence,
          observationId: selectedCandidate.observationId,
        },
      });
    } catch {
      return Object.freeze({
        route: 'governed',
        handled: true,
        issued: false,
        phase: 'lease',
        code: 'lease_unavailable',
        message: 'Verification lease persistence is unavailable.',
      });
    }
    if (!lease.issued) {
      return Object.freeze({
        route: 'governed',
        handled: true,
        issued: false,
        phase: 'lease',
        code: lease.code,
        message: lease.message,
      });
    }
    if (lease.run.schemaVersion !== 2 || lease.run.runId !== boundRun.contract.runId) {
      return Object.freeze({
        route: 'governed',
        handled: true,
        issued: false,
        phase: 'internal',
        code: 'lease_result_mismatch',
        message: 'Verification lease issuer returned a mismatched run contract.',
      });
    }
    return Object.freeze({
      route: 'governed',
      handled: true,
      issued: true,
      run: boundRun.contract,
      lease: lease.lease,
      credential: lease.credential,
    });
  }
}
