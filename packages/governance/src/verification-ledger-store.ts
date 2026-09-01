import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  evaluateGovernanceEvidenceCandidateObservation,
  type GovernanceEvidenceCandidateObservation,
} from './evidence-candidate.js';
import { calculatePlanVersionFingerprint } from './plan-version.js';
import { type GovernanceEvent, replayTaskEvents } from './task-aggregate.js';
import {
  type ConsumeVerificationExecutionLeaseResult,
  createVerificationExecutionLeaseSecret,
  type IssueVerificationExecutionLeaseResult,
  VERIFICATION_EXECUTION_LEASE_SCHEMA_VERSION,
  type VerificationExecutionBinding,
  type VerificationExecutionLeaseConsumption,
  type VerificationExecutionLeaseCredential,
  type VerificationExecutionLeaseDescriptor,
  type VerificationExecutionLeaseStatus,
  type VerificationLeaseIssuancePrecondition,
  verificationExecutionBindingHash,
  verificationExecutionLeaseId,
  verificationExecutionLeaseSecretHash,
  verificationExecutionLeaseSecretMatches,
} from './verification-execution-lease.js';
import {
  isVerificationRunContractIntegrityValid,
  type VerificationRunContract,
} from './verification-run-contract.js';
import {
  isWorkspaceSnapshotFenceDescriptorValid,
  type RecordWorkspaceSnapshotResult,
  WORKSPACE_SNAPSHOT_FENCE_SCHEMA_VERSION,
  type WorkspaceSnapshotFenceDescriptor,
  workspaceSnapshotFenceId,
} from './workspace-snapshot-fence.js';

interface VerificationRunRow {
  run_id: string;
  task_id: string;
  draft_id: string;
  verifier_client_id: string;
  contract_json: string;
  contract_hash: string;
  issued_at: string;
  expires_at: string;
  recorded_at: string;
}

interface VerificationLeaseRow {
  lease_id: string;
  run_id: string;
  task_id: string;
  verifier_client_id: string;
  verifier_hash: string;
  issued_at: string;
  expires_at: string;
}

interface VerificationLeaseConsumptionRow {
  lease_id: string;
  run_id: string;
  verifier_client_id: string;
  binding_hash: string;
  consumed_at: string;
}

interface GovernanceEventJsonRow {
  task_id: string;
  revision: number;
  event_json: string;
}

interface GovernanceEvidenceObservationRow {
  sequence: number;
  observation_id: string;
  project_id: string;
  task_id: string | null;
  source: string;
  category: string;
  observation_json: string;
  observation_hash: string;
  observed_at: string;
  recorded_at: string;
}

interface WorkspaceSnapshotRow {
  snapshot_id: string;
  project_id: string;
  revision: number;
  manifest_hash: string;
  captured_at: string;
}

type VerificationLeaseIssuanceFailure = Extract<
  IssueVerificationExecutionLeaseResult,
  { issued: false }
>;

