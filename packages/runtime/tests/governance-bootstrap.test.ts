import { describe, expect, it, vi } from 'vitest';
import {
  type BootstrapGovernanceRuntimeOptions,
  bootstrapGovernanceRuntimeWithFactory,
} from '../src/governance-bootstrap.js';

const options: BootstrapGovernanceRuntimeOptions = {
  projectRoot: 'D:/project',
  projectId: 'project-1',
  adminClientId: 'runtime-admin',
  modelClientId: 'runtime-model',
  modelCapabilities: ['task_read', 'command_submit', 'shadow_observe'],
};

function governedRuntime(source: 'attached' | 'launched') {
  const shutdownDaemon = vi.fn(async () => ({
    ok: true as const,
    requestId: 'shutdown',
    result: {
      type: 'daemon_shutdown_accepted' as const,
      instanceId: 'instance-1',
      requestedBy: 'runtime-admin',
      reason: 'test',
    },
  }));
  const close = vi.fn(async () => ({
    ok: true as const,
    requestId: 'close',
    result: {
      type: 'capability_grant_revoked' as const,
      grantId: 'model-grant',
      revoked: true,
    },
  }));
  const model = {
    request: vi.fn(),
    snapshot: () => ({
      projectId: 'project-1',
      clientId: 'runtime-model',
      grantId: 'model-grant',
      capabilities: ['task_read', 'command_submit', 'shadow_observe'] as const,
      expiresAt: '2026-08-02T13:00:00.000Z',
    }),
  };
  return {
    runtime: {
      model,
      snapshot: () => ({
        source,
        closed: false,
        admin: {
          mode: source,
          daemon: {
            projectRoot: 'D:/project',
            projectId: 'project-1',
            pid: 42,
            instanceId: 'instance-1',
            startedAt: '2026-08-02T12:00:00.000Z',
          },
          lease: {
            state: 'idle',
            projectId: 'project-1',
            clientId: 'runtime-admin',
            grantId: 'admin-grant',
            expiresAt: '2026-08-02T13:00:00.000Z',
            rotationAttempt: 0,
          },
        },
        model: model.snapshot(),
      }),
      shutdownDaemon,
      close,
    },
    shutdownDaemon,
    close,
  };
}

describe('runtime governance bootstrap adapter', () => {
  it('keeps a launched control plane session-scoped and hides its admin runtime', async () => {
    const fake = governedRuntime('launched');
    const prepared = await bootstrapGovernanceRuntimeWithFactory(options, async () => ({
      mode: 'governed',
      runtime: fake.runtime as never,
    }));
    expect(prepared).toMatchObject({ mode: 'governed' });
    if (prepared.mode !== 'governed') return;
    expect(prepared.handle.snapshot()).toEqual({
      mode: 'governed',
      source: 'launched',
      daemon: expect.objectContaining({ instanceId: 'instance-1', pid: 42 }),
      model: expect.objectContaining({
        clientId: 'runtime-model',
        capabilities: ['task_read', 'command_submit', 'shadow_observe'],
      }),
    });
    expect(JSON.stringify(prepared.handle.snapshot())).not.toContain('credential');
    expect(prepared.handle.model).toBe(fake.runtime.model);

    await expect(prepared.handle.close()).resolves.toEqual({
      ok: true,
      action: 'shutdown',
      message: 'Governance runtime shutdown completed.',
    });
    await prepared.handle.close();
    expect(fake.shutdownDaemon).toHaveBeenCalledTimes(1);
    expect(fake.close).not.toHaveBeenCalled();
  });

  it('detaches from an existing owner without shutting it down', async () => {
    const fake = governedRuntime('attached');
    const prepared = await bootstrapGovernanceRuntimeWithFactory(options, async () => ({
      mode: 'governed',
      runtime: fake.runtime as never,
    }));
    if (prepared.mode !== 'governed') throw new Error(prepared.message);
    await expect(prepared.handle.close()).resolves.toMatchObject({ ok: true, action: 'detach' });
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.shutdownDaemon).not.toHaveBeenCalled();
  });

  it('converts factory rejection into a credential-redacted legacy result', async () => {
    await expect(
      bootstrapGovernanceRuntimeWithFactory(options, async () => {
        throw new Error('failed with wsg_grant.secret-material-that-must-not-leak');
      }),
    ).resolves.toEqual({
      mode: 'legacy',
      code: 'bootstrap_failed',
      phase: 'bootstrap',
      message: 'failed with [credential]',
      cleanup: 'unavailable',
    });
  });
});
