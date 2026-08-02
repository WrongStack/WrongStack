import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateVerificationRunId,
  type EvidenceKind,
  SqliteGovernanceEventStore,
  type VerificationCheckRegistration,
  VerificationCheckRegistry,
  type VerificationRunContractV1,
  type VerificationRunContractV2,
  VerificationToolGateway,
  type VerificationToolGatewayRequestV1,
} from '../src/index.js';

const temporaryDirectories: string[] = [];
const stores: SqliteGovernanceEventStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openStore(now: () => string): SqliteGovernanceEventStore {
  const directory = mkdtempSync(join(tmpdir(), 'wrongstack-verification-gateway-'));
  temporaryDirectories.push(directory);
  const store = SqliteGovernanceEventStore.open(join(directory, 'governance.sqlite'), {
    now,
    verificationLeaseSecret: () => 's'.repeat(43),
  });
  stores.push(store);
  return store;
}

function run(): VerificationRunContractV2 {
  const binding = registry(async () => undefined).bindingFor('check-test', 'test');
  if (!binding.bound) throw new Error(binding.message);
  const contract: Omit<VerificationRunContractV2, 'runId'> = {
    schemaVersion: 2,
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
    checkBinding: binding.binding,
  };
  return { ...contract, runId: calculateVerificationRunId(contract) };
}

function legacyRun(): VerificationRunContractV1 {
  const current = run();
  const {
    checkBinding: _checkBinding,
    runId: _runId,
    schemaVersion: _schemaVersion,
    ...shared
  } = current;
  const contract: Omit<VerificationRunContractV1, 'runId'> = {
    schemaVersion: 1,
    ...shared,
  };
  return { ...contract, runId: calculateVerificationRunId(contract) };
}

function request(
  issued: Extract<
    ReturnType<SqliteGovernanceEventStore['issueVerificationExecutionLease']>,
    { issued: true }
  >,
): VerificationToolGatewayRequestV1 {
  return {
    schemaVersion: 1,
    credential: issued.credential,
    expected: {
      runId: issued.run.runId,
      taskId: issued.run.taskId,
      planFingerprint: issued.run.planFingerprint,
    },
  };
}

function registry<Result>(
  handler: VerificationCheckRegistration<Result>['run'],
  evidenceKind: EvidenceKind = 'test',
  handlerVersion = '1.0.0',
): VerificationCheckRegistry<Result> {
  return new VerificationCheckRegistry([
    {
      id: 'check-test',
      evidenceKind,
      handlerVersion,
      executionClass: 'trusted_deterministic',
      run: handler,
    },
  ]);
}

