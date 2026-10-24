/**
 * Rotated OAuth tokens must reach the profile config from EVERY entry point,
 * including the subcommand path (`wstack acp` is a long-lived editor server).
 * A rotation that lives only in process memory leaves a dead refresh token in
 * config, and Codex/Claude reject it on the next launch.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProviderConfig } from '@wrongstack/contracts/types';
import { DefaultSecretVault } from '@wrongstack/core/security';
import type { OAuthRefreshedTokens, ProviderCredentialSource } from '@wrongstack/providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture what the CLI installs instead of reaching into the providers
// package's module state.
const installed: {
  oauth:
    | ((providerId: string, creds: OAuthRefreshedTokens, source?: ProviderCredentialSource) => void)
    | undefined;
  models:
    | ((
        providerId: string,
        models: Array<{ id: string }>,
        source?: ProviderCredentialSource,
      ) => void)
    | undefined;
} = { oauth: undefined, models: undefined };
vi.mock('@wrongstack/providers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setOAuthTokenPersister: (fn: typeof installed.oauth) => {
    installed.oauth = fn;
  },
  setProviderModelPersister: (fn: typeof installed.models) => {
    installed.models = fn;
  },
}));

const { installProviderPersisters } = await import('../src/wiring/provider-persisters.js');
const { mutateConfigProviders, resolveActiveApiKey } = await import(
  '../src/provider-config-utils.js'
);

describe('installProviderPersisters', () => {
  let dir: string;
  let configPath: string;
  let vault: DefaultSecretVault;

  const paths = () => ({ profileConfig: () => configPath });
  const readProvider = async (id = 'openai-codex'): Promise<ProviderConfig> => {
    let seen: ProviderConfig | undefined;
    await mutateConfigProviders(configPath, vault, (providers) => {
      seen = providers[id];
    });
    return seen as ProviderConfig;
  };
  const settle = () => new Promise((r) => setTimeout(r, 50));

  beforeEach(async () => {
    installed.oauth = undefined;
    installed.models = undefined;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-persisters-'));
    configPath = path.join(dir, 'settings.json');
    vault = new DefaultSecretVault({ keyFile: path.join(dir, '.vault-key') });
    await mutateConfigProviders(configPath, vault, (providers) => {
      providers['openai-codex'] = {
        activeKey: 'default',
        apiKeys: [
          { label: 'default', apiKey: 'access-old', refreshToken: 'refresh-old', createdAt: '' },
        ],
        models: ['gpt-5-codex'],
      } as ProviderConfig;
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes a rotated access + refresh token back to the active key', async () => {
    installProviderPersisters({ config: {}, paths: paths(), vault });
    expect(installed.oauth).toBeTypeOf('function');

    const expiresAt = Date.now() + 3_600_000;
    installed.oauth?.('openai-codex', {
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      expiresAt,
    });
    await settle();

    const saved = await readProvider();
    expect(resolveActiveApiKey(saved)).toBe('access-new');
    expect(saved.apiKeys?.[0]?.refreshToken).toBe('refresh-new');
    expect(saved.apiKeys?.[0]?.expiresAt).toBe(new Date(expiresAt).toISOString());
  });

  it('warns if a rotated token cannot be persisted without exposing the token', async () => {
    const warn = vi.fn();
    installProviderPersisters({ config: {}, paths: paths(), vault, logger: { warn } });
    await fs.writeFile(configPath, '{broken');
    installed.oauth?.('openai-codex', {
      accessToken: 'never-log-this-access-token',
      expiresAt: Date.now() + 60000,
    });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be saved')),
    );
    expect(warn.mock.calls[0]?.[0]).not.toContain('never-log-this-access-token');
  });

  it('keeps the stored refresh token when the provider rotates only the access token', async () => {
    installProviderPersisters({ config: {}, paths: paths(), vault });
    installed.oauth?.('openai-codex', {
      accessToken: 'copilot-token',
      expiresAt: Date.now() + 1_500_000,
    });
    await settle();

    expect((await readProvider()).apiKeys?.[0]?.refreshToken).toBe('refresh-old');
  });

  it('updates the originating key after the active key has changed', async () => {
    installProviderPersisters({ config: {}, paths: paths(), vault });
    await mutateConfigProviders(configPath, vault, (providers) => {
      const p = providers['openai-codex']!;
      p.apiKeys!.push({
        label: 'other',
        apiKey: 'other-access',
        refreshToken: 'other-refresh',
        createdAt: '',
      });
      p.activeKey = 'other';
    });
    installed.oauth?.(
      'openai-codex',
      {
        accessToken: 'rotated-origin',
        refreshToken: 'rotated-refresh',
        expiresAt: Date.now() + 60_000,
      },
      { label: 'default', accessToken: 'access-old', refreshToken: 'refresh-old' },
    );
    await settle();
    const saved = await readProvider();
    expect(saved.activeKey).toBe('other');
    expect(saved.apiKeys?.find((key) => key.label === 'default')?.apiKey).toBe('rotated-origin');
    expect(resolveActiveApiKey(saved)).toBe('other-access');
  });

  it('does not overwrite credentials replaced by a fresh login with a late refresh', async () => {
    installProviderPersisters({ config: {}, paths: paths(), vault });
    await mutateConfigProviders(configPath, vault, (providers) => {
      providers['openai-codex']!.apiKeys![0]!.apiKey = 'fresh-login';
      providers['openai-codex']!.apiKeys![0]!.refreshToken = 'fresh-refresh';
    });
    installed.oauth?.(
      'openai-codex',
      {
        accessToken: 'late-rotation',
        refreshToken: 'late-refresh',
        expiresAt: Date.now() + 60_000,
      },
      { label: 'default', accessToken: 'access-old', refreshToken: 'refresh-old' },
    );
    await settle();
    expect(resolveActiveApiKey(await readProvider())).toBe('fresh-login');
  });

  it('persists a refreshed model list only when it actually changed', async () => {
    installProviderPersisters({ config: {}, paths: paths(), vault });

    installed.models?.('openai-codex', [{ id: 'gpt-5-codex' }]);
    await settle();
    expect((await readProvider()).models).toEqual(['gpt-5-codex']);

    installed.models?.('openai-codex', [{ id: 'gpt-6-astra' }, { id: 'gpt-5-codex' }]);
    await settle();
    expect((await readProvider()).models).toEqual(['gpt-6-astra', 'gpt-5-codex']);
  });

  it('ignores a model catalog reported by credentials replaced through login', async () => {
    installProviderPersisters({ config: {}, paths: paths(), vault });
    await mutateConfigProviders(configPath, vault, (providers) => {
      providers['openai-codex']!.apiKeys![0]!.apiKey = 'fresh-login';
    });
    installed.models?.('openai-codex', [{ id: 'stale-account-model' }], {
      label: 'default',
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
    });
    await settle();
    expect((await readProvider()).models).toEqual(['gpt-5-codex']);
  });

  it('does not recreate a deleted credential when a refresh finishes late', async () => {
    installProviderPersisters({ config: {}, paths: paths(), vault });
    await mutateConfigProviders(configPath, vault, (providers) => {
      providers['openai-codex']!.apiKeys = [];
    });
    installed.oauth?.(
      'openai-codex',
      {
        accessToken: 'late-access',
        expiresAt: Date.now() + 60_000,
      },
      { label: 'default', accessToken: 'access-old', refreshToken: 'refresh-old' },
    );
    await settle();
    expect(resolveActiveApiKey(await readProvider())).toBeUndefined();
  });

  it('persists a rotation only to the addressed account alias and encrypts its tokens', async () => {
    installProviderPersisters({ config: {}, paths: paths(), vault });
    await mutateConfigProviders(configPath, vault, (providers) => {
      providers['work-codex'] = {
        type: 'openai-codex',
        family: 'openai-codex',
        activeKey: 'default',
        apiKeys: [
          { label: 'default', apiKey: 'work-old', refreshToken: 'work-refresh', createdAt: '' },
        ],
      };
    });
    installed.oauth?.(
      'work-codex',
      {
        accessToken: 'work-rotated-secret',
        refreshToken: 'work-rotated-refresh',
        expiresAt: Date.now() + 60_000,
      },
      { label: 'default', accessToken: 'work-old', refreshToken: 'work-refresh' },
    );
    await settle();
    expect(resolveActiveApiKey(await readProvider('work-codex'))).toBe('work-rotated-secret');
    expect(resolveActiveApiKey(await readProvider())).toBe('access-old');
    const raw = await fs.readFile(configPath, 'utf8');
    expect(raw).not.toContain('work-rotated-secret');
    expect(raw).not.toContain('work-rotated-refresh');
  });
});
