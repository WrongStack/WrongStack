import { describe, expect, it, vi } from 'vitest';
import {
  type BootstrapGovernanceRuntimeOptions,
  bootstrapGovernanceRuntimeWithFactory,
  MAX_PENDING_GOVERNANCE_OBSERVATIONS,
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

function observationResponse(request: unknown) {
  const record = request as {
    requestId: string;
    observation: {
      observationId: string;
      projectId: string;
      taskId: string | null;
      source: string;
      category: 'tool_invoked';
      observedAt: string;
      payload: Readonly<Record<string, unknown>>;
    };
  };
  return {
    ok: true as const,
    requestId: record.requestId,
    result: {
      type: 'observation_result' as const,
      result: {
        handled: true as const,
        idempotentReplay: false,
        observation: {
          ...record.observation,
          sequence: 7,
          recordedAt: '2026-08-02T12:00:01.000Z',
        },
      },
    },
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

  it('binds shadow observations to the runtime project without exposing raw authority', async () => {
    const fake = governedRuntime('attached');
    fake.runtime.model.request.mockImplementation(async (request) => observationResponse(request));
    const prepared = await bootstrapGovernanceRuntimeWithFactory(options, async () => ({
      mode: 'governed',
      runtime: fake.runtime as never,
    }));
    if (prepared.mode !== 'governed') throw new Error(prepared.message);

    await expect(
      prepared.handle.observe({
        taskId: 'task-1',
        category: 'tool_invoked',
        observedAt: '2026-08-02T12:00:00.000Z',
        payload: { phase: 'completed', toolName: 'read' },
      }),
    ).resolves.toMatchObject({ recorded: true, idempotentReplay: false, sequence: 7 });
    expect(fake.runtime.model.request).toHaveBeenCalledWith({
      protocolVersion: 1,
      requestId: expect.stringMatching(/^observe-/u),
      type: 'record_observation',
      observation: {
        observationId: expect.any(String),
        projectId: 'project-1',
        taskId: 'task-1',
        source: 'runtime-model',
        category: 'tool_invoked',
        observedAt: '2026-08-02T12:00:00.000Z',
        payload: { phase: 'completed', toolName: 'read' },
      },
    });
  });

  it('drains pending observations before revoking the session grant', async () => {
    const fake = governedRuntime('attached');
    let resolveRequest: ((value: ReturnType<typeof observationResponse>) => void) | undefined;
    fake.runtime.model.request.mockImplementation(
      (request) =>
        new Promise((resolve) => {
          resolveRequest = () => resolve(observationResponse(request));
        }),
    );
    const prepared = await bootstrapGovernanceRuntimeWithFactory(options, async () => ({
      mode: 'governed',
      runtime: fake.runtime as never,
    }));
    if (prepared.mode !== 'governed') throw new Error(prepared.message);

    const observation = prepared.handle.observe({
      taskId: null,
      category: 'tool_invoked',
      observedAt: '2026-08-02T12:00:00.000Z',
      payload: { phase: 'started', toolName: 'shell' },
    });
    const closing = prepared.handle.close();
    await Promise.resolve();
    expect(fake.close).not.toHaveBeenCalled();
    resolveRequest?.(observationResponse(fake.runtime.model.request.mock.calls[0]?.[0]));

    await expect(observation).resolves.toMatchObject({ recorded: true });
    await expect(closing).resolves.toMatchObject({ ok: true, action: 'detach' });
    expect(fake.close).toHaveBeenCalledTimes(1);
    await expect(
      prepared.handle.observe({
        taskId: null,
        category: 'status_changed',
        observedAt: '2026-08-02T12:00:02.000Z',
        payload: { phase: 'late' },
      }),
    ).resolves.toMatchObject({ recorded: false, code: 'closed' });
  });

  it('bounds the fail-open observation queue while the daemon is slow', async () => {
    const fake = governedRuntime('attached');
    const releases: Array<() => void> = [];
    fake.runtime.model.request.mockImplementation(
      (request) =>
        new Promise((resolve) => {
          releases.push(() => resolve(observationResponse(request)));
        }),
    );
    const prepared = await bootstrapGovernanceRuntimeWithFactory(options, async () => ({
      mode: 'governed',
      runtime: fake.runtime as never,
    }));
    if (prepared.mode !== 'governed') throw new Error(prepared.message);
    const input = {
      taskId: null,
      category: 'tool_invoked' as const,
      observedAt: '2026-08-02T12:00:00.000Z',
      payload: { phase: 'started', toolName: 'read' },
    };

    const pending = Array.from({ length: MAX_PENDING_GOVERNANCE_OBSERVATIONS }, () =>
      prepared.handle.observe(input),
    );
    await expect(prepared.handle.observe(input)).resolves.toMatchObject({
      recorded: false,
      code: 'backpressure',
    });
    expect(fake.runtime.model.request).toHaveBeenCalledTimes(MAX_PENDING_GOVERNANCE_OBSERVATIONS);
    for (const release of releases) release();
    await expect(Promise.all(pending)).resolves.toHaveLength(MAX_PENDING_GOVERNANCE_OBSERVATIONS);
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