describe('verification tool gateway', () => {
  it('defaults to legacy and touches no governance dependency', async () => {
    const store = openStore(() => '2026-08-02T12:01:00.000Z');
    const consume = vi.spyOn(store, 'consumeVerificationExecutionLease');
    const capture = vi.fn(async () => ({ manifestHash: 'b'.repeat(64) }));
    const runner = vi.fn(async () => ({ exitCode: 0 }));
    const gateway = new VerificationToolGateway({
      mode: 'unexpected' as 'enforced',
      verifierClientId: 'independent-verifier',
      leaseConsumer: store,
      captureWorkspaceIdentity: capture,
      checkRegistry: registry(runner),
    });

    await expect(gateway.execute(null as never)).resolves.toEqual({
      route: 'legacy',
      handled: false,
      reason: 'gateway_disabled',
    });
    expect(consume).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it('consumes immediately before executing only the canonical focused check', async () => {
    const store = openStore(() => '2026-08-02T12:01:00.000Z');
    const issued = store.issueVerificationExecutionLease(run());
    if (!issued.issued) throw new Error(issued.message);
    const capture = vi.fn(async () => ({ manifestHash: 'b'.repeat(64) }));
    const runner = vi.fn(async (context) => ({ checked: context.run.requiredCheckId }));
    const gateway = new VerificationToolGateway({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      leaseConsumer: store,
      captureWorkspaceIdentity: capture,
      checkRegistry: registry(runner),
    });
    const result = await gateway.execute(request(issued));

    expect(result).toMatchObject({
      route: 'governed',
      handled: true,
      authorized: true,
      outcome: 'succeeded',
      check: { id: 'check-test', evidenceKind: 'test', handlerVersion: '1.0.0' },
      result: { checked: 'check-test' },
    });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0]).toMatchObject({
      run: { requiredCheckId: 'check-test', limits: { maxDurationMs: 300_000 } },
      workspaceManifestHash: 'b'.repeat(64),
    });
    expect(runner.mock.calls[0]?.[0]).not.toHaveProperty('command');
    expect(store.readVerificationExecutionLeaseStatus(issued.lease.leaseId)).toMatchObject({
      state: 'consumed',
    });
  });

  it('rejects arbitrary tool payload fields without burning the lease', async () => {
    const store = openStore(() => '2026-08-02T12:01:00.000Z');
    const issued = store.issueVerificationExecutionLease(run());
    if (!issued.issued) throw new Error(issued.message);
    const capture = vi.fn(async () => ({ manifestHash: 'b'.repeat(64) }));
    const runner = vi.fn(async () => 'ok');
    const gateway = new VerificationToolGateway({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      leaseConsumer: store,
      captureWorkspaceIdentity: capture,
      checkRegistry: registry(runner),
    });
    const arbitraryPayload = {
      ...request(issued),
      command: 'arbitrary shell payload',
    } as VerificationToolGatewayRequestV1;

    await expect(gateway.execute(arbitraryPayload)).resolves.toMatchObject({
      authorized: false,
      code: 'request_invalid',
    });
    expect(capture).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(store.readVerificationExecutionLeaseStatus(issued.lease.leaseId)).toMatchObject({
      state: 'active',
    });
  });

  it('does not burn the lease when a fresh workspace identity has drifted', async () => {
    const store = openStore(() => '2026-08-02T12:01:00.000Z');
    const issued = store.issueVerificationExecutionLease(run());
    if (!issued.issued) throw new Error(issued.message);
    const runner = vi.fn(async () => 'ok');
    const drifted = new VerificationToolGateway({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      leaseConsumer: store,
      captureWorkspaceIdentity: async () => ({ manifestHash: 'e'.repeat(64) }),
      checkRegistry: registry(runner),
    });

    await expect(drifted.execute(request(issued))).resolves.toMatchObject({
      authorized: false,
      code: 'binding_mismatch',
    });
    expect(store.readVerificationExecutionLeaseStatus(issued.lease.leaseId)).toMatchObject({
      state: 'active',
    });
    expect(runner).not.toHaveBeenCalled();

    const current = new VerificationToolGateway({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      leaseConsumer: store,
      captureWorkspaceIdentity: async () => ({ manifestHash: 'b'.repeat(64) }),
      checkRegistry: registry(runner),
    });
    await expect(current.execute(request(issued))).resolves.toMatchObject({
      authorized: true,
      outcome: 'succeeded',
    });
  });

  it('rejects verifier and plan authority mismatches without consuming the capability', async () => {
    const store = openStore(() => '2026-08-02T12:01:00.000Z');
    const issued = store.issueVerificationExecutionLease(run());
    if (!issued.issued) throw new Error(issued.message);
    const runner = vi.fn(async () => 'ok');
    const wrongVerifier = new VerificationToolGateway({
      mode: 'enforced',
      verifierClientId: 'executor-client',
      leaseConsumer: store,
      captureWorkspaceIdentity: async () => ({ manifestHash: 'b'.repeat(64) }),
      checkRegistry: registry(runner),
    });
    const correctVerifier = new VerificationToolGateway({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      leaseConsumer: store,
      captureWorkspaceIdentity: async () => ({ manifestHash: 'b'.repeat(64) }),
      checkRegistry: registry(runner),
    });

    await expect(wrongVerifier.execute(request(issued))).resolves.toMatchObject({
      authorized: false,
      code: 'binding_mismatch',
    });
    await expect(
      correctVerifier.execute({
        ...request(issued),
        expected: { ...request(issued).expected, planFingerprint: 'f'.repeat(64) },
      }),
    ).resolves.toMatchObject({ authorized: false, code: 'binding_mismatch' });
    expect(store.readVerificationExecutionLeaseStatus(issued.lease.leaseId)).toMatchObject({
      state: 'active',
    });
    expect(runner).not.toHaveBeenCalled();

    await expect(correctVerifier.execute(request(issued))).resolves.toMatchObject({
      authorized: true,
      outcome: 'succeeded',
    });
  });

  it('rejects replay and never executes the focused check twice', async () => {
    const store = openStore(() => '2026-08-02T12:01:00.000Z');
    const issued = store.issueVerificationExecutionLease(run());
    if (!issued.issued) throw new Error(issued.message);
    const runner = vi.fn(async () => 'ok');
    const gateway = new VerificationToolGateway({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      leaseConsumer: store,
      captureWorkspaceIdentity: async () => ({ manifestHash: 'b'.repeat(64) }),
      checkRegistry: registry(runner),
    });

    await expect(gateway.execute(request(issued))).resolves.toMatchObject({ authorized: true });
    await expect(gateway.execute(request(issued))).resolves.toMatchObject({
      authorized: false,
      code: 'already_consumed',
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('keeps an unregistered canonical check inside the governed failure path', async () => {
    const store = openStore(() => '2026-08-02T12:01:00.000Z');
    const issued = store.issueVerificationExecutionLease(run());
    if (!issued.issued) throw new Error(issued.message);
    const gateway = new VerificationToolGateway({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      leaseConsumer: store,
      captureWorkspaceIdentity: async () => ({ manifestHash: 'b'.repeat(64) }),
      checkRegistry: new VerificationCheckRegistry([]),
    });

    await expect(gateway.execute(request(issued))).resolves.toMatchObject({
      route: 'governed',
      handled: true,
      authorized: true,
      outcome: 'failed',
      code: 'check_not_registered',
    });
    expect(store.readVerificationExecutionLeaseStatus(issued.lease.leaseId)).toMatchObject({
      state: 'consumed',
    });
  });

  it('reads and consumes a legacy v1 lease but refuses to dispatch it to a handler', async () => {
    const store = openStore(() => '2026-08-02T12:01:00.000Z');
    const issued = store.issueVerificationExecutionLease(legacyRun());
    if (!issued.issued) throw new Error(issued.message);
    const runner = vi.fn(async () => 'ok');
    const gateway = new VerificationToolGateway({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      leaseConsumer: store,
      captureWorkspaceIdentity: async () => ({ manifestHash: 'b'.repeat(64) }),
      checkRegistry: registry(runner),
    });

    await expect(gateway.execute(request(issued))).resolves.toMatchObject({
      route: 'governed',
      authorized: true,
      outcome: 'failed',
      code: 'check_binding_missing',
    });
    expect(store.readVerificationExecutionLeaseStatus(issued.lease.leaseId)).toMatchObject({
      state: 'consumed',
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('refuses dispatch when the current handler version drifted after lease issuance', async () => {
    const store = openStore(() => '2026-08-02T12:01:00.000Z');
    const issued = store.issueVerificationExecutionLease(run());
    if (!issued.issued) throw new Error(issued.message);
    const changedRunner = vi.fn(async () => 'changed');
    const gateway = new VerificationToolGateway({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      leaseConsumer: store,
      captureWorkspaceIdentity: async () => ({ manifestHash: 'b'.repeat(64) }),
      checkRegistry: registry(changedRunner, 'test', '1.0.1'),
    });

    await expect(gateway.execute(request(issued))).resolves.toMatchObject({
      route: 'governed',
      authorized: true,
      outcome: 'failed',
      code: 'check_binding_drifted',
    });
    expect(store.readVerificationExecutionLeaseStatus(issued.lease.leaseId)).toMatchObject({
      state: 'consumed',
    });
    expect(changedRunner).not.toHaveBeenCalled();
  });

  it('blocks expired admission before invoking the runner', async () => {
    let now = '2026-08-02T12:01:00.000Z';
    const store = openStore(() => now);
    const issued = store.issueVerificationExecutionLease(run());
    if (!issued.issued) throw new Error(issued.message);
    now = '2026-08-02T12:10:00.000Z';
    const runner = vi.fn(async () => 'ok');
    const gateway = new VerificationToolGateway({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      leaseConsumer: store,
      captureWorkspaceIdentity: async () => ({ manifestHash: 'b'.repeat(64) }),
      checkRegistry: registry(runner),
    });

    await expect(gateway.execute(request(issued))).resolves.toMatchObject({
      authorized: false,
      code: 'expired',
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('keeps the lease active when workspace capture is unavailable', async () => {
    const store = openStore(() => '2026-08-02T12:01:00.000Z');
    const issued = store.issueVerificationExecutionLease(run());
    if (!issued.issued) throw new Error(issued.message);
    const runner = vi.fn(async () => 'ok');
    const invalidGateway = new VerificationToolGateway({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      leaseConsumer: store,
      captureWorkspaceIdentity: async () => null as never,
      checkRegistry: registry(runner),
    });
    await expect(invalidGateway.execute(request(issued))).resolves.toMatchObject({
      authorized: false,
      code: 'workspace_identity_unavailable',
      message: 'Fresh workspace identity is invalid.',
    });

    const unavailableGateway = new VerificationToolGateway({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      leaseConsumer: store,
      captureWorkspaceIdentity: async () => {
        throw new Error('sensitive workspace failure');
      },
      checkRegistry: registry(runner),
    });

    await expect(unavailableGateway.execute(request(issued))).resolves.toEqual({
      route: 'governed',
      handled: true,
      authorized: false,
      code: 'workspace_identity_unavailable',
      message: 'Fresh workspace identity could not be captured.',
    });
    expect(store.readVerificationExecutionLeaseStatus(issued.lease.leaseId)).toMatchObject({
      state: 'active',
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('consumes once on runner failure and does not fall back to legacy execution', async () => {
    const store = openStore(() => '2026-08-02T12:01:00.000Z');
    const issued = store.issueVerificationExecutionLease(run());
    if (!issued.issued) throw new Error(issued.message);
    const runner = vi.fn(async () => {
      throw new Error(`secret must not escape: ${issued.credential.secret}`);
    });
    const gateway = new VerificationToolGateway({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      leaseConsumer: store,
      captureWorkspaceIdentity: async () => ({ manifestHash: 'b'.repeat(64) }),
      checkRegistry: registry(runner),
    });

    const failed = await gateway.execute(request(issued));
    expect(failed).toMatchObject({
      route: 'governed',
      authorized: true,
      outcome: 'failed',
      code: 'focused_check_failed',
    });
    expect(JSON.stringify(failed)).not.toContain(issued.credential.secret);
    await expect(gateway.execute(request(issued))).resolves.toMatchObject({
      authorized: false,
      code: 'already_consumed',
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
