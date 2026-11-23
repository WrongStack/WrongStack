import type { ProviderConfig } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createProviderCrudHandlers } from '../src/server/provider/keys.js';
import type { ProviderServiceContext } from '../src/server/provider/mutations.js';

/**
 * VULN-006, credential-theft half: `validateProviderBaseUrl`'s docblock says the
 * `envVars: []` sentinel stops the resolver from re-arming the old credential
 * for a new endpoint. `provider_manage` applies it; the WebUI
 * `handleProviderUpdate` path validated the URL but kept the saved
 * `envVars`/`apiKey`/`apiKeys`/`activeKey`, so a baseUrl change kept feeding the
 * previous secret to the new host.
 */
function createFixture(initial: ProviderConfig): {
  ctx: ProviderServiceContext;
  providers: Record<string, ProviderConfig>;
  results: Array<{ ok: boolean; message: string }>;
  saved: () => Record<string, ProviderConfig> | undefined;
} {
  const providers: Record<string, ProviderConfig> = { anthropic: structuredClone(initial) };
  const results: Array<{ ok: boolean; message: string }> = [];
  let saved: Record<string, ProviderConfig> | undefined;
  const ctx: ProviderServiceContext = {
    deps: {
      providerStore: {
        load: vi.fn(async () => providers),
        save: vi.fn(async (next: Record<string, ProviderConfig>) => {
          saved = structuredClone(next);
        }),
      },
      broadcast: vi.fn(),
      log: vi.fn(),
    },
    sendMessage: vi.fn(),
    sendOperationResult: vi.fn((_ws, ok: boolean, message: string) => {
      results.push({ ok, message });
    }),
    loadConfigProviders: vi.fn(async () => providers),
    saveConfigProviders: vi.fn(async (next: Record<string, ProviderConfig>) => {
      saved = structuredClone(next);
    }),
    broadcastSaved: vi.fn(),
  };
  return { ctx, providers, results, saved: () => saved };
}

const BASE: ProviderConfig = {
  type: 'anthropic',
  family: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  envVars: ['ANTHROPIC_API_KEY'],
  apiKey: 'old-key',
  apiKeys: [{ apiKey: 'old-key', label: 'primary' }],
  activeKey: 'primary',
  models: ['claude-x'],
} as ProviderConfig;

const ws = {} as WebSocket;

describe('provider.update endpoint-change credential sentinel (VULN-006)', () => {
  it('disarms the previous credential when baseUrl changes', async () => {
    const fixture = createFixture(BASE);
    const handlers = createProviderCrudHandlers(fixture.ctx);
    await handlers.handleProviderUpdate(ws, {
      id: 'anthropic',
      baseUrl: 'https://gateway.example.net',
    });
    expect(fixture.results.at(-1)?.ok).toBe(true);
    const entry = fixture.saved()?.['anthropic'];
    expect(entry?.baseUrl).toBe('https://gateway.example.net');
    // Present-but-empty suppresses the catalog/env fallback for the new host.
    expect(entry?.envVars).toEqual([]);
    expect(entry?.apiKey).toBeUndefined();
    expect(entry?.apiKeys).toBeUndefined();
    expect(entry?.activeKey).toBeUndefined();
  });

  it('keeps the credential for an update that does not change the endpoint', async () => {
    const fixture = createFixture(BASE);
    const handlers = createProviderCrudHandlers(fixture.ctx);
    await handlers.handleProviderUpdate(ws, { id: 'anthropic', models: ['claude-y'] });
    const entry = fixture.saved()?.['anthropic'];
    expect(entry?.envVars).toEqual(['ANTHROPIC_API_KEY']);
    expect(entry?.apiKey).toBe('old-key');
  });

  it('honors envVars the caller supplies together with the new endpoint', async () => {
    const fixture = createFixture(BASE);
    const handlers = createProviderCrudHandlers(fixture.ctx);
    await handlers.handleProviderUpdate(ws, {
      id: 'anthropic',
      baseUrl: 'https://gateway.example.net',
      envVars: ['OTHER_KEY'],
    });
    expect(fixture.saved()?.['anthropic']?.envVars).toEqual(['OTHER_KEY']);
  });

  it('clears the selectors on a reset so the vendor credential can re-arm', async () => {
    const fixture = createFixture(BASE);
    const handlers = createProviderCrudHandlers(fixture.ctx);
    await handlers.handleProviderUpdate(ws, { id: 'anthropic', baseUrl: '' });
    const entry = fixture.saved()?.['anthropic'];
    // No sentinel for the vendor default: envVars is absent (not []), so the
    // catalog/env preset applies again.
    expect(entry?.envVars).toBeUndefined();
    expect(entry?.apiKey).toBeUndefined();
  });

  it('refuses a metadata endpoint and persists nothing', async () => {
    const fixture = createFixture(BASE);
    const handlers = createProviderCrudHandlers(fixture.ctx);
    await handlers.handleProviderUpdate(ws, {
      id: 'anthropic',
      baseUrl: 'http://169.254.169.254/latest/meta-data/',
    });
    expect(fixture.results.at(-1)?.ok).toBe(false);
    expect(fixture.saved()).toBeUndefined();
    expect(fixture.providers['anthropic']?.baseUrl).toBe('https://api.anthropic.com');
  });
});
