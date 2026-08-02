import { describe, expect, it, vi } from 'vitest';
import {
  setupWebUiGovernance,
  webUiGovernanceRuntimeEnabled,
} from '../src/server/governance-runtime.js';

function input(environment: Readonly<Record<string, string | undefined>>) {
  return {
    environment,
    projectRoot: '/project',
    projectId: 'project-1',
    sessionId: 'session-1',
    contextMeta: {} as Record<string, unknown>,
    events: {} as never,
    logger: { info: vi.fn(), warn: vi.fn() },
    captureWorkspaceCheckpoint: vi.fn(async () => undefined),
  };
}

describe('standalone WebUI governance runtime', () => {
  it('remains disabled unless the compatibility flag is exactly enabled', async () => {
    const load = vi.fn();
    const disabledInput = input({ WRONGSTACK_GOVERNANCE: 'true' });

    expect(webUiGovernanceRuntimeEnabled(disabledInput.environment)).toBe(false);
    await expect(
      setupWebUiGovernance(disabledInput, {
        load,
        createMutationBridge: vi.fn(),
      }),
    ).resolves.toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    expect(disabledInput.contextMeta).toEqual({});
  });

  it('attaches one host boundary and drains it before runtime shutdown', async () => {
    const runtimeClose = vi.fn(async () => ({
      ok: true,
      action: 'shutdown' as const,
      message: 'closed',
    }));
    const snapshot = {
      mode: 'governed' as const,
      source: 'launched' as const,
      daemon: {},
      model: {},
    };
    const bootstrapGovernanceRuntime = vi.fn(async () => ({
      mode: 'governed' as const,
      handle: {
        snapshot: () => snapshot,
        recordWorkspaceSnapshot: vi.fn(),
        close: runtimeClose,
      },
    }));
    const installToolBoundary = vi.fn();
    const bridgeClose = vi.fn(async () => undefined);
    const createMutationBridge = vi.fn(() => ({
      installToolBoundary,
      close: bridgeClose,
    }));
    const governedInput = input({ WRONGSTACK_GOVERNANCE: '1' });

    const handle = await setupWebUiGovernance(governedInput, {
      load: async () => ({ bootstrapGovernanceRuntime: bootstrapGovernanceRuntime as never }),
      createMutationBridge: createMutationBridge as never,
    });

    expect(bootstrapGovernanceRuntime).toHaveBeenCalledWith({
      projectRoot: '/project',
      projectId: 'project-1',
      adminClientId: expect.stringMatching(/^webui-control-\d+-session-1$/u),
      modelClientId: 'webui-model-session-1',
      modelCapabilities: ['task_read', 'command_submit', 'shadow_observe'],
    });
    expect(governedInput.contextMeta['governance']).toBe(snapshot);
    expect(createMutationBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        events: governedInput.events,
        captureWorkspaceCheckpoint: governedInput.captureWorkspaceCheckpoint,
      }),
    );

    const pipelines = {} as never;
    handle?.installToolBoundary(pipelines);
    expect(installToolBoundary).toHaveBeenCalledWith(pipelines);
    await expect(handle?.close()).resolves.toEqual({
      ok: true,
      action: 'shutdown',
      message: 'closed',
    });
    expect(bridgeClose).toHaveBeenCalledBefore(runtimeClose);
  });

  it('falls back without installing a boundary when another owner cannot be authenticated', async () => {
    const legacyInput = input({ WRONGSTACK_GOVERNANCE: '1' });
    const createMutationBridge = vi.fn();
    const result = {
      mode: 'legacy' as const,
      code: 'existing_owner_requires_credential' as const,
      phase: 'attach' as const,
      message: 'An authenticated owner already exists.',
      cleanup: 'not_required' as const,
    };

    await expect(
      setupWebUiGovernance(legacyInput, {
        load: async () => ({ bootstrapGovernanceRuntime: vi.fn(async () => result) }),
        createMutationBridge,
      }),
    ).resolves.toBeUndefined();

    expect(legacyInput.contextMeta['governance']).toBe(result);
    expect(createMutationBridge).not.toHaveBeenCalled();
    expect(legacyInput.logger.warn).toHaveBeenCalledWith(
      'governance: standalone WebUI legacy fallback (existing_owner_requires_credential)',
      expect.objectContaining({ phase: 'attach' }),
    );
  });
});
