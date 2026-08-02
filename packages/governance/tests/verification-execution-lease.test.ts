import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateVerificationRunId,
  SqliteGovernanceEventStore,
  VerificationCheckRegistry,
  type VerificationExecutionBinding,
  type VerificationRunContract,
  type VerificationRunContractV1,
  type VerificationRunContractV2,
  verificationExecutionLeaseId,
  workspaceSnapshotFenceId,
} from '../src/index.js';

const temporaryDirectories: string[] = [];
const stores: SqliteGovernanceEventStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wrongstack-verification-lease-'));
  temporaryDirectories.push(directory);
  return join(directory, 'governance.sqlite');
}

function openStore(
  path: string,
  options: {
    readonly now?: (() => string) | undefined;
    readonly verificationLeaseSecret?: (() => string) | undefined;
  } = {},
): SqliteGovernanceEventStore {
  const store = SqliteGovernanceEventStore.open(path, options);
  stores.push(store);
  return store;
}

function run(): VerificationRunContractV1 {
  const contract: Omit<VerificationRunContractV1, 'runId'> = {
    schemaVersion: 1,
    status: 'authorized',
    draftId: 'd'.repeat(64),
    taskId: 'task-1',
    contractVersion: 2,
    planFingerprint: 'a'.repeat(64),
    workspaceManifestHash: 'b'.repeat(64),
    requiredCheckId: 'check-test',
    expectedEvidenceKind: 'test',
    candidateId: 'c'.repeat(64),
    candidateSource: 'executor-client',
    verifierClientId: 'independent-verifier',
    authorization: { operation: 'focused_check', mode: 'automatic', autonomyTier: 'A2' },
    limits: {
      issuedAt: '2026-08-02T12:00:00.000Z',
      expiresAt: '2026-08-02T12:10:00.000Z',
      ttlMs: 600_000,
      maxDurationMs: 300_000,
    },
    resultPolicy: {
      executorMayApprove: false,
      independentToolEvidenceRequired: true,
      freshWorkspaceIdentityRequired: true,
    },
  };
  return { ...contract, runId: calculateVerificationRunId(contract) };
}

function boundRun(): VerificationRunContractV2 {
  const registry = new VerificationCheckRegistry([
    {
      id: 'check-test',
      evidenceKind: 'test',
      handlerVersion: '1.0.0',
      executionClass: 'trusted_deterministic',
      run: async () => 'ok',
    },
  ]);
  const resolved = registry.bindingFor('check-test', 'test');
  if (!resolved.bound) throw new Error(resolved.message);
  const legacy = run();
  const { runId: _runId, schemaVersion: _schemaVersion, ...shared } = legacy;
  const contract: Omit<VerificationRunContractV2, 'runId'> = {
    schemaVersion: 2,
    ...shared,
    checkBinding: resolved.binding,
  };
  return { ...contract, runId: calculateVerificationRunId(contract) };
}

function binding(contract: VerificationRunContract = run()): VerificationExecutionBinding {
  return {
    runId: contract.runId,
    taskId: contract.taskId,
    verifierClientId: contract.verifierClientId,
    planFingerprint: contract.planFingerprint,
    workspaceManifestHash: contract.workspaceManifestHash,
  };
}

function workspaceSnapshot() {
  const capturedAt = '2026-08-02T12:01:00.000Z';
  return {
    schemaVersion: 1 as const,
    snapshotId: workspaceSnapshotFenceId('project-1', 1, 'b'.repeat(64), capturedAt),
    projectId: 'project-1',
    revision: 1,
    manifestHash: 'b'.repeat(64),
    capturedAt,
  };
}

