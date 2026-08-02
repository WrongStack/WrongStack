import { describe, expect, it, vi } from 'vitest';
import {
  calculateVerificationRunId,
  MAX_VERIFICATION_CHECK_REGISTRATIONS,
  type VerificationCheckBindingV1,
  VerificationCheckRegistry,
  VerificationCheckRegistryConfigurationError,
  type VerificationExecutionLeaseConsumption,
  type VerificationRunContractV2,
} from '../src/index.js';

function run(
  checkBinding: VerificationCheckBindingV1,
  overrides: Partial<Omit<VerificationRunContractV2, 'runId' | 'checkBinding'>> = {},
): VerificationRunContractV2 {
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
    checkBinding,
    ...overrides,
  };
  return { ...contract, runId: calculateVerificationRunId(contract) };
}

function consumption(contract: VerificationRunContractV2): VerificationExecutionLeaseConsumption {
  return {
    leaseId: 'lease-1',
    runId: contract.runId,
    verifierClientId: contract.verifierClientId,
    consumedAt: '2026-08-02T12:01:00.000Z',
    bindingHash: 'e'.repeat(64),
  };
}

function bindingFor<Result>(
  registry: VerificationCheckRegistry<Result>,
  checkId: string,
  evidenceKind: 'test' | 'lint',
): VerificationCheckBindingV1 {
  const resolved = registry.bindingFor(checkId, evidenceKind);
  if (!resolved.bound) throw new Error(resolved.message);
  return resolved.binding;
}

describe('verification check registry', () => {
  it('lists immutable descriptors deterministically and hides handler functions', async () => {
    const testRunner = vi.fn(async () => ({ status: 'passed' as const }));
    const lintRunner = vi.fn(async () => ({ status: 'passed' as const }));
    const registry = new VerificationCheckRegistry([
      {
        id: 'check-test',
        evidenceKind: 'test',
        handlerVersion: '1.0.0',
        executionClass: 'trusted_deterministic',
        run: testRunner,
      },
      {
        id: 'check-lint',
        evidenceKind: 'lint',
        handlerVersion: '2.0.0',
        executionClass: 'trusted_deterministic',
        run: lintRunner,
      },
    ]);

    const descriptors = registry.list();
    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(['check-lint', 'check-test']);
    expect(Object.isFrozen(descriptors)).toBe(true);
    expect(descriptors.every(Object.isFrozen)).toBe(true);
    expect(descriptors[0]).not.toHaveProperty('run');

    const contract = run(bindingFor(registry, 'check-test', 'test'));
    await expect(
      registry.execute({
        run: contract,
        consumption: consumption(contract),
        workspaceManifestHash: contract.workspaceManifestHash,
      }),
    ).resolves.toMatchObject({
      executed: true,
      descriptor: { id: 'check-test', evidenceKind: 'test', handlerVersion: '1.0.0' },
      result: { status: 'passed' },
    });
    expect(testRunner).toHaveBeenCalledTimes(1);
    expect(lintRunner).not.toHaveBeenCalled();
  });

  it('fails construction on duplicate, non-canonical, and unbounded registrations', () => {
    const registration = {
      id: 'check-test',
      evidenceKind: 'test' as const,
      handlerVersion: '1.0.0',
      executionClass: 'trusted_deterministic' as const,
      run: async () => 'ok',
    };

    expect(() => new VerificationCheckRegistry([registration, registration])).toThrow(
      VerificationCheckRegistryConfigurationError,
    );
    expect(() => new VerificationCheckRegistry([{ ...registration, id: ' Check Test ' }])).toThrow(
      /invalid canonical id/,
    );
    expect(
      () =>
        new VerificationCheckRegistry(
          Array.from({ length: MAX_VERIFICATION_CHECK_REGISTRATIONS + 1 }, (_, index) => ({
            ...registration,
            id: `check-${index}`,
          })),
        ),
    ).toThrow(/exceeds/);
  });

  it('rejects unknown exact ids without selecting a similar handler', async () => {
    const runner = vi.fn(async () => 'ok');
    const registry = new VerificationCheckRegistry([
      {
        id: 'check-test',
        evidenceKind: 'test',
        handlerVersion: '1',
        executionClass: 'trusted_deterministic',
        run: runner,
      },
    ]);
    const authorizingRegistry = new VerificationCheckRegistry([
      {
        id: 'check-tests',
        evidenceKind: 'test',
        handlerVersion: '1',
        executionClass: 'trusted_deterministic',
        run: async () => 'ok',
      },
    ]);
    const contract = run(bindingFor(authorizingRegistry, 'check-tests', 'test'), {
      requiredCheckId: 'check-tests',
    });

    await expect(
      registry.execute({
        run: contract,
        consumption: consumption(contract),
        workspaceManifestHash: contract.workspaceManifestHash,
      }),
    ).resolves.toMatchObject({ executed: false, code: 'check_not_registered' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects evidence-kind mismatches before invoking a handler', async () => {
    const runner = vi.fn(async () => 'ok');
    const registry = new VerificationCheckRegistry([
      {
        id: 'check-test',
        evidenceKind: 'lint',
        handlerVersion: '1',
        executionClass: 'trusted_deterministic',
        run: runner,
      },
    ]);
    const authorizingRegistry = new VerificationCheckRegistry([
      {
        id: 'check-test',
        evidenceKind: 'test',
        handlerVersion: '1',
        executionClass: 'trusted_deterministic',
        run: async () => 'ok',
      },
    ]);
    const contract = run(bindingFor(authorizingRegistry, 'check-test', 'test'));

    await expect(
      registry.execute({
        run: contract,
        consumption: consumption(contract),
        workspaceManifestHash: contract.workspaceManifestHash,
      }),
    ).resolves.toMatchObject({ executed: false, code: 'evidence_kind_mismatch' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('revalidates run, consumption, and workspace integrity at the handler boundary', async () => {
    const runner = vi.fn(async () => 'ok');
    const registry = new VerificationCheckRegistry([
      {
        id: 'check-test',
        evidenceKind: 'test',
        handlerVersion: '1',
        executionClass: 'trusted_deterministic',
        run: runner,
      },
    ]);
    const contract = run(bindingFor(registry, 'check-test', 'test'));

    await expect(
      registry.execute({
        run: contract,
        consumption: { ...consumption(contract), verifierClientId: 'executor-client' },
        workspaceManifestHash: contract.workspaceManifestHash,
      }),
    ).resolves.toMatchObject({ executed: false, code: 'execution_context_invalid' });
    await expect(
      registry.execute({
        run: contract,
        consumption: consumption(contract),
        workspaceManifestHash: 'f'.repeat(64),
      }),
    ).resolves.toMatchObject({ executed: false, code: 'execution_context_invalid' });
    expect(runner).not.toHaveBeenCalled();
  });
});
