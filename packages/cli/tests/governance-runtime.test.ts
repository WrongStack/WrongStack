import { describe, expect, it, vi } from 'vitest';
import {
  bootstrapCliGovernance,
  governanceRuntimeEnabled,
  governedHandle,
} from '../src/boot/governance-runtime.js';

const options = {
  environment: { WRONGSTACK_GOVERNANCE: '1' },
  projectRoot: 'D:/project',
  projectId: 'project-1',
  adminClientId: 'cli-admin',
  modelClientId: 'cli-model',
  modelCapabilities: ['task_read', 'command_submit', 'shadow_observe'] as const,
};

describe('CLI governance runtime feature boundary', () => {
  it('does not load the governance runtime while the feature flag is off', async () => {
    const load = vi.fn(async () => {
      throw new Error('must not load');
    });
    await expect(
      bootstrapCliGovernance({ ...options, environment: {} }, { load }),
    ).resolves.toEqual({ mode: 'disabled', reason: 'feature_flag_off' });
    expect(load).not.toHaveBeenCalled();
    expect(governanceRuntimeEnabled({ WRONGSTACK_GOVERNANCE: 'true' })).toBe(false);
    expect(governanceRuntimeEnabled({ WRONGSTACK_GOVERNANCE: '1' })).toBe(true);
  });

  it('dynamically delegates enabled startup without exposing the handle in fallback state', async () => {
    const bootstrapGovernanceRuntime = vi.fn(async () => ({
      mode: 'legacy' as const,
      code: 'existing_owner_requires_credential' as const,
      phase: 'inspect' as const,
      message: 'explicit credential required',
      cleanup: 'not_required' as const,
    }));
    const result = await bootstrapCliGovernance(options, {
      load: async () => ({ bootstrapGovernanceRuntime }),
    });
    expect(result).toMatchObject({
      mode: 'legacy',
      code: 'existing_owner_requires_credential',
    });
    expect(governedHandle(result)).toBeUndefined();
    expect(bootstrapGovernanceRuntime).toHaveBeenCalledWith({
      projectRoot: 'D:/project',
      projectId: 'project-1',
      adminClientId: 'cli-admin',
      modelClientId: 'cli-model',
      modelCapabilities: ['task_read', 'command_submit', 'shadow_observe'],
    });
  });

  it('fails open to legacy when the optional runtime chunk cannot load', async () => {
    const result = await bootstrapCliGovernance(options, {
      load: async () => {
        throw new Error('missing wsg_grant.secret-material-that-must-not-leak');
      },
    });
    expect(result).toEqual({
      mode: 'legacy',
      code: 'module_unavailable',
      phase: 'bootstrap',
      message: 'missing [credential]',
      cleanup: 'not_required',
    });
  });

  it('fails open when the loaded bootstrap function rejects unexpectedly', async () => {
    const result = await bootstrapCliGovernance(options, {
      load: async () => ({
        bootstrapGovernanceRuntime: async () => {
          throw new Error('unexpected bootstrap rejection');
        },
      }),
    });
    expect(result).toEqual({
      mode: 'legacy',
      code: 'bootstrap_failed',
      phase: 'bootstrap',
      message: 'unexpected bootstrap rejection',
      cleanup: 'unavailable',
    });
  });
});
