import { describe, expect, it, vi } from 'vitest';
import { MCPAuthorizationManager } from '../src/authorization-manager.js';
import type { MCPVaultTokenStore } from '../src/token-store.js';

const resource = 'https://mcp.example.com/mcp';

function stubStore() {
  const saved: unknown[] = [];
  const store = {
    load: vi.fn(async () => saved.at(-1)),
    save: vi.fn(async (value: unknown) => {
      saved.push(value);
    }),
    saveRefreshed: vi.fn(),
    remove: vi.fn(async () => false),
  } as unknown as MCPVaultTokenStore;
  return { store, saved };
}

function discovery() {
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

describe('MCPAuthorizationManager cancel ownership', () => {
  it('a stale login handle cancel does not cancel the successor session completion', async () => {
    const { store, saved } = stubStore();
    let releaseExchange: (() => void) | undefined;
    const manager = new MCPAuthorizationManager({
      store,
      discover: async () => discovery(),
      exchange: () =>
        new Promise((resolve) => {
          releaseExchange = () =>
            resolve({
              accessToken: 'success-token',
              refreshToken: 'refresh-token',
              tokenType: 'Bearer',
              resource,
              expiresAt: Date.now() + 3_600_000,
              scopes: ['tools:read'],
            });
        }),
    });

    // Login A owns the first pending session (P1).
    const stale = await manager.beginLogin({
      serverName: 'remote',
      resource,
      clientId: 'client',
      timeoutMs: 60_000,
    });
    // A newer begin replaces the pending session — supported (the cap check
    // explicitly allows re-begin with an existing key) — creating P2.
    const successor = await manager.begin({
      serverName: 'remote',
      resource,
      clientId: 'client',
      redirectUri: 'http://127.0.0.1:43123/callback',
    });
    const stateB = new URL(successor.authorizationUrl).searchParams.get('state')!;

    // Manual completion of the SUCCESSOR session, exchange held in flight.
    const completing = manager.complete({
      serverName: 'remote',
      resource,
      callbackUrl: `http://127.0.0.1:43123/callback?code=success-code&state=${encodeURIComponent(stateB)}`,
    });
    expect(releaseExchange).toBeTypeOf('function');

    // The stale handle cancels while the successor exchange is in flight.
    stale.cancel();
    releaseExchange?.();

    // The successor's one-shot code must not be burned by a handle whose own
    // session was already replaced.
    await expect(completing).resolves.toMatchObject({ state: 'authorized' });
    expect(saved).toHaveLength(1);
    await expect(manager.status('remote', resource)).resolves.toMatchObject({
      state: 'authorized',
    });
    // The stale login itself still settles through its listener close.
    await expect(stale.completion).rejects.toThrow(/cancel|closed|abandon/i);
  });

  it('cancelling the login still discards its own in-flight exchange', async () => {
    const { store, saved } = stubStore();
    let releaseExchange: (() => void) | undefined;
    const manager = new MCPAuthorizationManager({
      store,
      discover: async () => discovery(),
      exchange: () =>
        new Promise((resolve) => {
          releaseExchange = () =>
            resolve({
              accessToken: 'abandoned-token',
              tokenType: 'Bearer',
              resource,
            });
        }),
    });

    const handle = await manager.beginLogin({
      serverName: 'remote',
      resource,
      clientId: 'client',
      timeoutMs: 60_000,
    });
    const state = new URL(handle.started.authorizationUrl).searchParams.get('state')!;
    // The browser redirect arrives and the login's own exchange starts.
    const redirect = new URL(handle.started.redirectUri);
    redirect.searchParams.set('code', 'one-time-code');
    redirect.searchParams.set('state', state);
    await fetch(redirect);
    await vi.waitFor(() => expect(releaseExchange).toBeTypeOf('function'));

    handle.cancel();
    releaseExchange?.();

    // Abandon semantics preserved: the login's own exchanged tokens are
    // discarded, nothing is persisted, and the status stays unauthorized.
    await expect(handle.completion).rejects.toThrow(/completion was cancelled/);
    expect(saved).toHaveLength(0);
    await expect(manager.status('remote', resource)).resolves.toMatchObject({
      state: 'not_authorized',
    });
  });
});
