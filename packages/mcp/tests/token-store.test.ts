import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSecretVault, noOpVault } from '@wrongstack/core/security';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MCPAuthorizationServerMetadata } from '../src/authorization.js';
import {
  createVaultBackedMcpAuthorizationProviderFactory,
  MCPRefreshingAuthorizationProvider,
  type MCPStoredAuthorization,
  MCPVaultTokenStore,
} from '../src/token-store.js';

const temporaryDirectories: string[] = [];
const activeVaults: DefaultSecretVault[] = [];

afterEach(async () => {
  // Drain pending icacls key-hardening promises BEFORE deleting the temp dirs:
  // a hardening warning firing during teardown leaves the onUserConsoleLog RPC
  // pending and fails the run with EnvironmentTeardownError (see the core
  // secret-vault tests for the original occurrence of this).
  await Promise.all(activeVaults.splice(0).map((vault) => vault.flushHardening()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('MCP vault token store', () => {
  it('persists only encrypted token material and restores the authorization state', async () => {
    const fixture = await createFixture();
    const value = storedAuthorization('alpha', 'https://mcp.example.com/team', {
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
    });

    await fixture.store.save(value);

    const raw = await fs.readFile(fixture.storePath, 'utf8');
    expect(raw).not.toContain('access-secret');
    expect(raw).not.toContain('refresh-secret');
    expect(raw).toContain('enc:v1:');
    await expect(fixture.store.load(value.serverName, value.resource)).resolves.toEqual(value);
  });

  it('serializes concurrent cross-surface updates without losing entries', async () => {
    const fixture = await createFixture();
    const secondStore = new MCPVaultTokenStore(fixture.storePath, fixture.vault);
    const first = storedAuthorization('alpha', 'https://one.example.com/mcp');
    const second = storedAuthorization('beta', 'https://two.example.com/mcp');

    await Promise.all([fixture.store.save(first), secondStore.save(second)]);

    await expect(fixture.store.load(first.serverName, first.resource)).resolves.toEqual(first);
    await expect(fixture.store.load(second.serverName, second.resource)).resolves.toEqual(second);
  });

  it('rejects plaintext token material on disk and a non-encrypting vault', async () => {
    const fixture = await createFixture();
    const value = storedAuthorization('alpha', 'https://mcp.example.com/mcp');
    await fs.writeFile(
      fixture.storePath,
      JSON.stringify({
        version: 1,
        updatedAt: value.updatedAt,
        entries: [
          {
            serverName: value.serverName,
            resource: value.resource,
            clientId: value.clientId,
            authorizationServer: value.authorizationServer,
            accessToken: 'plaintext-access',
            refreshToken: 'plaintext-refresh',
            tokenType: 'Bearer',
            scopes: [],
            updatedAt: value.updatedAt,
          },
        ],
      }),
    );

    await expect(fixture.store.load(value.serverName, value.resource)).rejects.toThrow(
      /unencrypted token/,
    );
    const unsafeStore = new MCPVaultTokenStore(
      path.join(fixture.directory, 'unsafe.json'),
      noOpVault,
    );
    await expect(unsafeStore.save(value)).rejects.toThrow(/encrypting SecretVault/);
  });

  it('removes only the exact server and resource binding', async () => {
    const fixture = await createFixture();
    const first = storedAuthorization('alpha', 'https://mcp.example.com/one');
    const second = storedAuthorization('alpha', 'https://mcp.example.com/two');
    await fixture.store.save(first);
    await fixture.store.save(second);

    await expect(fixture.store.remove(first.serverName, first.resource)).resolves.toBe(true);
    await expect(fixture.store.load(first.serverName, first.resource)).resolves.toBeUndefined();
    await expect(fixture.store.load(second.serverName, second.resource)).resolves.toEqual(second);
  });

  it('returns empty results for a missing store and missing binding', async () => {
    const fixture = await createFixture();
    await expect(
      fixture.store.load('missing', 'https://mcp.example.com/mcp'),
    ).resolves.toBeUndefined();
    await expect(fixture.store.remove('missing', 'https://mcp.example.com/mcp')).resolves.toBe(
      false,
    );
  });

  it('rejects oversized, unreadable, and invalid JSON stores', async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.storePath, 'x'.repeat(1024 * 1024 + 1));
    await expect(fixture.store.load('alpha', 'https://mcp.example.com/mcp')).rejects.toThrow(
      /size limit/,
    );

    await fs.rm(fixture.storePath);
    await fs.mkdir(fixture.storePath);
    await expect(fixture.store.load('alpha', 'https://mcp.example.com/mcp')).rejects.toThrow();

    await fs.rm(fixture.storePath, { recursive: true });
    await fs.writeFile(fixture.storePath, '{invalid');
    await expect(fixture.store.load('alpha', 'https://mcp.example.com/mcp')).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it.each([
    null,
    {},
    { version: 2, updatedAt: '2026-01-01T00:00:00.000Z', entries: [] },
    { version: 1, updatedAt: '2026-01-01T00:00:00.000Z', entries: {} },
  ])('rejects malformed top-level store structure %#', async (raw) => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.storePath, JSON.stringify(raw));
    await expect(fixture.store.load('alpha', 'https://mcp.example.com/mcp')).rejects.toThrow(
      /unsupported or malformed/,
    );
  });

  it('rejects excessive entry counts and malformed entries', async () => {
    const fixture = await createFixture();
    await fs.writeFile(
      fixture.storePath,
      JSON.stringify({
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        entries: Array.from({ length: 257 }, () => null),
      }),
    );
    await expect(fixture.store.load('alpha', 'https://mcp.example.com/mcp')).rejects.toThrow(
      /too many entries/,
    );

    await fs.writeFile(
      fixture.storePath,
      JSON.stringify({
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        entries: [null],
      }),
    );
    await expect(fixture.store.load('alpha', 'https://mcp.example.com/mcp')).rejects.toThrow(
      /entry must be an object/,
    );
  });

  it('validates encrypted entry expiry, fields, and scope bounds', async () => {
    const fixture = await createFixture();
    const value = storedAuthorization('alpha', 'https://mcp.example.com/mcp');
    await fixture.store.save(value);
    const file = JSON.parse(await fs.readFile(fixture.storePath, 'utf8')) as {
      entries: Array<Record<string, unknown>>;
    };
    const entry = file.entries[0]!;

    for (const [field, invalid, message] of [
      ['expiresAt', Number.POSITIVE_INFINITY, /finite number/],
      ['serverName', '', /field "serverName" is invalid/],
      ['serverName', 'bad\nname', /field "serverName" is invalid/],
      ['serverName', 'x'.repeat(257), /field "serverName" is invalid/],
      ['scopes', {}, /must be a bounded array/],
      ['scopes', Array.from({ length: 129 }, () => 'scope'), /must be a bounded array/],
      ['scopes', [1], /field "scopes" is invalid/],
    ] as const) {
      await fs.writeFile(
        fixture.storePath,
        JSON.stringify({
          version: 1,
          updatedAt: '2026-01-01T00:00:00.000Z',
          entries: [{ ...entry, [field]: invalid }],
        }),
      );
      await expect(fixture.store.load('alpha', 'https://mcp.example.com/mcp')).rejects.toThrow(
        message,
      );
    }
  });

  it('rejects plaintext refresh tokens even when access tokens are encrypted', async () => {
    const fixture = await createFixture();
    const value = storedAuthorization('alpha', 'https://mcp.example.com/mcp');
    await fixture.store.save(value);
    const file = JSON.parse(await fs.readFile(fixture.storePath, 'utf8')) as {
      entries: Array<Record<string, unknown>>;
    };
    file.entries[0]!['refreshToken'] = 'plaintext-refresh';
    await fs.writeFile(fixture.storePath, JSON.stringify(file));

    await expect(fixture.store.load(value.serverName, value.resource)).rejects.toThrow(
      /unencrypted token/,
    );
  });

  it('supports credentials without refresh tokens or optional token metadata', async () => {
    const fixture = await createFixture();
    const value = storedAuthorization('alpha', 'https://mcp.example.com/mcp');
    value.tokenSet.refreshToken = undefined;
    value.tokenSet.tokenType = undefined;
    value.tokenSet.scopes = undefined;
    await fixture.store.save(value);

    await expect(fixture.store.load(value.serverName, value.resource)).resolves.toMatchObject({
      tokenSet: { refreshToken: undefined, tokenType: 'Bearer', scopes: [] },
    });
  });

  it('rejects mismatched token resources', async () => {
    const fixture = await createFixture();
    const value = storedAuthorization('alpha', 'https://mcp.example.com/mcp');
    value.tokenSet.resource = 'https://other.example.com/mcp';
    await expect(fixture.store.save(value)).rejects.toThrow(/resource mismatch/);
  });

  it('enforces the maximum stored authorization count on save', async () => {
    const fixture = await createFixture();
    const seed = storedAuthorization('seed', 'https://seed.example.com/mcp');
    await fixture.store.save(seed);
    const file = JSON.parse(await fs.readFile(fixture.storePath, 'utf8')) as {
      entries: Array<Record<string, unknown>>;
    };
    file.entries = Array.from({ length: 256 }, () => ({ ...file.entries[0] }));
    await fs.writeFile(fixture.storePath, JSON.stringify(file));

    await expect(
      fixture.store.save(storedAuthorization('overflow', 'https://overflow.example.com/mcp')),
    ).rejects.toThrow(/exceeds 256 entries/);
  });

  it('rejects a vault that encrypts access but not refresh tokens', async () => {
    const fixture = await createFixture();
    let calls = 0;
    const partialVault = {
      keyVersion: 1,
      encrypt: (value: string) => {
        calls += 1;
        return calls === 1 ? `enc:${value}` : value;
      },
      decrypt: (value: string) => value.replace(/^enc:/, ''),
      isEncrypted: (value: string) => value.startsWith('enc:'),
    };
    const store = new MCPVaultTokenStore(
      path.join(fixture.directory, 'partial.json'),
      partialVault,
    );
    await expect(
      store.save(storedAuthorization('alpha', 'https://mcp.example.com/mcp')),
    ).rejects.toThrow(/encrypting SecretVault/);
  });

  it('normalizes missing scopes in direct encryption input', async () => {
    const fixture = await createFixture();
    const value = storedAuthorization('alpha', 'https://mcp.example.com/mcp');
    value.tokenSet.scopes = undefined;
    const encrypted = (
      fixture.store as never as {
        encryptEntry: (entry: MCPStoredAuthorization) => { scopes: string[] };
      }
    ).encryptEntry(value);
    expect(encrypted.scopes).toEqual([]);
  });
});

describe('MCP refreshing authorization provider', () => {
  it('single-flights proactive refresh and persists rotated tokens', async () => {
    const fixture = await createFixture();
    let refreshCalls = 0;
    let origin = '';
    const server = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        refreshCalls += 1;
        const form = new URLSearchParams(body);
        expect(form.get('grant_type')).toBe('refresh_token');
        expect(form.get('refresh_token')).toBe('refresh-old');
        expect(form.get('resource')).toBe(`${origin}/mcp`);
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            access_token: 'access-new',
            refresh_token: 'refresh-new',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'tools:read',
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    origin = `http://127.0.0.1:${address.port}`;
    const value = storedAuthorization('alpha', `${origin}/mcp`, {
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
      expiresAt: Date.now() + 500,
      authorizationServer: {
        issuer: `${origin}/auth`,
        authorizationEndpoint: `${origin}/authorize`,
        tokenEndpoint: `${origin}/token`,
        scopesSupported: ['tools:read'],
      },
    });
    await fixture.store.save(value);
    const provider = new MCPRefreshingAuthorizationProvider({
      serverName: value.serverName,
      resource: value.resource,
      store: fixture.store,
    });
    const context = { serverName: value.serverName, resource: value.resource };

    try {
      const results = await Promise.all([
        provider.getAccessToken(context),
        provider.getAccessToken(context),
        provider.getAccessToken(context),
      ]);

      expect(refreshCalls).toBe(1);
      expect(results.map((token) => token?.accessToken)).toEqual([
        'access-new',
        'access-new',
        'access-new',
      ]);
      await expect(fixture.store.load(value.serverName, value.resource)).resolves.toMatchObject({
        tokenSet: { accessToken: 'access-new', refreshToken: 'refresh-new' },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reuses providers per HTTP server and leaves stdio servers unauthenticated', async () => {
    const fixture = await createFixture();
    const factory = createVaultBackedMcpAuthorizationProviderFactory({ store: fixture.store });
    const config = {
      name: 'remote',
      transport: 'streamable-http' as const,
      url: 'https://mcp.example.com/mcp',
    };

    expect(factory(config)).toBe(factory(config));
    expect(factory({ name: 'local', transport: 'stdio', command: 'mcp-server' })).toBeUndefined();
    expect(factory({ name: 'remote-missing-url', transport: 'sse' })).toBeUndefined();
  });

  it('returns no token when no authorization is stored', async () => {
    const fixture = await createFixture();
    const provider = new MCPRefreshingAuthorizationProvider({
      serverName: 'alpha',
      resource: 'https://mcp.example.com/mcp',
      store: fixture.store,
    });
    await expect(
      provider.getAccessToken({
        serverName: 'alpha',
        resource: 'https://mcp.example.com/mcp',
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects mismatched provider contexts', async () => {
    const fixture = await createFixture();
    const provider = new MCPRefreshingAuthorizationProvider({
      serverName: 'alpha',
      resource: 'https://mcp.example.com/mcp',
      store: fixture.store,
    });
    await expect(
      provider.getAccessToken({
        serverName: 'other',
        resource: 'https://mcp.example.com/mcp',
      }),
    ).rejects.toThrow(/does not match/);
  });

  it('marks expired non-refreshable authorization as requiring reauthorization', async () => {
    const fixture = await createFixture();
    const value = storedAuthorization('alpha', 'https://mcp.example.com/mcp', {
      expiresAt: Date.now() - 1_000,
    });
    value.tokenSet.refreshToken = undefined;
    await fixture.store.save(value);
    const onStateChange = vi.fn();
    const provider = new MCPRefreshingAuthorizationProvider({
      serverName: value.serverName,
      resource: value.resource,
      store: fixture.store,
      onStateChange,
    });

    await expect(
      provider.getAccessToken({ serverName: value.serverName, resource: value.resource }),
    ).resolves.toBeUndefined();
    expect(onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'reauth_required' }),
    );
  });

  it('handles bearer challenges that cannot be refreshed', async () => {
    const fixture = await createFixture();
    const resource = 'https://mcp.example.com/mcp';
    const provider = new MCPRefreshingAuthorizationProvider({
      serverName: 'alpha',
      resource,
      store: fixture.store,
      onStateChange: vi.fn(),
    });
    const context = { serverName: 'alpha', resource };

    await expect(
      provider.handleUnauthorized(
        {
          status: 401,
          rawScheme: 'Bearer',
          resource: 'https://other.example.com/mcp',
          scopes: [],
        },
        context,
      ),
    ).resolves.toBe(false);
    await expect(
      provider.handleUnauthorized(
        { status: 401, rawScheme: 'Bearer', resource, scopes: [] },
        context,
      ),
    ).resolves.toBe(false);

    const value = storedAuthorization('alpha', resource);
    value.tokenSet.refreshToken = undefined;
    await fixture.store.save(value);
    await expect(
      provider.handleUnauthorized(
        { status: 401, rawScheme: 'Bearer', resource, scopes: [] },
        context,
      ),
    ).resolves.toBe(false);
  });

  it('detects an already expired token outside the proactive refresh window', async () => {
    const fixture = await createFixture();
    const value = storedAuthorization('alpha', 'https://mcp.example.com/mcp', {
      expiresAt: Date.now() - 1_000,
    });
    await fixture.store.save(value);
    const onStateChange = vi.fn();
    const provider = new MCPRefreshingAuthorizationProvider({
      serverName: value.serverName,
      resource: value.resource,
      store: fixture.store,
      refreshSkewMs: -60_000,
      onStateChange,
    });

    await expect(
      provider.getAccessToken({ serverName: value.serverName, resource: value.resource }),
    ).resolves.toBeUndefined();
    expect(onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'reauth_required' }),
    );
  });

  it('returns a future token without refreshing it', async () => {
    const fixture = await createFixture();
    const value = storedAuthorization('alpha', 'https://mcp.example.com/mcp', {
      expiresAt: Date.now() + 3_600_000,
    });
    await fixture.store.save(value);
    const provider = new MCPRefreshingAuthorizationProvider({
      serverName: value.serverName,
      resource: value.resource,
      store: fixture.store,
    });

    await expect(
      provider.getAccessToken({ serverName: value.serverName, resource: value.resource }),
    ).resolves.toMatchObject({ accessToken: 'access-token' });
  });

  it('refreshes a matching unauthorized challenge', async () => {
    const fixture = await createFixture();
    const value = storedAuthorization('alpha', 'https://mcp.example.com/mcp');
    await fixture.store.save(value);
    const provider = new MCPRefreshingAuthorizationProvider({
      serverName: value.serverName,
      resource: value.resource,
      store: fixture.store,
    });
    vi.spyOn(
      provider as never as {
        refresh: (
          state: MCPStoredAuthorization,
          signal?: AbortSignal,
        ) => Promise<MCPStoredAuthorization | undefined>;
      },
      'refresh',
    ).mockResolvedValue(value);

    await expect(
      provider.handleUnauthorized(
        { status: 401, rawScheme: 'Bearer', resource: value.resource, scopes: [] },
        { serverName: value.serverName, resource: value.resource },
      ),
    ).resolves.toBe(true);
  });

  it('normalizes missing scopes returned by a host token store and state events', async () => {
    const value = storedAuthorization('alpha', 'https://mcp.example.com/mcp');
    value.tokenSet.scopes = undefined;
    const store = {
      load: vi.fn(async () => value),
    } as unknown as MCPVaultTokenStore;
    const onStateChange = vi.fn();
    const provider = new MCPRefreshingAuthorizationProvider({
      serverName: value.serverName,
      resource: value.resource,
      store,
      onStateChange,
    });

    await expect(
      provider.getAccessToken({ serverName: value.serverName, resource: value.resource }),
    ).resolves.toMatchObject({ scopes: [] });
    (
      provider as never as {
        emit: (state: 'authorized', stored: MCPStoredAuthorization) => void;
      }
    ).emit('authorized', value);
    expect(onStateChange).toHaveBeenCalledWith(expect.objectContaining({ scopes: [] }));
  });
});

async function createFixture(): Promise<{
  directory: string;
  storePath: string;
  vault: DefaultSecretVault;
  store: MCPVaultTokenStore;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-mcp-token-store-'));
  temporaryDirectories.push(directory);
  const storePath = path.join(directory, 'mcp-auth.json');
  const vault = new DefaultSecretVault({ keyFile: path.join(directory, '.key') });
  activeVaults.push(vault);
  return { directory, storePath, vault, store: new MCPVaultTokenStore(storePath, vault) };
}

function storedAuthorization(
  serverName: string,
  resource: string,
  overrides: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    authorizationServer?: MCPAuthorizationServerMetadata;
  } = {},
): MCPStoredAuthorization {
  return {
    serverName,
    resource,
    clientId: 'wrongstack-client',
    authorizationServer:
      overrides.authorizationServer ??
      ({
        issuer: 'https://auth.example.com/tenant',
        authorizationEndpoint: 'https://auth.example.com/authorize',
        tokenEndpoint: 'https://auth.example.com/token',
        scopesSupported: ['tools:read'],
      } satisfies MCPAuthorizationServerMetadata),
    tokenSet: {
      accessToken: overrides.accessToken ?? 'access-token',
      refreshToken: overrides.refreshToken ?? 'refresh-token',
      tokenType: 'Bearer',
      resource,
      expiresAt: overrides.expiresAt,
      scopes: ['tools:read'],
    },
    updatedAt: '2026-07-13T00:00:00.000Z',
  };
}