interface SqliteVerificationLedgerOptions {
  readonly now: () => string;
  readonly verificationLeaseSecret?: (() => string) | undefined;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entryValue]) => [key, canonicalize(entryValue)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export class SqliteVerificationLedger {
  readonly #db: DatabaseSync;
  readonly #now: () => string;
  readonly #verificationLeaseSecret: () => string;

  constructor(db: DatabaseSync, options: SqliteVerificationLedgerOptions) {
    this.#db = db;
    this.#now = options.now;
    this.#verificationLeaseSecret =
      options.verificationLeaseSecret ?? createVerificationExecutionLeaseSecret;
  }

  initializeSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS governance_verification_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        draft_id TEXT NOT NULL,
        verifier_client_id TEXT NOT NULL,
        contract_json TEXT NOT NULL,
        contract_hash TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS governance_verification_leases (
        lease_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES governance_verification_runs(run_id),
        task_id TEXT NOT NULL,
        verifier_client_id TEXT NOT NULL,
        verifier_hash TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS governance_verification_lease_consumptions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        lease_id TEXT NOT NULL UNIQUE REFERENCES governance_verification_leases(lease_id),
        run_id TEXT NOT NULL,
        verifier_client_id TEXT NOT NULL,
        binding_hash TEXT NOT NULL,
        consumed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS governance_workspace_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        manifest_hash TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        UNIQUE (project_id, revision)
      );

      CREATE INDEX IF NOT EXISTS governance_verification_runs_task_idx
        ON governance_verification_runs (task_id, recorded_at);

      CREATE INDEX IF NOT EXISTS governance_workspace_snapshots_project_idx
        ON governance_workspace_snapshots (project_id, revision);

      CREATE TRIGGER IF NOT EXISTS governance_verification_runs_no_update
      BEFORE UPDATE ON governance_verification_runs
      BEGIN
        SELECT RAISE(ABORT, 'governance_verification_runs is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS governance_verification_runs_no_delete
      BEFORE DELETE ON governance_verification_runs
      BEGIN
        SELECT RAISE(ABORT, 'governance_verification_runs is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS governance_verification_leases_no_update
      BEFORE UPDATE ON governance_verification_leases
      BEGIN
        SELECT RAISE(ABORT, 'governance_verification_leases is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS governance_verification_leases_no_delete
      BEFORE DELETE ON governance_verification_leases
      BEGIN
        SELECT RAISE(ABORT, 'governance_verification_leases is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS governance_verification_consumptions_no_update
      BEFORE UPDATE ON governance_verification_lease_consumptions
      BEGIN
        SELECT RAISE(ABORT, 'governance_verification_lease_consumptions is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS governance_verification_consumptions_no_delete
      BEFORE DELETE ON governance_verification_lease_consumptions
      BEGIN
        SELECT RAISE(ABORT, 'governance_verification_lease_consumptions is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS governance_workspace_snapshots_no_update
      BEFORE UPDATE ON governance_workspace_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'governance_workspace_snapshots is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS governance_workspace_snapshots_no_delete
      BEFORE DELETE ON governance_workspace_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'governance_workspace_snapshots is append-only');
      END;
    `);
  }

  recordWorkspaceSnapshot(projectId: string, manifestHash: string): RecordWorkspaceSnapshotResult {
    const capturedAt = this.#now();
    if (
      projectId.trim().length === 0 ||
      projectId.length > 512 ||
      !/^[a-f0-9]{64}$/u.test(manifestHash) ||
      !Number.isSafeInteger(Date.parse(capturedAt))
    ) {
      return {
        recorded: false,
        code: 'workspace_snapshot_invalid',
        message: 'Workspace snapshot identity is invalid.',
      };
    }
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const latest = this.#readLatestWorkspaceSnapshotRow(projectId);
      const revision = (latest?.revision ?? 0) + 1;
      const snapshot: WorkspaceSnapshotFenceDescriptor = {
        schemaVersion: WORKSPACE_SNAPSHOT_FENCE_SCHEMA_VERSION,
        snapshotId: workspaceSnapshotFenceId(projectId, revision, manifestHash, capturedAt),
        projectId,
        revision,
        manifestHash,
        capturedAt,
      };
      this.#db
        .prepare(
          `INSERT INTO governance_workspace_snapshots
             (snapshot_id, project_id, revision, manifest_hash, captured_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          snapshot.snapshotId,
          snapshot.projectId,
          snapshot.revision,
          snapshot.manifestHash,
          snapshot.capturedAt,
        );
      this.#db.exec('COMMIT');
      return deepFreeze({ recorded: true, snapshot });
    } catch (error) {
      // SQLite may have already ended the transaction when the write or
      // COMMIT failed; a follow-up ROLLBACK then throws `cannot rollback -
      // no transaction is active`, which would mask the original disk or
      // database error. Preserve the primary error for the caller.
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* preserve original error */
      }
      throw error;
    }
  }

  readLatestWorkspaceSnapshot(projectId: string): WorkspaceSnapshotFenceDescriptor | null {
    const row = this.#readLatestWorkspaceSnapshotRow(projectId);
    return row ? this.#workspaceSnapshotFromRow(row) : null;
  }

  issue(run: VerificationRunContract): IssueVerificationExecutionLeaseResult {
    return this.#issue(run);
  }

  issueIfCurrent(
    run: VerificationRunContract,
    precondition: VerificationLeaseIssuancePrecondition,
  ): IssueVerificationExecutionLeaseResult {
    if (!precondition || typeof precondition !== 'object') {
      return {
        issued: false,
        code: 'canonical_state_mismatch',
        message: 'Verification issuance precondition is invalid.',
      };
    }
    return this.#issue(run, precondition);
  }

  #issue(
    run: VerificationRunContract,
    precondition?: VerificationLeaseIssuancePrecondition,
  ): IssueVerificationExecutionLeaseResult {
    const now = this.#now();
    const nowMs = Date.parse(now);
    const expiresAtMs = Date.parse(run.limits.expiresAt);
    if (
      !isVerificationRunContractIntegrityValid(run) ||
      !Number.isSafeInteger(nowMs) ||
      !Number.isSafeInteger(expiresAtMs) ||
      nowMs < 0
    ) {
      return {
        issued: false,
        code: 'run_invalid',
        message: 'Verification run contract failed deterministic validation.',
      };
    }
    if (nowMs >= expiresAtMs) {
      return {
        issued: false,
        code: 'run_expired',
        message: 'Verification run contract has expired.',
      };
    }
    const runJson = canonicalJson(run);
    const runHash = createHash('sha256').update(runJson, 'utf8').digest('hex');
    const leaseId = verificationExecutionLeaseId(run.runId);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (precondition) {
        const preconditionFailure = this.#verifyIssuancePrecondition(run, precondition);
        if (preconditionFailure) {
          this.#db.exec('COMMIT');
          return preconditionFailure;
        }
      }
      const existingRun = this.#readRunRow(run.runId);
      if (existingRun && existingRun.contract_hash !== runHash) {
        this.#db.exec('COMMIT');
        return {
          issued: false,
          code: 'run_conflict',
          message: 'Verification run id is already bound to another contract payload.',
        };
      }
      if (this.#readLeaseRow(leaseId)) {
        this.#db.exec('COMMIT');
        return {
          issued: false,
          code: 'already_issued',
          message: 'Verification run already has an execution lease.',
        };
      }
      const secret = this.#verificationLeaseSecret();
      if (secret.trim().length < 32 || secret.length > 512) {
        throw new Error('Verification lease secret source returned invalid material.');
      }
      if (!existingRun) this.#insertRun(run, runJson, runHash, now);
      this.#db
        .prepare(
          `INSERT INTO governance_verification_leases
             (lease_id, run_id, task_id, verifier_client_id, verifier_hash, issued_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          leaseId,
          run.runId,
          run.taskId,
          run.verifierClientId,
          verificationExecutionLeaseSecretHash(secret),
          now,
          run.limits.expiresAt,
        );
      this.#db.exec('COMMIT');
      return deepFreeze({
        issued: true,
        run,
        lease: this.#leaseDescriptor({
          lease_id: leaseId,
          run_id: run.runId,
          task_id: run.taskId,
          verifier_client_id: run.verifierClientId,
          verifier_hash: verificationExecutionLeaseSecretHash(secret),
          issued_at: now,
          expires_at: run.limits.expiresAt,
        }),
        credential: { leaseId, secret },
      });
    } catch (error) {
      // SQLite may have already ended the transaction when the write or
      // COMMIT failed; a follow-up ROLLBACK then throws `cannot rollback -
      // no transaction is active`, which would mask the original disk or
      // database error. Preserve the primary error for the caller.
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* preserve original error */
      }
      throw error;
    }
  }

  #verifyIssuancePrecondition(
    run: VerificationRunContract,
    precondition: VerificationLeaseIssuancePrecondition,
  ): VerificationLeaseIssuanceFailure | null {
    if (
      !Number.isSafeInteger(precondition.taskRevision) ||
      precondition.taskRevision < 1 ||
      !Number.isSafeInteger(precondition.activeContractVersion) ||
      precondition.activeContractVersion < 1 ||
      !Number.isSafeInteger(precondition.activePlanVersion) ||
      precondition.activePlanVersion < 1 ||
      !/^[a-f0-9]{64}$/u.test(precondition.activePlanFingerprint) ||
      !precondition.workspaceSnapshot ||
      !isWorkspaceSnapshotFenceDescriptorValid(precondition.workspaceSnapshot) ||
      !precondition.candidateObservation ||
      !Number.isSafeInteger(precondition.candidateObservation.sequence) ||
      precondition.candidateObservation.sequence < 1 ||
      typeof precondition.candidateObservation.observationId !== 'string' ||
      precondition.candidateObservation.observationId.trim().length === 0 ||
      precondition.candidateObservation.observationId.length > 512 ||
      (precondition.workflowState !== 'proposed_complete' &&
        precondition.workflowState !== 'verifying')
    ) {
      return {
        issued: false,
        code: 'canonical_state_mismatch',
        message: 'Verification issuance precondition is invalid.',
      };
    }
    if (
      !/^[a-f0-9]{64}$/.test(precondition.workspaceManifestHash) ||
      precondition.workspaceManifestHash !== run.workspaceManifestHash
    ) {
      return {
        issued: false,
        code: 'workspace_mismatch',
        message: 'Fresh workspace identity does not match the authorized verification run.',
      };
    }
    const rows = this.#db
      .prepare(
        `SELECT task_id, revision, event_json FROM governance_events
         WHERE task_id = ? ORDER BY revision`,
      )
      .all(run.taskId) as unknown as GovernanceEventJsonRow[];
    if (rows.length === 0) {
      return {
        issued: false,
        code: 'canonical_task_missing',
        message: 'Canonical task state is absent during verification issuance.',
      };
    }
    let replayed: ReturnType<typeof replayTaskEvents>;
    try {
      const events = rows.map((row) => {
        const event = JSON.parse(row.event_json) as GovernanceEvent;
        if (event.taskId !== row.task_id || event.revision !== row.revision) {
          throw new Error('Canonical event columns do not match their payload.');
        }
        return event;
      });
      replayed = replayTaskEvents(events);
    } catch {
      return {
        issued: false,
        code: 'canonical_state_invalid',
        message: 'Canonical task events could not be reconstructed during verification issuance.',
      };
    }
    if (!replayed.replayed) {
      return {
        issued: false,
        code: 'canonical_state_invalid',
        message: 'Canonical task events failed deterministic replay during verification issuance.',
      };
    }
    const aggregate = replayed.aggregate;
    if (aggregate.taskId !== run.taskId) {
      return {
        issued: false,
        code: 'canonical_state_invalid',
        message: 'Canonical task identity is invalid during verification issuance.',
      };
    }
    const activePlan = aggregate.plans.find(
      (plan) => plan.planVersion === aggregate.activePlanVersion,
    );
    if (!activePlan) {
      return {
        issued: false,
        code: 'canonical_state_invalid',
        message: 'Canonical active plan is absent during verification issuance.',
      };
    }
    if (
      aggregate.revision !== precondition.taskRevision ||
      aggregate.activeContractVersion !== precondition.activeContractVersion ||
      aggregate.activePlanVersion !== precondition.activePlanVersion ||
      calculatePlanVersionFingerprint(activePlan) !== precondition.activePlanFingerprint ||
      aggregate.state !== precondition.workflowState ||
      run.contractVersion !== aggregate.activeContractVersion
    ) {
      return {
        issued: false,
        code: 'canonical_state_mismatch',
        message: 'Canonical task state changed before verification lease issuance.',
      };
    }
    const workspaceFailure = this.#verifyWorkspaceSnapshotPrecondition(
      run,
      precondition,
      aggregate.projectId,
    );
    if (workspaceFailure) return workspaceFailure;
    return this.#verifyCandidatePrecondition(run, precondition, aggregate.projectId);
  }

  #verifyWorkspaceSnapshotPrecondition(
    run: VerificationRunContract,
    precondition: VerificationLeaseIssuancePrecondition,
    projectId: string,
  ): VerificationLeaseIssuanceFailure | null {
    const row = this.#readLatestWorkspaceSnapshotRow(projectId);
    if (!row) {
      return {
        issued: false,
        code: 'workspace_snapshot_missing',
        message: 'Canonical workspace snapshot is absent during verification issuance.',
      };
    }
    let latest: WorkspaceSnapshotFenceDescriptor;
    try {
      latest = this.#workspaceSnapshotFromRow(row);
    } catch {
      return {
        issued: false,
        code: 'workspace_snapshot_invalid',
        message: 'Canonical workspace snapshot is invalid during verification issuance.',
      };
    }
    if (latest.projectId !== projectId || precondition.workspaceSnapshot.projectId !== projectId) {
      return {
        issued: false,
        code: 'workspace_mismatch',
        message: 'Canonical workspace snapshot does not match the governed project.',
      };
    }
    if (
      latest.revision !== precondition.workspaceSnapshot.revision ||
      latest.snapshotId !== precondition.workspaceSnapshot.snapshotId
    ) {
      return {
        issued: false,
        code: 'workspace_snapshot_stale',
        message: 'A newer canonical workspace snapshot exists during verification issuance.',
      };
    }
    if (
      latest.manifestHash !== run.workspaceManifestHash ||
      precondition.workspaceSnapshot.manifestHash !== run.workspaceManifestHash
    ) {
      return {
        issued: false,
        code: 'workspace_mismatch',
        message: 'Canonical workspace snapshot does not match the authorized verification run.',
      };
    }
    return null;
  }

  #verifyCandidatePrecondition(
    run: VerificationRunContract,
    precondition: VerificationLeaseIssuancePrecondition,
    projectId: string,
  ): VerificationLeaseIssuanceFailure | null {
    const row = this.#db
      .prepare(
        `SELECT sequence, observation_id, project_id, task_id, source, category,
                observation_json, observation_hash, observed_at, recorded_at
         FROM governance_observations
         WHERE sequence = ?`,
      )
      .get(precondition.candidateObservation.sequence) as unknown as
      | GovernanceEvidenceObservationRow
      | undefined;
    if (!row) {
      return {
        issued: false,
        code: 'canonical_candidate_missing',
        message: 'Selected evidence candidate is absent during verification issuance.',
      };
    }
    let observation: GovernanceEvidenceCandidateObservation;
    try {
      const payload = JSON.parse(row.observation_json) as Record<string, unknown>;
      if (
        createHash('sha256').update(row.observation_json, 'utf8').digest('hex') !==
          row.observation_hash ||
        payload['observationId'] !== row.observation_id ||
        payload['projectId'] !== row.project_id ||
        payload['taskId'] !== row.task_id ||
        payload['source'] !== row.source ||
        payload['category'] !== row.category ||
        payload['observedAt'] !== row.observed_at ||
        !payload['payload'] ||
        typeof payload['payload'] !== 'object' ||
        Array.isArray(payload['payload'])
      ) {
        throw new Error('Canonical candidate columns do not match their payload.');
      }
      observation = {
        sequence: row.sequence,
        observationId: row.observation_id,
        source: row.source,
        taskId: row.task_id,
        category: row.category,
        observedAt: row.observed_at,
        recordedAt: row.recorded_at,
        payload: payload['payload'] as Readonly<Record<string, unknown>>,
      };
    } catch {
      return {
        issued: false,
        code: 'canonical_candidate_invalid',
        message: 'Selected evidence candidate could not be reconstructed during issuance.',
      };
    }
    const candidate = evaluateGovernanceEvidenceCandidateObservation(observation);
    if (candidate.evaluation.state !== 'eligible_for_evaluation') {
      return {
        issued: false,
        code: 'canonical_candidate_invalid',
        message: 'Selected evidence candidate is not eligible for verification.',
      };
    }
    if (
      row.project_id !== projectId ||
      row.category !== 'evidence_candidate' ||
      candidate.sequence !== precondition.candidateObservation.sequence ||
      candidate.observationId !== precondition.candidateObservation.observationId ||
      candidate.taskId !== run.taskId ||
      candidate.candidateId !== run.candidateId ||
      candidate.source !== run.candidateSource ||
      candidate.planFingerprint !== run.planFingerprint ||
      candidate.workspaceManifestHash !== run.workspaceManifestHash
    ) {
      return {
        issued: false,
        code: 'canonical_candidate_mismatch',
        message: 'Selected evidence candidate does not match the authorized verification run.',
      };
    }
    return null;
  }

  #readLatestWorkspaceSnapshotRow(projectId: string): WorkspaceSnapshotRow | undefined {
    return this.#db
      .prepare(
        `SELECT snapshot_id, project_id, revision, manifest_hash, captured_at
         FROM governance_workspace_snapshots
         WHERE project_id = ?
         ORDER BY revision DESC
         LIMIT 1`,
      )
      .get(projectId) as unknown as WorkspaceSnapshotRow | undefined;
  }

  #workspaceSnapshotFromRow(row: WorkspaceSnapshotRow): WorkspaceSnapshotFenceDescriptor {
    const snapshot: WorkspaceSnapshotFenceDescriptor = {
      schemaVersion: WORKSPACE_SNAPSHOT_FENCE_SCHEMA_VERSION,
      snapshotId: row.snapshot_id,
      projectId: row.project_id,
      revision: row.revision,
      manifestHash: row.manifest_hash,
      capturedAt: row.captured_at,
    };
    if (!isWorkspaceSnapshotFenceDescriptorValid(snapshot)) {
      throw new Error('Stored workspace snapshot failed deterministic validation.');
    }
    return deepFreeze(snapshot);
  }

  consume(
    credential: VerificationExecutionLeaseCredential,
    binding: VerificationExecutionBinding,
  ): ConsumeVerificationExecutionLeaseResult {
    if (
      !/^[a-f0-9]{64}$/u.test(credential.leaseId) ||
      credential.secret.trim().length === 0 ||
      credential.secret.length > 512
    ) {
      return this.#consumeFailure(
        'invalid_credential',
        'Verification lease credential is invalid.',
      );
    }
    const now = this.#now();
    const nowMs = Date.parse(now);
    if (!Number.isSafeInteger(nowMs)) {
      return this.#consumeFailure('stored_run_invalid', 'Verification store clock is invalid.');
    }
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const leaseRow = this.#readLeaseRow(credential.leaseId);
      if (
        !leaseRow ||
        !verificationExecutionLeaseSecretMatches(credential.secret, leaseRow.verifier_hash)
      ) {
        return this.#finishConsumeFailure(
          'invalid_credential',
          'Verification lease credential is invalid.',
        );
      }
      if (this.#readConsumptionRow(credential.leaseId)) {
        return this.#finishConsumeFailure(
          'already_consumed',
          'Verification lease was already consumed.',
        );
      }
      if (nowMs >= Date.parse(leaseRow.expires_at)) {
        return this.#finishConsumeFailure('expired', 'Verification lease has expired.');
      }
      let run: VerificationRunContract;
      try {
        const runRow = this.#readRunRow(leaseRow.run_id);
        if (!runRow) throw new Error('missing run');
        run = this.#runFromRow(runRow);
      } catch {
        return this.#finishConsumeFailure(
          'stored_run_invalid',
          'Stored verification run failed integrity checks.',
        );
      }
      if (
        binding.runId !== run.runId ||
        binding.taskId !== run.taskId ||
        binding.verifierClientId !== run.verifierClientId ||
        binding.planFingerprint !== run.planFingerprint ||
        binding.workspaceManifestHash !== run.workspaceManifestHash
      ) {
        return this.#finishConsumeFailure(
          'binding_mismatch',
          'Execution binding does not match the authorized run.',
        );
      }
      const bindingHash = verificationExecutionBindingHash(binding);
      this.#db
        .prepare(
          `INSERT INTO governance_verification_lease_consumptions
             (lease_id, run_id, verifier_client_id, binding_hash, consumed_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(credential.leaseId, run.runId, run.verifierClientId, bindingHash, now);
      this.#db.exec('COMMIT');
      return deepFreeze({
        authorized: true,
        run,
        consumption: {
          leaseId: credential.leaseId,
          runId: run.runId,
          verifierClientId: run.verifierClientId,
          consumedAt: now,
          bindingHash,
        },
      });
    } catch (error) {
      // SQLite may have already ended the transaction when the write or
      // COMMIT failed; a follow-up ROLLBACK then throws `cannot rollback -
      // no transaction is active`, which would mask the original disk or
      // database error. Preserve the primary error for the caller.
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* preserve original error */
      }
      throw error;
    }
  }

  readStatus(leaseId: string): VerificationExecutionLeaseStatus {
    const row = this.#readLeaseRow(leaseId);
    if (!row) return Object.freeze({ state: 'missing', leaseId });
    const consumptionRow = this.#readConsumptionRow(leaseId);
    const consumption = consumptionRow ? this.#consumptionFromRow(consumptionRow) : null;
    const nowMs = Date.parse(this.#now());
    if (!Number.isSafeInteger(nowMs)) throw new Error('Verification store clock is invalid.');
    return deepFreeze({
      state: consumption ? 'consumed' : nowMs >= Date.parse(row.expires_at) ? 'expired' : 'active',
      lease: this.#leaseDescriptor(row),
      consumption,
    });
  }

  #insertRun(run: VerificationRunContract, runJson: string, runHash: string, now: string): void {
    this.#db
      .prepare(
        `INSERT INTO governance_verification_runs
           (run_id, task_id, draft_id, verifier_client_id, contract_json, contract_hash,
            issued_at, expires_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.runId,
        run.taskId,
        run.draftId,
        run.verifierClientId,
        runJson,
        runHash,
        run.limits.issuedAt,
        run.limits.expiresAt,
        now,
      );
  }

  #readRunRow(runId: string): VerificationRunRow | null {
    return (this.#db
      .prepare(
        `SELECT run_id, task_id, draft_id, verifier_client_id, contract_json, contract_hash,
                issued_at, expires_at, recorded_at
         FROM governance_verification_runs WHERE run_id = ?`,
      )
      .get(runId) ?? null) as VerificationRunRow | null;
  }

  #readLeaseRow(leaseId: string): VerificationLeaseRow | null {
    return (this.#db
      .prepare(
        `SELECT lease_id, run_id, task_id, verifier_client_id, verifier_hash, issued_at, expires_at
         FROM governance_verification_leases WHERE lease_id = ?`,
      )
      .get(leaseId) ?? null) as VerificationLeaseRow | null;
  }

  #readConsumptionRow(leaseId: string): VerificationLeaseConsumptionRow | null {
    return (this.#db
      .prepare(
        `SELECT lease_id, run_id, verifier_client_id, binding_hash, consumed_at
         FROM governance_verification_lease_consumptions WHERE lease_id = ?`,
      )
      .get(leaseId) ?? null) as VerificationLeaseConsumptionRow | null;
  }

  #runFromRow(row: VerificationRunRow): VerificationRunContract {
    const run = JSON.parse(row.contract_json) as VerificationRunContract;
    const hash = createHash('sha256').update(canonicalJson(run), 'utf8').digest('hex');
    if (
      hash !== row.contract_hash ||
      run.runId !== row.run_id ||
      run.taskId !== row.task_id ||
      run.draftId !== row.draft_id ||
      run.verifierClientId !== row.verifier_client_id ||
      run.limits.issuedAt !== row.issued_at ||
      run.limits.expiresAt !== row.expires_at ||
      !isVerificationRunContractIntegrityValid(run)
    ) {
      throw new Error(`Stored verification run integrity failed for ${row.run_id}.`);
    }
    return deepFreeze(run);
  }

  #leaseDescriptor(row: VerificationLeaseRow): VerificationExecutionLeaseDescriptor {
    return Object.freeze({
      schemaVersion: VERIFICATION_EXECUTION_LEASE_SCHEMA_VERSION,
      leaseId: row.lease_id,
      runId: row.run_id,
      taskId: row.task_id,
      verifierClientId: row.verifier_client_id,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
    });
  }

  #consumptionFromRow(row: VerificationLeaseConsumptionRow): VerificationExecutionLeaseConsumption {
    return Object.freeze({
      leaseId: row.lease_id,
      runId: row.run_id,
      verifierClientId: row.verifier_client_id,
      bindingHash: row.binding_hash,
      consumedAt: row.consumed_at,
    });
  }

  #consumeFailure(
    code: Extract<ConsumeVerificationExecutionLeaseResult, { authorized: false }>['code'],
    message: string,
  ): ConsumeVerificationExecutionLeaseResult {
    return { authorized: false, code, message };
  }

  #finishConsumeFailure(
    code: Extract<ConsumeVerificationExecutionLeaseResult, { authorized: false }>['code'],
    message: string,
  ): ConsumeVerificationExecutionLeaseResult {
    this.#db.exec('COMMIT');
    return this.#consumeFailure(code, message);
  }
}
