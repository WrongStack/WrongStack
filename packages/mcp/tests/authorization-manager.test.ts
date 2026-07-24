import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSecretVault } from '@wrongstack/core/security';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPAuthorizationManager } from '../src/authorization-manager.js';
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
