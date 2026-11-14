import { describe, expect, it, vi } from 'vitest';
import {
  createFallbackManageTools,
  FALLBACK_PROFILE_MANAGE_TOOL_NAME,
  PROVIDER_MANAGE_TOOL_NAME,
} from '../../src/management/fallback-manage-tools.js';

function fixture() {
  const config = {
    provider: 'primary',
    model: 'model',
    providers: { primary: { type: 'openai', models: ['model'] } },
    favoriteModels: ['primary/model'],
    fallbackProfiles: { fast: ['primary/model'] },
    favoriteModelsOnly: false,
  };
  const updateConfig = vi.fn(async (mutate: (value: Record<string, unknown>) => void) => {
    mutate(config);
  });
  const tools = createFallbackManageTools({
    getConfig: () => config as never,
    updateConfig: updateConfig as never,
    requestInput: async () => '',
  });
  const execute = (name: string, input: Record<string, unknown>) => {
    const tool = tools.find((entry) => entry.name === name)!;
    return tool.execute(input as never, {} as never, { signal: AbortSignal.timeout(5_000) });
  };
  return { execute, updateConfig, config };
}

describe('fallback configuration reserved names', () => {
  it('still creates an ordinary profile and configures an existing provider', async () => {
    const { execute, updateConfig } = fixture();
    await execute(FALLBACK_PROFILE_MANAGE_TOOL_NAME, {
      action: 'set',
      name: 'balanced',
      chain: ['primary/model'],
    });
    await execute(PROVIDER_MANAGE_TOOL_NAME, {
      action: 'configure',
      provider: 'primary',
      models: ['model'],
    });
    expect(updateConfig).toHaveBeenCalledTimes(2);
  });

  for (const name of ['__proto__', 'constructor', 'prototype']) {
    it.each(['set', 'delete'])(
      `refuses profile ${name} on %s before persisting`,
      async (action) => {
        const { execute, updateConfig } = fixture();
        await expect(
          execute(FALLBACK_PROFILE_MANAGE_TOOL_NAME, {
            action,
            name,
            chain: ['primary/model'],
          }),
        ).rejects.toThrow();
        expect(updateConfig).not.toHaveBeenCalled();
      },
    );
    it.each(['add', 'configure', 'remove'])(
      `refuses provider ${name} on %s before persisting`,
      async (action) => {
        const { execute, updateConfig } = fixture();
        await expect(
          execute(PROVIDER_MANAGE_TOOL_NAME, {
            action,
            provider: name,
            type: 'openai',
            models: ['model'],
          }),
        ).rejects.toThrow();
        expect(updateConfig).not.toHaveBeenCalled();
      },
    );
  }
});
