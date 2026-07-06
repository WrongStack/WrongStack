import { describe, expect, it, vi } from 'vitest';

/**
 * `packages/webui/src/server/boot.ts` is now a thin wrapper over the canonical
 * `bootConfig` in `@wrongstack/core`. The real boot behavior (directory
 * creation, secret migration + notice, config/sync load) is covered by core's
 * own boot.test.ts. These tests only pin the wrapper contract: it forwards the
 * `WebUI` app label, returns the WebUI-shaped result, and `patchConfig`
 * frozen-merges.
 */

const { bootConfigMock } = vi.hoisted(() => ({
  bootConfigMock: vi.fn(),
}));

vi.mock('@wrongstack/core', () => ({
  bootConfig: bootConfigMock,
  // Value imports referenced only in type positions by boot.ts — provided so
  // the module graph resolves even if the transpiler keeps the bindings.
  DefaultLogger: class {},
  DefaultSecretVault: class {},
}));

import { bootConfig, patchConfig } from '../../src/server/boot.js';

const coreResult = {
  cwd: '/tmp/test',
  projectRoot: '/tmp/test',
  userHome: '/home/testuser',
  wpaths: { globalConfig: '/home/testuser/.wrongstack/config.json' },
  pathResolver: {},
  config: { version: 1, provider: 'anthropic', model: 'anthropic-test-model', log: { level: 'info' } },
  vault: {},
  logger: { level: 'info' },
  globalConfigPath: '/home/testuser/.wrongstack/config.json',
};

describe('patchConfig', () => {
  it('returns a frozen merge', () => {
    const base = { provider: 'openai', model: 'gpt-5' } as any;
    const result = patchConfig(base, { model: 'gpt-5-mini' });
    expect(result).not.toBe(base);
    expect(result.model).toBe('gpt-5-mini');
    expect(result.provider).toBe('openai');
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe('bootConfig (webui wrapper)', () => {
  it('forwards the WebUI app label to core bootConfig', async () => {
    bootConfigMock.mockResolvedValueOnce(coreResult);
    await bootConfig();
    expect(bootConfigMock).toHaveBeenCalledWith({ appLabel: 'WebUI' });
  });

  it('returns the WebUI-shaped result', async () => {
    bootConfigMock.mockResolvedValueOnce(coreResult);
    const result = await bootConfig();
    expect(result.config.provider).toBe('anthropic');
    expect(result.globalConfigPath).toBe('/home/testuser/.wrongstack/config.json');
    expect(result.projectRoot).toBe('/tmp/test');
    expect(result.wpaths).toBe(coreResult.wpaths);
    expect(result.vault).toBe(coreResult.vault);
    expect(result.logger).toBe(coreResult.logger);
  });
});
