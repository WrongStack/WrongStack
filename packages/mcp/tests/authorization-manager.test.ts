import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSecretVault } from '@wrongstack/core/security';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPAuthorizationManager } from '../src/authorization-manager.js';
import type { MCPClientRegistrationOptions } from '../src/authorization-registration.js';
import { MCPVaultTokenStore } from '../src/token-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('MCPAuthorizationManager', () => {
  it('rejects invalid pending TTL values', async () => {
    const fixture = await createFixture();

    expect(() => new MCPAuthorizationManager({ store: fixture.store, pendingTtlMs: 0 })).toThrow(
      /positive finite/,
    );
    expect(
      () =>
        new MCPAuthorizationManager({
          store: fixture.store,
          pendingTtlMs: Number.POSITIVE_INFINITY,
        }),
    ).toThrow(/positive finite/);
  });

  it('keeps PKCE state in memory, completes once, and exposes only safe status', async () => {
    const fixture = await createFixture();
    const resource = 'https://mcp.example.com/team';
    const exchange = vi.fn(async (input) => {
      expect(input).toMatchObject({
        clientId: 'wrongstack-client',
        resource,
        code: 'one-time-code',
      });
      expect(input.codeVerifier).toHaveLength(43);
      return {
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        tokenType: 'Bearer',
        resource,
        expiresAt: Date.now() + 3_600_000,
        scopes: ['tools:read'],
      };
    });
    const manager = new MCPAuthorizationManager({
      store: fixture.store,
      discover: async () => discovery(resource),
      exchange,
    });

    const started = await manager.begin({
      serverName: 'remote',
      resource,
      clientId: 'wrongstack-client',
      redirectUri: 'http://127.0.0.1:43123/callback',
      scopes: ['tools:read'],
    });
    const authorizationUrl = new URL(started.authorizationUrl);
    const state = authorizationUrl.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(started).not.toHaveProperty('codeVerifier');
    expect(started).not.toHaveProperty('state');
    await expect(manager.status('remote', resource)).resolves.toMatchObject({
      state: 'pending',
      scopes: ['tools:read'],
    });

    await expect(
      manager.complete({
        serverName: 'remote',
        resource,
        callbackUrl: 'http://127.0.0.1:43123/callback?code=one-time-code&state=wrong',
      }),
    ).rejects.toThrow(/state mismatch/);
    const completed = await manager.complete({
      serverName: 'remote',
      resource,
      callbackUrl: `http://127.0.0.1:43123/callback?code=one-time-code&state=${state}`,
    });

    expect(exchange).toHaveBeenCalledOnce();
    expect(completed).toMatchObject({
      state: 'authorized',
      scopes: ['tools:read'],
      canRefresh: true,
    });
    expect(completed).not.toHaveProperty('accessToken');
    expect(completed).not.toHaveProperty('refreshToken');
    await expect(
      manager.complete({
        serverName: 'remote',
        resource,
        callbackUrl: `http://127.0.0.1:43123/callback?code=one-time-code&state=${state}`,
      }),
    ).rejects.toThrow(/No live/);

    const raw = await fs.readFile(fixture.storePath, 'utf8');
    expect(raw).not.toContain('access-secret');
    expect(raw).not.toContain('refresh-secret');
    await expect(manager.disconnect('remote', resource)).resolves.toBe(true);
    await expect(manager.status('remote', resource)).resolves.toMatchObject({
      state: 'not_authorized',
    });
  });

  it('expires pending sessions and derives scopes from a Bearer challenge', async () => {
    const fixture = await createFixture();
    const resource = 'https://mcp.example.com/mcp';
    let now = 1_000;
    const manager = new MCPAuthorizationManager({
      store: fixture.store,
      pendingTtlMs: 100,
      now: () => now,
      discover: async () => discovery(resource),
    });
    await manager.begin({
      serverName: 'remote',
      resource,
      clientId: 'client',
      redirectUri: 'http://127.0.0.1:43123/callback',
      challengeHeader: 'Bearer scope="tools:read prompts:read"',
    });
    await expect(manager.status('remote', resource)).resolves.toMatchObject({
      state: 'pending',
      scopes: ['tools:read', 'prompts:read'],
      expiresAt: 1_100,
    });

    now = 1_101;
    await expect(manager.status('remote', resource)).resolves.toMatchObject({
      state: 'not_authorized',
    });
  });

  it('bounds pending sessions while allowing an existing session to restart', async () => {
    const fixture = await createFixture();
    const resource = 'https://mcp.example.com/mcp';
    const manager = new MCPAuthorizationManager({
      store: fixture.store,
      discover: async () => discovery(resource),
    });
    const input = {
      resource,
      clientId: 'client',
      redirectUri: 'http://127.0.0.1:43123/callback',
    };

    for (let index = 0; index < 32; index++) {
      await manager.begin({ ...input, serverName: `remote-${index}` });
    }
    await expect(manager.begin({ ...input, serverName: 'remote-0' })).resolves.toMatchObject({
      serverName: 'remote-0',
    });
    await expect(manager.begin({ ...input, serverName: 'overflow' })).rejects.toThrow(
      /Too many pending/,
    );
  });

  it('reserves capacity during concurrent discovery and rejects duplicate starts', async () => {
    const fixture = await createFixture();
    const resource = 'https://mcp.example.com/mcp';
    const discoveries: Array<() => void> = [];
    const manager = new MCPAuthorizationManager({
      store: fixture.store,
      discover: () =>
        new Promise((resolve) => {
          discoveries.push(() => resolve(discovery(resource)));
        }),
    });
    const input = {
      resource,
      clientId: 'client',
      redirectUri: 'http://127.0.0.1:43123/callback',
    };

    const starts = Array.from({ length: 32 }, (_, index) =>
      manager.begin({ ...input, serverName: `remote-${index}` }),
    );
    await expect(manager.begin({ ...input, serverName: 'overflow' })).rejects.toThrow(
      /Too many pending/,
    );
    await expect(manager.begin({ ...input, serverName: 'remote-0' })).rejects.toThrow(
      /already in progress/,
    );

    for (const resolve of discoveries) resolve();
    await expect(Promise.all(starts)).resolves.toHaveLength(32);
  });

  it('does not resurrect an authorization start cancelled by disconnect', async () => {
    const fixture = await createFixture();
    const resource = 'https://mcp.example.com/mcp';
    let finishDiscovery: (() => void) | undefined;
    const manager = new MCPAuthorizationManager({
      store: fixture.store,
      discover: () =>
        new Promise((resolve) => {
          finishDiscovery = () => resolve(discovery(resource));
        }),
    });

    const started = manager.begin({
      serverName: 'remote',
      resource,
      clientId: 'client',
      redirectUri: 'http://127.0.0.1:43123/callback',
    });
    await vi.waitFor(() => expect(finishDiscovery).toBeTypeOf('function'));
    await expect(manager.disconnect('remote', resource)).resolves.toBe(false);
    finishDiscovery?.();

    await expect(started).rejects.toThrow(/discovery was cancelled/);
    await expect(manager.status('remote', resource)).resolves.toMatchObject({
      state: 'not_authorized',
    });
  });

  it('validates server names and reports a no-op disconnect', async () => {
    const fixture = await createFixture();
    const onStateChange = vi.fn();
    const manager = new MCPAuthorizationManager({ store: fixture.store, onStateChange });

    await expect(manager.status('', 'https://mcp.example.com')).rejects.toThrow(
      /server name is invalid/,
    );
    await expect(manager.status('x'.repeat(257), 'https://mcp.example.com')).rejects.toThrow(
      /server name is invalid/,
    );
    await expect(manager.status('bad\nname', 'https://mcp.example.com')).rejects.toThrow(
      /server name is invalid/,
    );
    await expect(manager.disconnect('missing', 'https://mcp.example.com')).resolves.toBe(false);
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('reports expired and non-expiring stored credentials', async () => {
    const fixture = await createFixture();
    const resource = 'https://mcp.example.com/mcp';
    const manager = new MCPAuthorizationManager({
      store: fixture.store,
      now: () => 1_000,
    });
    const stored = {
      serverName: 'remote',
      resource,
      clientId: 'client',
      authorizationServer: discovery(resource).authorizationServer,
      updatedAt: new Date(0).toISOString(),
    };

    await fixture.store.save({
      ...stored,
      tokenSet: {
        accessToken: 'expired',
        tokenType: 'Bearer',
        resource,
        expiresAt: 999,
      },
    });
    await expect(manager.status('remote', resource)).resolves.toMatchObject({
      state: 'expired',
      scopes: [],
      canRefresh: false,
    });

    await fixture.store.save({
      ...stored,
      tokenSet: {
        accessToken: 'non-expiring',
        tokenType: 'Bearer',
        resource,
      },
    });
    await expect(manager.status('remote', resource)).resolves.toMatchObject({
      state: 'authorized',
      scopes: [],
      canRefresh: false,
    });
  });

  it('normalizes missing token scopes from a host store and state event', async () => {
    const resource = 'https://mcp.example.com/mcp';
    const stored = {
      serverName: 'remote',
      resource,
      clientId: 'client',
      authorizationServer: discovery(resource).authorizationServer,
      tokenSet: {
        accessToken: 'token',
        tokenType: 'Bearer',
        resource,
      },
      updatedAt: new Date(0).toISOString(),
    };
    const store = {
      load: vi.fn(async () => stored),
      save: vi.fn(),
      remove: vi.fn(),
    } as unknown as MCPVaultTokenStore;
    const onStateChange = vi.fn();
    const manager = new MCPAuthorizationManager({ store, onStateChange });

    await expect(manager.status('remote', resource)).resolves.toMatchObject({ scopes: [] });
    (
      manager as never as {
        emit: (state: 'authorized', value: typeof stored) => void;
      }
    ).emit('authorized', stored);
    expect(onStateChange).toHaveBeenCalledWith(expect.objectContaining({ scopes: [] }));
  });

  it('settles completion when a loopback login is cancelled', async () => {
    const resource = 'https://mcp.example.com/mcp';
    const store = {
      load: vi.fn(async () => undefined),
      save: vi.fn(),
      remove: vi.fn(async () => false),
    } as unknown as MCPVaultTokenStore;
    const manager = new MCPAuthorizationManager({
      store,
      discover: async () => discovery(resource),
    });
    const handle = await manager.beginLogin({
      serverName: 'remote',
      resource,
      clientId: 'client',
      timeoutMs: 60_000,
    });

    handle.cancel();

    const observed = await Promise.race([
      handle.completion.then(
        () => ({ state: 'fulfilled' as const }),
        (error: unknown) => ({
          state: 'rejected' as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      ),
      new Promise<{ state: 'pending' }>((resolve) =>
        setImmediate(() => resolve({ state: 'pending' })),
      ),
    ]);
    expect(observed).toMatchObject({ state: 'rejected' });
    expect('message' in observed ? observed.message : '').toMatch(/cancel|closed|abandon/i);
    await expect(manager.status('remote', resource)).resolves.toMatchObject({
      state: 'not_authorized',
    });
  });

  it('does not resurrect an authorization completion cancelled by disconnect during token exchange', async () => {
    const fixture = await createFixture();
    const resource = 'https://mcp.example.com/mcp';
    let finishExchange: (() => void) | undefined;
    const manager = new MCPAuthorizationManager({
      store: fixture.store,
      discover: async () => discovery(resource),
      exchange: () =>
        new Promise((resolve) => {
          finishExchange = () =>
            resolve({
              accessToken: 'resurrected',
              tokenType: 'Bearer',
              resource,
            });
        }),
    });

    const started = await manager.begin({
      serverName: 'remote',
      resource,
      clientId: 'client',
      redirectUri: 'http://127.0.0.1:43123/callback',
    });
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    const completing = manager.complete({
      serverName: 'remote',
      resource,
      callbackUrl: `http://127.0.0.1:43123/callback?code=code-1&state=${encodeURIComponent(state)}`,
    });
    await vi.waitFor(() => expect(finishExchange).toBeTypeOf('function'));
    await expect(manager.disconnect('remote', resource)).resolves.toBe(false);
    finishExchange?.();

    await expect(completing).rejects.toThrow(/completion was cancelled/);
    await expect(manager.status('remote', resource)).resolves.toMatchObject({
      state: 'not_authorized',
    });
  });
});

async function createFixture(): Promise<{
  storePath: string;
  store: MCPVaultTokenStore;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-mcp-auth-manager-'));
  temporaryDirectories.push(directory);
  const storePath = path.join(directory, 'mcp-auth.json');
  const vault = new DefaultSecretVault({ keyFile: path.join(directory, '.key') });
  return { storePath, store: new MCPVaultTokenStore(storePath, vault) };
}

function discovery(resource: string) {
  return {
    resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource',
    authorizationServerMetadataUrl:
      'https://auth.example.com/.well-known/oauth-authorization-server',
    protectedResource: {
      resource,
      authorizationServers: ['https://auth.example.com'],
      scopesSupported: ['tools:read'],
    },
    authorizationServer: {
      issuer: 'https://auth.example.com',
      authorizationEndpoint: 'https://auth.example.com/authorize',
      tokenEndpoint: 'https://auth.example.com/token',
      scopesSupported: ['tools:read'],
    },
  };
}

describe('MCPAuthorizationManager client identity', () => {
  const resource = 'https://mcp.example.com/team';

  function tokenSet(overrides: Record<string, unknown> = {}) {
    return {
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      tokenType: 'Bearer',
      resource,
      expiresAt: Date.now() + 3_600_000,
      scopes: ['tools:read'],
      ...overrides,
    };
  }

  it('dynamically registers a client when none was supplied', async () => {
    const fixture = await createFixture();
    const register = vi.fn(async (_options: MCPClientRegistrationOptions) => ({
      clientId: 'dcr-client',
      issuer: 'https://auth.example.com',
      registeredAt: new Date().toISOString(),
    }));
    const manager = new MCPAuthorizationManager({
      store: fixture.store,
      discover: async () => registrableDiscovery(resource),
      register,
      exchange: async () => tokenSet(),
    });

    const started = await manager.begin({
      serverName: 'team',
      resource,
      redirectUri: 'http://127.0.0.1:43123/callback',
    });

    expect(started.clientIdSource).toBe('registered');
    expect(new URL(started.authorizationUrl).searchParams.get('client_id')).toBe('dcr-client');
    expect(register).toHaveBeenCalledTimes(1);
    expect([...register.mock.calls][0]?.[0]).toMatchObject({
      redirectUris: ['http://127.0.0.1:43123/callback'],
    });
  });

  it('reuses the stored client id instead of registering again', async () => {
    const fixture = await createFixture();
    const register = vi.fn();
    await fixture.store.save({
      serverName: 'team',
      resource,
      clientId: 'already-known',
      authorizationServer: registrableDiscovery(resource).authorizationServer,
      tokenSet: tokenSet(),
      updatedAt: new Date().toISOString(),
    });
    const manager = new MCPAuthorizationManager({
      store: fixture.store,
      discover: async () => registrableDiscovery(resource),
      register,
      exchange: async () => tokenSet(),
    });

    const started = await manager.begin({
      serverName: 'team',
      resource,
      redirectUri: 'http://127.0.0.1:43123/callback',
    });

    expect(started.clientIdSource).toBe('stored');
    expect(new URL(started.authorizationUrl).searchParams.get('client_id')).toBe('already-known');
    expect(register).not.toHaveBeenCalled();
  });

  it('carries a registered client secret into the exchange and the vault', async () => {
    const fixture = await createFixture();
    const exchange = vi.fn(async (input: { clientSecret?: string | undefined }) => {
      expect(input.clientSecret).toBe('registered-secret');
      return tokenSet();
    });
    const manager = new MCPAuthorizationManager({
      store: fixture.store,
      discover: async () => registrableDiscovery(resource),
      register: async () => ({
        clientId: 'confidential-client',
        clientSecret: 'registered-secret',
        issuer: 'https://auth.example.com',
        registeredAt: new Date().toISOString(),
      }),
      exchange: exchange as never,
    });

    const started = await manager.begin({
      serverName: 'team',
      resource,
      redirectUri: 'http://127.0.0.1:43123/callback',
    });
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    await manager.complete({
      serverName: 'team',
      resource,
      callbackUrl: `http://127.0.0.1:43123/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
    });

    expect(exchange).toHaveBeenCalledTimes(1);
    const stored = await fixture.store.load('team', resource);
    expect(stored?.clientSecret).toBe('registered-secret');
    // The secret must be ciphertext at rest, like the tokens beside it.
    const raw = await fs.readFile(fixture.storePath, 'utf8');
    expect(raw).not.toContain('registered-secret');
  });

  it('explains itself when the server supports neither a stored nor a registered client', async () => {
    const fixture = await createFixture();
    const manager = new MCPAuthorizationManager({
      store: fixture.store,
      discover: async () => discovery(resource),
    });

    await expect(
      manager.begin({
        serverName: 'team',
        resource,
        redirectUri: 'http://127.0.0.1:43123/callback',
      }),
    ).rejects.toThrow(/does not support dynamic client registration/);
  });
});

function registrableDiscovery(resource: string) {
  const base = discovery(resource);
  return {
    ...base,
    authorizationServer: {
      ...base.authorizationServer,
      registrationEndpoint: 'https://auth.example.com/register',
    },
  };
}
