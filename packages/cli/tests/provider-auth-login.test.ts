import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProviderAuthRegistry } from '@wrongstack/core/registry';
import { DefaultSecretVault } from '@wrongstack/core/security';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProviderAuthLogin } from '../src/auth-menu/provider-auth-login.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('runProviderAuthLogin', () => {
  it('drives a registry strategy and persists its credential through the vault', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-provider-auth-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, '{}', { mode: 0o600 });
    const registry = new ProviderAuthRegistry();
    const completeWithCode = vi.fn(async () => ({
      providerId: 'company',
      family: 'openai-compatible' as const,
      baseUrl: 'https://company.test/v1',
      models: ['company-model'],
      credential: {
        label: 'oauth-default',
        apiKey: 'super-secret-token',
        createdAt: '2026-09-08T00:00:00.000Z',
        authMethod: 'oauth' as const,
      },
    }));
    const close = vi.fn();
    registry.register({
      id: 'company-sso',
      providerId: 'company',
      label: 'Company SSO',
      aliases: ['corp'],
      interactionTypes: ['browser'],
      begin: async () => ({
        strategyId: 'company-sso',
        providerId: 'company',
        interaction: {
          type: 'browser',
          authorizeUrl: 'https://company.test/authorize',
          bound: false,
        },
        waitForCompletion: async () => null,
        completeWithCode,
        close,
      }),
    });

    const result = await runProviderAuthLogin(
      {
        renderer: {
          write: vi.fn(),
          writeInfo: vi.fn(),
          writeWarning: vi.fn(),
          writeError: vi.fn(),
        },
        reader: {
          readLine: vi.fn(async () => 'callback-code'),
          readSecret: vi.fn(),
        },
        modelsRegistry: {} as never,
        vault: new DefaultSecretVault({ keyFile: path.join(dir, '.key') }),
        profileConfigPath: configPath,
        providerAuthRegistry: registry,
      },
      'corp',
    );

    expect(result).toBe(0);
    expect(completeWithCode).toHaveBeenCalledWith('callback-code', expect.any(AbortSignal));
    expect(close).toHaveBeenCalledOnce();
    const raw = await fs.readFile(configPath, 'utf8');
    expect(raw).not.toContain('super-secret-token');
    expect(JSON.parse(raw).providers.company).toMatchObject({
      family: 'openai-compatible',
      baseUrl: 'https://company.test/v1',
      models: ['company-model'],
      activeKey: 'oauth-default',
    });
  });
});