describe('verification execution lease store', () => {
  it('persists append-only workspace snapshot revisions across restart', () => {
    const path = databasePath();
    const first = openStore(path, { now: () => '2026-08-02T12:01:00.000Z' });
    const initial = first.recordWorkspaceSnapshot('project-1', 'b'.repeat(64));
    expect(initial).toMatchObject({
      recorded: true,
      snapshot: { projectId: 'project-1', revision: 1, manifestHash: 'b'.repeat(64) },
    });
    first.close();

    const reopened = openStore(path, { now: () => '2026-08-02T12:02:00.000Z' });
    const next = reopened.recordWorkspaceSnapshot('project-1', 'd'.repeat(64));
    expect(next).toMatchObject({
      recorded: true,
      snapshot: { projectId: 'project-1', revision: 2, manifestHash: 'd'.repeat(64) },
    });
    expect(reopened.readLatestWorkspaceSnapshot('project-1')).toEqual(
      next.recorded ? next.snapshot : null,
    );

    const direct = new DatabaseSync(path);
    expect(() =>
      direct.exec('UPDATE governance_workspace_snapshots SET revision = revision'),
    ).toThrow(/append-only/);
    expect(() => direct.exec('DELETE FROM governance_workspace_snapshots')).toThrow(/append-only/);
    direct.close();
  });

  it('keeps direct issuance compatible while conditional issuance requires canonical state', () => {
    const store = openStore(databasePath(), {
      now: () => '2026-08-02T12:01:00.000Z',
      verificationLeaseSecret: () => 'c'.repeat(43),
    });
    const contract = run();

    expect(store.issueVerificationExecutionLeaseIfCurrent(contract, undefined as never)).toEqual({
      issued: false,
      code: 'canonical_state_mismatch',
      message: 'Verification issuance precondition is invalid.',
    });
    expect(
      store.issueVerificationExecutionLeaseIfCurrent(contract, {
        taskRevision: 1,
        activeContractVersion: contract.contractVersion,
        activePlanVersion: 1,
        activePlanFingerprint: 'a'.repeat(64),
        workflowState: 'proposed_complete',
        workspaceManifestHash: contract.workspaceManifestHash,
        workspaceSnapshot: workspaceSnapshot(),
        candidateObservation: { sequence: 1, observationId: 'observation-1' },
      }),
    ).toEqual({
      issued: false,
      code: 'canonical_task_missing',
      message: 'Canonical task state is absent during verification issuance.',
    });
    expect(store.issueVerificationExecutionLease(contract)).toMatchObject({ issued: true });
  });

  it('bounds structurally corrupt canonical events without issuing a lease', () => {
    const path = databasePath();
    const store = openStore(path, {
      now: () => '2026-08-02T12:01:00.000Z',
      verificationLeaseSecret: () => 'c'.repeat(43),
    });
    const direct = new DatabaseSync(path);
    direct
      .prepare(
        `INSERT INTO governance_events
           (task_id, revision, event_id, command_id, event_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'task-1',
        1,
        'corrupt-event',
        'corrupt-command',
        JSON.stringify({ taskId: 'task-1', revision: 1 }),
        '2026-08-02T12:00:00.000Z',
      );
    direct.close();
    const contract = run();

    expect(
      store.issueVerificationExecutionLeaseIfCurrent(contract, {
        taskRevision: 1,
        activeContractVersion: contract.contractVersion,
        activePlanVersion: 1,
        activePlanFingerprint: 'a'.repeat(64),
        workflowState: 'proposed_complete',
        workspaceManifestHash: contract.workspaceManifestHash,
        workspaceSnapshot: workspaceSnapshot(),
        candidateObservation: { sequence: 1, observationId: 'observation-1' },
      }),
    ).toEqual({
      issued: false,
      code: 'canonical_state_invalid',
      message: 'Canonical task events could not be reconstructed during verification issuance.',
    });
    expect(
      store.readVerificationExecutionLeaseStatus(verificationExecutionLeaseId(contract.runId)),
    ).toEqual({
      state: 'missing',
      leaseId: verificationExecutionLeaseId(contract.runId),
    });
  });

  it('persists an immutable run and returns the lease secret only once', () => {
    const path = databasePath();
    const secret = 's'.repeat(43);
    const secretSource = vi.fn(() => secret);
    const store = openStore(path, {
      now: () => '2026-08-02T12:01:00.000Z',
      verificationLeaseSecret: secretSource,
    });
    const contract = run();
    const first = store.issueVerificationExecutionLease(contract);
    const replay = store.issueVerificationExecutionLease(contract);

    expect(first).toMatchObject({
      issued: true,
      run: { runId: contract.runId },
      lease: {
        leaseId: verificationExecutionLeaseId(contract.runId),
        taskId: 'task-1',
        verifierClientId: 'independent-verifier',
        issuedAt: '2026-08-02T12:01:00.000Z',
        expiresAt: '2026-08-02T12:10:00.000Z',
      },
      credential: { secret },
    });
    expect(replay).toMatchObject({ issued: false, code: 'already_issued' });
    expect(secretSource).toHaveBeenCalledTimes(1);

    const direct = new DatabaseSync(path);
    const stored = direct
      .prepare(
        `SELECT r.contract_json, l.verifier_hash
         FROM governance_verification_runs r
         JOIN governance_verification_leases l ON l.run_id = r.run_id`,
      )
      .get() as { contract_json: string; verifier_hash: string };
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored.verifier_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => direct.exec('UPDATE governance_verification_runs SET task_id = task_id')).toThrow(
      /append-only/,
    );
    expect(() => direct.exec('DELETE FROM governance_verification_leases')).toThrow(/append-only/);
    direct.close();
    store.close();
  });

  it('survives restart and consumes exactly once without burning mismatched bindings', () => {
    const path = databasePath();
    const first = openStore(path, {
      now: () => '2026-08-02T12:01:00.000Z',
      verificationLeaseSecret: () => 'x'.repeat(43),
    });
    const issued = first.issueVerificationExecutionLease(run());
    if (!issued.issued) throw new Error('Expected lease issuance.');
    first.close();

    const reopened = openStore(path, {
      now: () => '2026-08-02T12:02:00.000Z',
    });
    expect(
      reopened.consumeVerificationExecutionLease(issued.credential, {
        ...binding(issued.run),
        workspaceManifestHash: 'e'.repeat(64),
      }),
    ).toMatchObject({ authorized: false, code: 'binding_mismatch' });
    expect(reopened.readVerificationExecutionLeaseStatus(issued.lease.leaseId)).toMatchObject({
      state: 'active',
      consumption: null,
    });
    const consumed = reopened.consumeVerificationExecutionLease(
      issued.credential,
      binding(issued.run),
    );
    expect(consumed).toMatchObject({
      authorized: true,
      consumption: {
        leaseId: issued.lease.leaseId,
        runId: issued.run.runId,
        consumedAt: '2026-08-02T12:02:00.000Z',
        bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(
      reopened.consumeVerificationExecutionLease(issued.credential, binding(issued.run)),
    ).toMatchObject({ authorized: false, code: 'already_consumed' });
    const direct = new DatabaseSync(path);
    expect(() => direct.exec('DELETE FROM governance_verification_lease_consumptions')).toThrow(
      /append-only/,
    );
    direct.close();
    reopened.close();

    const secondRestart = openStore(path, {
      now: () => '2026-08-02T12:03:00.000Z',
    });
    expect(secondRestart.readVerificationExecutionLeaseStatus(issued.lease.leaseId)).toMatchObject({
      state: 'consumed',
      consumption: { runId: issued.run.runId },
    });
    secondRestart.close();
  });

  it('persists and reloads a v2 registry-bound run without weakening its identity', () => {
    const path = databasePath();
    const first = openStore(path, { now: () => '2026-08-02T12:01:00.000Z' });
    const contract = boundRun();
    const issued = first.issueVerificationExecutionLease(contract);
    if (!issued.issued) throw new Error(issued.message);
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = openStore(path, { now: () => '2026-08-02T12:02:00.000Z' });
    const consumed = reopened.consumeVerificationExecutionLease(
      issued.credential,
      binding(contract),
    );

    expect(consumed).toMatchObject({
      authorized: true,
      run: {
        schemaVersion: 2,
        runId: contract.runId,
        checkBinding: {
          registryFingerprint: contract.checkBinding.registryFingerprint,
          handlerFingerprint: contract.checkBinding.handlerFingerprint,
        },
      },
    });
  });

  it('allows only one consumer across concurrent store connections', () => {
    const path = databasePath();
    const first = openStore(path, {
      now: () => '2026-08-02T12:01:00.000Z',
      verificationLeaseSecret: () => 'y'.repeat(43),
    });
    const second = openStore(path, {
      now: () => '2026-08-02T12:01:00.000Z',
    });
    const issued = first.issueVerificationExecutionLease(run());
    if (!issued.issued) throw new Error('Expected lease issuance.');

    const winner = first.consumeVerificationExecutionLease(issued.credential, binding(issued.run));
    const loser = second.consumeVerificationExecutionLease(issued.credential, binding(issued.run));
    expect(winner).toMatchObject({ authorized: true });
    expect(loser).toMatchObject({ authorized: false, code: 'already_consumed' });
    first.close();
    second.close();
  });

  it('expires inclusively and rejects tampered run contracts before persistence', () => {
    const path = databasePath();
    let now = '2026-08-02T12:01:00.000Z';
    const store = openStore(path, {
      now: () => now,
      verificationLeaseSecret: () => 'z'.repeat(43),
    });
    const contract = run();
    expect(
      store.issueVerificationExecutionLease({ ...contract, taskId: 'tampered-task' }),
    ).toMatchObject({ issued: false, code: 'run_invalid' });
    const unsafeWithoutId = {
      ...contract,
      resultPolicy: { ...contract.resultPolicy, executorMayApprove: true },
    } as unknown as Omit<VerificationRunContractV1, 'runId'>;
    const unsafe = {
      ...unsafeWithoutId,
      runId: calculateVerificationRunId(unsafeWithoutId),
    } as VerificationRunContractV1;
    expect(store.issueVerificationExecutionLease(unsafe)).toMatchObject({
      issued: false,
      code: 'run_invalid',
    });
    const issued = store.issueVerificationExecutionLease(contract);
    if (!issued.issued) throw new Error('Expected lease issuance.');
    now = contract.limits.expiresAt;

    expect(
      store.consumeVerificationExecutionLease(issued.credential, binding(contract)),
    ).toMatchObject({ authorized: false, code: 'expired' });
    expect(store.readVerificationExecutionLeaseStatus(issued.lease.leaseId)).toMatchObject({
      state: 'expired',
    });
    store.close();
  });

  it('migrates an existing v1 database additively to the lease schema', () => {
    const path = databasePath();
    const legacy = new DatabaseSync(path);
    legacy.exec('PRAGMA user_version = 1');
    legacy.close();

    const store = openStore(path);
    store.close();
    const migrated = new DatabaseSync(path);
    const version = migrated.prepare('PRAGMA user_version').get() as { user_version: number };
    const table = migrated
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'governance_verification_lease_consumptions'`,
      )
      .get() as { name: string } | undefined;
    expect(version.user_version).toBe(2);
    expect(table?.name).toBe('governance_verification_lease_consumptions');
    migrated.close();
  });
});
