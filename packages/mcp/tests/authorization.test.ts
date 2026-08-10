import { createHash } from 'node:crypto';
import * as http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  authorizationHeaderForToken,
  authorizationServerMetadataUrls,
  canonicalMcpResource,
  createMcpAuthorizationRequest,
  discoverMcpAuthorization,
  exchangeMcpAuthorizationCode,
  type MCPAuthorizationProvider,
  parseAuthorizationServerMetadata,
  parseMcpAuthorizationCallback,
  parseMcpBearerChallenge,
  parseProtectedResourceMetadata,
  protectedResourceMetadataUrls,
  refreshMcpAccessToken,
  validateMcpAuthorizationServerMetadata,
} from '../src/authorization.js';
import { StreamableHTTPTransport } from '../src/transport.js';

const INIT_RESULT = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: {} },
  serverInfo: { name: 'auth-fixture', version: '1.0.0' },
};

describe('MCP authorization primitives', () => {
  it('rejects invalid authorization resource URLs', () => {
    expect(() => canonicalMcpResource('not a url')).toThrow(/absolute URL/);
    expect(() => canonicalMcpResource('http://example.com/mcp')).toThrow(/must use HTTPS/);
    expect(() => canonicalMcpResource('https://user@example.com/mcp')).toThrow(
      /must not contain credentials/,
    );
    expect(() => canonicalMcpResource('https://example.com/mcp#fragment')).toThrow(
      /must not contain credentials/,
    );
  });

  it('builds a canonical resource and enforces token audience binding', () => {
    expect(canonicalMcpResource('https://MCP.Example.com/')).toBe('https://mcp.example.com');
    expect(canonicalMcpResource('https://mcp.example.com/team/mcp')).toBe(
      'https://mcp.example.com/team/mcp',
    );
    expect(
      authorizationHeaderForToken(
        { accessToken: 'secret-token', resource: 'https://mcp.example.com' },
        'https://mcp.example.com',
      ),
    ).toBe('Bearer secret-token');
    expect(() =>
      authorizationHeaderForToken(
        { accessToken: 'secret-token', resource: 'https://other.example.com' },
        'https://mcp.example.com',
      ),
    ).toThrow(/resource does not match/);
  });

  it('rejects expired, non-bearer, and header-injection tokens', () => {
    expect(() =>
      authorizationHeaderForToken(
        { accessToken: 'old', resource: 'https://mcp.example.com', expiresAt: 99 },
        'https://mcp.example.com',
        100,
      ),
    ).toThrow(/expired/);
    expect(() =>
      authorizationHeaderForToken(
        { accessToken: 'token', tokenType: 'MAC', resource: 'https://mcp.example.com' },
        'https://mcp.example.com',
      ),
    ).toThrow(/token type/);
    expect(() =>
      authorizationHeaderForToken(
        { accessToken: 'token\r\nX-Evil: yes', resource: 'https://mcp.example.com' },
        'https://mcp.example.com',
      ),
    ).toThrow(/invalid characters/);
  });

  it('parses bounded bearer challenge metadata and scopes', () => {
    expect(
      parseMcpBearerChallenge(
        'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read files:write files:read"',
        'https://mcp.example.com/mcp',
      ),
    ).toEqual({
      status: 401,
      resource: 'https://mcp.example.com/mcp',
      resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource',
      scopes: ['files:read', 'files:write'],
      rawScheme: 'Bearer',
    });
    expect(
      parseMcpBearerChallenge(
        'Bearer resource_metadata="http://169.254.169.254/latest"',
        'https://mcp.example.com/mcp',
      ).resourceMetadataUrl,
    ).toBeUndefined();
    const basicChallenge = parseMcpBearerChallenge(
      'Basic realm="example"',
      'https://mcp.example.com/mcp',
    );
    expect(basicChallenge.scopes).toEqual([]);
    expect(basicChallenge).not.toHaveProperty('resourceMetadataUrl');
    expect(
      parseMcpBearerChallenge('Bearer resource_metadata="not a url"', 'https://mcp.example.com/mcp')
        .resourceMetadataUrl,
    ).toBeUndefined();
    expect(
      parseMcpBearerChallenge(
        'Bearer resource_metadata="https://user@example.com/meta"',
        'https://mcp.example.com/mcp',
      ).resourceMetadataUrl,
    ).toBeUndefined();
  });

  it('constructs protected-resource and authorization-server discovery order', () => {
    expect(protectedResourceMetadataUrls('https://mcp.example.com/team/mcp')).toEqual([
      'https://mcp.example.com/.well-known/oauth-protected-resource/team/mcp',
      'https://mcp.example.com/.well-known/oauth-protected-resource',
    ]);
    expect(authorizationServerMetadataUrls('https://auth.example.com/tenant1')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example.com/.well-known/openid-configuration/tenant1',
      'https://auth.example.com/tenant1/.well-known/openid-configuration',
    ]);
    expect(protectedResourceMetadataUrls('https://mcp.example.com')).toEqual([
      'https://mcp.example.com/.well-known/oauth-protected-resource',
    ]);
    expect(authorizationServerMetadataUrls('https://auth.example.com')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server',
      'https://auth.example.com/.well-known/openid-configuration',
    ]);
  });

  it('validates protected-resource audience and PKCE-capable authorization metadata', () => {
    expect(
      parseProtectedResourceMetadata(
        {
          resource: 'https://mcp.example.com/team/mcp',
          authorization_servers: ['https://auth.example.com/tenant1'],
          scopes_supported: ['tools:read', 'tools:read'],
        },
        'https://mcp.example.com/team/mcp',
      ),
    ).toEqual({
      resource: 'https://mcp.example.com/team/mcp',
      authorizationServers: ['https://auth.example.com/tenant1'],
      scopesSupported: ['tools:read'],
    });
    expect(
      parseAuthorizationServerMetadata(
        {
          issuer: 'https://auth.example.com/tenant1',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          code_challenge_methods_supported: ['S256'],
        },
        'https://auth.example.com/tenant1',
      ),
    ).toMatchObject({
      issuer: 'https://auth.example.com/tenant1',
      authorizationEndpoint: 'https://auth.example.com/authorize',
      tokenEndpoint: 'https://auth.example.com/token',
    });

    expect(() =>
      parseProtectedResourceMetadata(
        {
          resource: 'https://other.example.com',
          authorization_servers: ['https://auth.example.com'],
        },
        'https://mcp.example.com',
      ),
    ).toThrow(/does not match/);
    expect(() =>
      parseAuthorizationServerMetadata(
        {
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          code_challenge_methods_supported: ['plain'],
        },
        'https://auth.example.com',
      ),
    ).toThrow(/PKCE S256/);

    expect(() =>
      parseProtectedResourceMetadata(
        {
          resource: 'https://mcp.example.com',
          authorization_servers: [],
        },
        'https://mcp.example.com',
      ),
    ).toThrow(/must declare an authorization server/);
    expect(() =>
      parseAuthorizationServerMetadata(
        {
          issuer: 'https://other.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          code_challenge_methods_supported: ['S256'],
        },
        'https://auth.example.com',
      ),
    ).toThrow(/issuer mismatch/);
  });

  it('rejects malformed authorization metadata fields and URLs', () => {
    expect(() => parseProtectedResourceMetadata(null, 'https://mcp.example.com')).toThrow(
      /must be an object/,
    );
    expect(() =>
      parseProtectedResourceMetadata(
        { resource: '', authorization_servers: [] },
        'https://mcp.example.com',
      ),
    ).toThrow(/bounded non-empty string/);
    expect(() =>
      parseProtectedResourceMetadata(
        {
          resource: 'https://mcp.example.com',
          authorization_servers: {},
        },
        'https://mcp.example.com',
      ),
    ).toThrow(/must be an array/);
    expect(() =>
      parseProtectedResourceMetadata(
        {
          resource: 'https://mcp.example.com',
          authorization_servers: Array.from({ length: 9 }, () => 'https://auth.example.com'),
        },
        'https://mcp.example.com',
      ),
    ).toThrow(/at most 8/);
    expect(() =>
      parseAuthorizationServerMetadata(
        {
          issuer: 'not a url',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          code_challenge_methods_supported: ['S256'],
        },
        'https://auth.example.com',
      ),
    ).toThrow(/absolute URL/);
    expect(() =>
      parseAuthorizationServerMetadata(
        {
          issuer: 'http://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          code_challenge_methods_supported: ['S256'],
        },
        'http://auth.example.com',
      ),
    ).toThrow(/must use HTTPS/);
    expect(() =>
      parseAuthorizationServerMetadata(
        {
          issuer: 'https://auth.example.com?query=yes',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          code_challenge_methods_supported: ['S256'],
        },
        'https://auth.example.com?query=yes',
      ),
    ).toThrow(/must not contain credentials/);

    expect(
      parseAuthorizationServerMetadata(
        {
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
          code_challenge_methods_supported: ['S256'],
        },
        'https://auth.example.com',
      ).registrationEndpoint,
    ).toBe('https://auth.example.com/register');
    expect(
      validateMcpAuthorizationServerMetadata({
        issuer: 'https://auth.example.com',
        authorizationEndpoint: 'https://auth.example.com/authorize',
        tokenEndpoint: 'https://auth.example.com/token',
        registrationEndpoint: 'https://auth.example.com/register',
      }).registrationEndpoint,
    ).toBe('https://auth.example.com/register');
  });

  it('requires issuer-bound responses before accepting cross-origin OAuth endpoints', () => {
    const metadata = {
      issuer: 'https://issuer.example.com',
      authorization_endpoint: 'https://login.example.net/authorize',
      token_endpoint: 'https://tokens.example.net/token',
      code_challenge_methods_supported: ['S256'],
    };

    expect(() => parseAuthorizationServerMetadata(metadata, 'https://issuer.example.com')).toThrow(
      /cross-origin endpoints.*issuer parameter/,
    );
    expect(
      parseAuthorizationServerMetadata(
        { ...metadata, authorization_response_iss_parameter_supported: true },
        'https://issuer.example.com',
      ),
    ).toMatchObject({
      authorizationResponseIssuerParameterSupported: true,
    });
    expect(() =>
      parseAuthorizationServerMetadata(
        { ...metadata, authorization_response_iss_parameter_supported: 'true' },
        'https://issuer.example.com',
      ),
    ).toThrow(/must be a boolean/);
  });

  it('orchestrates RFC 9728 then RFC 8414/OIDC fallback order', async () => {
    const requested: string[] = [];
    const responses = new Map<string, unknown>([
      [
        'https://mcp.example.com/.well-known/oauth-protected-resource',
        {
          resource: 'https://mcp.example.com/team/mcp',
          authorization_servers: ['https://auth.example.com/tenant1'],
        },
      ],
      [
        'https://auth.example.com/.well-known/openid-configuration/tenant1',
        {
          issuer: 'https://auth.example.com/tenant1',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          code_challenge_methods_supported: ['S256'],
        },
      ],
    ]);
    const result = await discoverMcpAuthorization('https://mcp.example.com/team/mcp', {
      fetchJson: async (url) => {
        requested.push(url);
        return responses.get(url);
      },
    });

    expect(requested).toEqual([
      'https://mcp.example.com/.well-known/oauth-protected-resource/team/mcp',
      'https://mcp.example.com/.well-known/oauth-protected-resource',
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example.com/.well-known/openid-configuration/tenant1',
    ]);
    expect(result).toMatchObject({
      resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource',
      authorizationServerMetadataUrl:
        'https://auth.example.com/.well-known/openid-configuration/tenant1',
    });
  });

  it('uses challenge metadata as authoritative instead of silently falling back', async () => {
    const requested: string[] = [];
    await expect(
      discoverMcpAuthorization('https://mcp.example.com/mcp', {
        challengeHeader:
          'Bearer resource_metadata="https://mcp.example.com/custom-metadata", scope="tools:read"',
        fetchJson: async (url) => {
          requested.push(url);
          return { resource: 'https://wrong.example.com', authorization_servers: [] };
        },
      }),
    ).rejects.toThrow(/protected resource metadata discovery failed/);
    expect(requested).toEqual(['https://mcp.example.com/custom-metadata']);
  });

  it('records non-Error discovery failures', async () => {
    await expect(
      discoverMcpAuthorization('https://mcp.example.com/mcp', {
        fetchJson: async () => Promise.reject('plain failure'),
      }),
    ).rejects.toThrow(/plain failure/);
  });

  it('performs pinned loopback discovery for local development', async () => {
    let origin = '';
    const server = http.createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/.well-known/oauth-protected-resource/mcp') {
        response.end(
          JSON.stringify({
            resource: `${origin}/mcp`,
            authorization_servers: [`${origin}/auth`],
            scopes_supported: ['tools:read'],
          }),
        );
        return;
      }
      if (request.url === '/.well-known/oauth-authorization-server/auth') {
        response.end(
          JSON.stringify({
            issuer: `${origin}/auth`,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            code_challenge_methods_supported: ['S256'],
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    origin = `http://127.0.0.1:${address.port}`;
    try {
      const result = await discoverMcpAuthorization(`${origin}/mcp`);
      expect(result.protectedResource.resource).toBe(`${origin}/mcp`);
      expect(result.authorizationServer.tokenEndpoint).toBe(`${origin}/token`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('blocks a public discovery hostname that resolves to a private address', async () => {
    await expect(
      discoverMcpAuthorization('https://mcp.example.com/mcp', {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    ).rejects.toThrow(/blocked private address/);
  });

  it('does not follow discovery redirects', async () => {
    let redirectedHits = 0;
    const server = http.createServer((request, response) => {
      if (request.url === '/redirected') {
        redirectedHits += 1;
        response.setHeader('content-type', 'application/json');
        response.end('{}');
        return;
      }
      response.statusCode = 302;
      response.setHeader('location', '/redirected');
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    try {
      await expect(
        discoverMcpAuthorization(`http://127.0.0.1:${address.port}/mcp`),
      ).rejects.toThrow(/redirects are not allowed/);
      expect(redirectedHits).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('creates PKCE S256 authorization requests and validates callback state', () => {
    const session = createMcpAuthorizationRequest({
      authorizationServer: {
        issuer: 'https://auth.example.com',
        authorizationEndpoint: 'https://auth.example.com/authorize',
        tokenEndpoint: 'https://auth.example.com/token',
        scopesSupported: ['tools:read'],
      },
      clientId: 'wrongstack-public-client',
      redirectUri: 'http://127.0.0.1:43123/callback',
      resource: 'https://mcp.example.com/team/mcp',
      scopes: ['tools:read', 'tools:read'],
    });
    const authorizationUrl = new URL(session.authorizationUrl);
    const expectedChallenge = createHash('sha256').update(session.codeVerifier).digest('base64url');

    expect(authorizationUrl.searchParams.get('code_challenge')).toBe(expectedChallenge);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('resource')).toBe('https://mcp.example.com/team/mcp');
    expect(authorizationUrl.searchParams.get('scope')).toBe('tools:read');
    expect(
      parseMcpAuthorizationCallback(
        `http://127.0.0.1:43123/callback?code=auth-code&state=${session.state}`,
        session,
      ),
    ).toBe('auth-code');
    expect(() =>
      parseMcpAuthorizationCallback(
        'http://127.0.0.1:43123/callback?code=auth-code&state=wrong',
        session,
      ),
    ).toThrow(/state mismatch/);

    expect(() => parseMcpAuthorizationCallback('not a url', session)).toThrow(/absolute URL/);
    expect(() =>
      parseMcpAuthorizationCallback(
        `http://127.0.0.1:43124/callback?code=auth-code&state=${session.state}`,
        session,
      ),
    ).toThrow(/redirect URI does not match/);
    expect(() =>
      parseMcpAuthorizationCallback(
        `http://127.0.0.1:43123/callback?error=access_denied&state=${session.state}`,
        session,
      ),
    ).toThrow(/access_denied/);
    expect(() =>
      parseMcpAuthorizationCallback(
        `http://127.0.0.1:43123/callback?error=${encodeURIComponent('bad error!')}&state=${session.state}`,
        session,
      ),
    ).toThrow(/invalid_error/);
    expect(() =>
      parseMcpAuthorizationCallback(
        `http://127.0.0.1:43123/callback?state=${session.state}`,
        session,
      ),
    ).toThrow(/exactly one authorization code/);
    expect(() =>
      parseMcpAuthorizationCallback('http://127.0.0.1:43123/callback?code=auth-code', session),
    ).toThrow(/exactly one state/);
    expect(() =>
      parseMcpAuthorizationCallback(
        `http://127.0.0.1:43123/callback?code=one&code=two&state=${session.state}`,
        session,
      ),
    ).toThrow(/ambiguous response/);
    expect(() =>
      parseMcpAuthorizationCallback(
        `http://127.0.0.1:43123/callback?code=auth-code&state=${session.state}&state=${session.state}`,
        session,
      ),
    ).toThrow(/exactly one state/);
    expect(() =>
      parseMcpAuthorizationCallback(
        `http://127.0.0.1:43123/callback?code=auth-code&error=access_denied&state=${session.state}`,
        session,
      ),
    ).toThrow(/ambiguous response/);
  });

  it('validates the authorization-response issuer before exposing the code', () => {
    const session = createMcpAuthorizationRequest({
      authorizationServer: {
        issuer: 'https://issuer.example.com',
        authorizationEndpoint: 'https://login.example.net/authorize',
        tokenEndpoint: 'https://tokens.example.net/token',
        authorizationResponseIssuerParameterSupported: true,
        scopesSupported: [],
      },
      clientId: 'wrongstack-public-client',
      redirectUri: 'http://127.0.0.1:43123/callback',
      resource: 'https://mcp.example.com/mcp',
    });
    const callback = (issuer = '') =>
      `http://127.0.0.1:43123/callback?code=auth-code&state=${session.state}${issuer}`;

    expect(() => parseMcpAuthorizationCallback(callback(), session)).toThrow(/exactly one issuer/);
    expect(() =>
      parseMcpAuthorizationCallback(
        callback(`&iss=${encodeURIComponent('https://attacker.example.com')}`),
        session,
      ),
    ).toThrow(/issuer mismatch/);
    expect(
      parseMcpAuthorizationCallback(
        callback(`&iss=${encodeURIComponent('https://issuer.example.com')}`),
        session,
      ),
    ).toBe('auth-code');
    expect(() =>
      parseMcpAuthorizationCallback(
        callback(
          `&iss=${encodeURIComponent('https://issuer.example.com')}&iss=${encodeURIComponent('https://issuer.example.com')}`,
        ),
        session,
      ),
    ).toThrow(/exactly one issuer/);
  });

  it('validates redirect URIs, scopes, and PKCE inputs', () => {
    const authorizationServer = {
      issuer: 'https://auth.example.com',
      authorizationEndpoint: 'https://auth.example.com/authorize',
      tokenEndpoint: 'https://auth.example.com/token',
      scopesSupported: ['tools:read'],
    };
    const create = (redirectUri: string, scopes: string[] = []) =>
      createMcpAuthorizationRequest({
        authorizationServer,
        clientId: 'client',
        redirectUri,
        resource: 'https://mcp.example.com/mcp',
        scopes,
      });

    expect(() => create('not a url')).toThrow(/redirect URI must be an absolute/);
    expect(() => create('http://example.com/callback')).toThrow(/must use HTTPS/);
    expect(() => create('https://user@example.com/callback')).toThrow(
      /must not contain credentials/,
    );
    expect(() => create('https://example.com/callback?query=yes')).toThrow(
      /must not contain credentials/,
    );
    expect(() =>
      create(
        'https://example.com/callback',
        Array.from({ length: 129 }, () => 'scope'),
      ),
    ).toThrow(/exceeds 128/);
    expect(() => create('https://example.com/callback', ['bad scope'])).toThrow(
      /bounded non-empty tokens/,
    );
    expect(() =>
      createMcpAuthorizationRequest({
        authorizationServer,
        clientId: 'client',
        redirectUri: 'https://example.com/callback',
        resource: 'https://mcp.example.com/mcp',
      }),
    ).not.toThrow();
  });

  it('exchanges and rotates tokens with mandatory resource indicators', async () => {
    const requests: URLSearchParams[] = [];
    let origin = '';
    const server = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        const form = new URLSearchParams(body);
        requests.push(form);
        response.setHeader('content-type', 'application/json');
        if (form.get('grant_type') === 'authorization_code') {
          response.end(
            JSON.stringify({
              access_token: 'access-one',
              refresh_token: 'refresh-one',
              token_type: 'Bearer',
              expires_in: 3600,
              scope: 'tools:read',
            }),
          );
          return;
        }
        response.end(
          JSON.stringify({
            access_token: 'access-two',
            refresh_token: 'refresh-two',
            token_type: 'bearer',
            expires_in: 1800,
            scope: 'tools:read',
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    origin = `http://127.0.0.1:${address.port}`;
    const authorizationServer = {
      issuer: `${origin}/auth`,
      authorizationEndpoint: `${origin}/authorize`,
      tokenEndpoint: `${origin}/token`,
      scopesSupported: ['tools:read'],
    };
    const session = createMcpAuthorizationRequest({
      authorizationServer,
      clientId: 'wrongstack-client',
      redirectUri: `${origin}/callback`,
      resource: `${origin}/mcp`,
      scopes: ['tools:read'],
    });
    try {
      const first = await exchangeMcpAuthorizationCode({
        authorizationServer,
        clientId: session.clientId,
        redirectUri: session.redirectUri,
        resource: session.resource,
        code: 'authorization-code',
        codeVerifier: session.codeVerifier,
      });
      const refreshed = await refreshMcpAccessToken({
        authorizationServer,
        clientId: session.clientId,
        resource: session.resource,
        refreshToken: first.refreshToken!,
      });

      expect(first).toMatchObject({
        accessToken: 'access-one',
        refreshToken: 'refresh-one',
        resource: `${origin}/mcp`,
        scopes: ['tools:read'],
      });
      expect(refreshed).toMatchObject({
        accessToken: 'access-two',
        refreshToken: 'refresh-two',
        resource: `${origin}/mcp`,
      });
      expect(requests).toHaveLength(2);
      expect(requests[0]?.get('resource')).toBe(`${origin}/mcp`);
      expect(requests[0]?.get('code_verifier')).toBe(session.codeVerifier);
      expect(requests[1]?.get('resource')).toBe(`${origin}/mcp`);
      expect(requests[1]?.get('refresh_token')).toBe('refresh-one');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('validates token endpoint responses and missing discovery responses', async () => {
    let origin = '';
    const server = http.createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/missing') {
        response.statusCode = 404;
        response.end('{}');
        return;
      }
      if (request.url === '/gone') {
        response.statusCode = 410;
        response.end('{}');
        return;
      }
      if (request.url === '/bad-type') {
        response.end(JSON.stringify({ access_token: 'token', token_type: 'MAC' }));
        return;
      }
      if (request.url === '/minimal') {
        response.end(JSON.stringify({ access_token: 'token' }));
        return;
      }
      response.end(
        JSON.stringify({
          access_token: 'token',
          token_type: 'Bearer',
          expires_in: 0,
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    origin = `http://127.0.0.1:${address.port}`;
    const metadata = (path: string) => ({
      issuer: `${origin}/auth`,
      authorizationEndpoint: `${origin}/authorize`,
      tokenEndpoint: `${origin}${path}`,
      scopesSupported: [],
    });
    const exchange = (path: string) =>
      exchangeMcpAuthorizationCode({
        authorizationServer: metadata(path),
        clientId: 'client',
        redirectUri: `${origin}/callback`,
        resource: `${origin}/mcp`,
        code: 'code',
        codeVerifier: 'a'.repeat(43),
      });

    try {
      await expect(exchange('/missing')).rejects.toThrow(/returned no response/);
      await expect(
        refreshMcpAccessToken({
          authorizationServer: metadata('/gone'),
          clientId: 'client',
          resource: `${origin}/mcp`,
          refreshToken: 'refresh',
        }),
      ).rejects.toThrow(/returned no response/);
      await expect(exchange('/bad-type')).rejects.toThrow(/token type/);
      await expect(exchange('/bad-expiry')).rejects.toThrow(/expires_in/);
      await expect(exchange('/minimal')).resolves.toMatchObject({
        tokenType: 'Bearer',
        scopes: [],
      });
      await expect(
        refreshMcpAccessToken({
          authorizationServer: metadata('/minimal'),
          clientId: 'client',
          resource: `${origin}/mcp`,
          refreshToken: 'previous-refresh',
        }),
      ).resolves.toMatchObject({ refreshToken: 'previous-refresh' });
      await expect(
        exchangeMcpAuthorizationCode({
          authorizationServer: metadata('/missing'),
          clientId: 'client',
          redirectUri: `${origin}/callback`,
          resource: `${origin}/mcp`,
          code: 'code',
          codeVerifier: 'short',
        }),
      ).rejects.toThrow(/code verifier/);
      await expect(
        refreshMcpAccessToken({
          authorizationServer: metadata('/missing'),
          clientId: 'client',
          resource: `${origin}/mcp`,
          refreshToken: 'bad\nrefresh',
        }),
      ).rejects.toThrow(/refresh token/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects bounded discovery HTTP failure modes', async () => {
    let mode:
      | 'status'
      | 'content-type'
      | 'missing-content-type'
      | 'declared-large'
      | 'chunk-large'
      | 'invalid'
      | 'response-error'
      | 'timeout' = 'status';
    const server = http.createServer((_request, response) => {
      if (mode === 'status') {
        response.statusCode = 500;
        response.end('{}');
        return;
      }
      if (mode === 'content-type') {
        response.setHeader('content-type', 'text/plain');
        response.end('{}');
        return;
      }
      if (mode === 'missing-content-type') {
        response.end('{}');
        return;
      }
      if (mode === 'declared-large') {
        response.setHeader('content-type', 'application/json');
        response.setHeader('content-length', '100');
        response.end('x'.repeat(100));
        return;
      }
      if (mode === 'chunk-large') {
        response.setHeader('content-type', 'application/json');
        response.write('x'.repeat(40));
        response.end('x'.repeat(40));
        return;
      }
      if (mode === 'invalid') {
        response.setHeader('content-type', 'application/json');
        response.end('{invalid');
        return;
      }
      if (mode === 'response-error') {
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': '10',
        });
        response.flushHeaders();
        response.write('{}');
        setImmediate(() => response.destroy(new Error('response failed')));
        return;
      }
      // Leave the request pending so the client timeout path owns teardown.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    const resource = `http://127.0.0.1:${address.port}/mcp`;
    const discover = () =>
      discoverMcpAuthorization(resource, {
        timeoutMs: 25,
        maxResponseBytes: 32,
      });

    try {
      await expect(discover()).rejects.toThrow(/HTTP 500/);
      mode = 'content-type';
      await expect(discover()).rejects.toThrow(/must be JSON/);
      mode = 'missing-content-type';
      await expect(discover()).rejects.toThrow(/must be JSON/);
      mode = 'declared-large';
      await expect(discover()).rejects.toThrow(/exceeds 32 bytes/);
      mode = 'chunk-large';
      await expect(discover()).rejects.toThrow(/exceeds 32 bytes/);
      mode = 'invalid';
      await expect(discover()).rejects.toThrow(/not valid JSON/);
      mode = 'response-error';
      await expect(discover()).rejects.toThrow();
      mode = 'timeout';
      await expect(discover()).rejects.toThrow(/timed out/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('handles discovery cancellation and connection errors', async () => {
    const server = http.createServer(() => {
      // Keep the request open until the caller aborts.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    const port = address.port;
    const controller = new AbortController();
    const pending = discoverMcpAuthorization(`http://127.0.0.1:${port}/mcp`, {
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    setTimeout(() => controller.abort('cancelled'), 0);
    await expect(pending).rejects.toThrow();

    const errorController = new AbortController();
    const secondPending = discoverMcpAuthorization(`http://127.0.0.1:${port}/mcp`, {
      signal: errorController.signal,
      timeoutMs: 1_000,
    });
    setTimeout(() => errorController.abort(new Error('cancelled with error')), 0);
    await expect(secondPending).rejects.toThrow(/cancelled with error/);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(
      discoverMcpAuthorization(`http://127.0.0.1:${port}/mcp`, { timeoutMs: 50 }),
    ).rejects.toThrow(/discovery failed/);
  });

  it('validates DNS discovery results and selects an allowed loopback address', async () => {
    await expect(
      discoverMcpAuthorization('https://mcp.example.com/mcp', {
        lookup: async () => [],
      }),
    ).rejects.toThrow(/DNS returned no addresses/);
    await expect(
      discoverMcpAuthorization('https://mcp.example.com/mcp', {
        lookup: async () => [{ address: 'example', family: 0 }],
      }),
    ).rejects.toThrow(/unsupported address family/);
    await expect(
      discoverMcpAuthorization('https://mcp.example.com/mcp', {
        lookup: async () => [
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
      }),
    ).rejects.toThrow(/blocked private address/);

    let origin = '';
    const server = http.createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/.well-known/oauth-protected-resource/mcp') {
        response.end(
          JSON.stringify({
            resource: `${origin}/mcp`,
            authorization_servers: [`${origin}/auth`],
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          issuer: `${origin}/auth`,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          code_challenge_methods_supported: ['S256'],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    origin = `http://localhost:${address.port}`;
    try {
      await expect(
        discoverMcpAuthorization(`${origin}/mcp`, {
          lookup: async () => [{ address: '127.0.0.1', family: 4 }],
        }),
      ).resolves.toMatchObject({
        protectedResource: { resource: `${origin}/mcp` },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('uses the default DNS lookup for localhost discovery', async () => {
    let origin = '';
    const server = http.createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/.well-known/oauth-protected-resource/mcp') {
        response.end(
          JSON.stringify({
            resource: `${origin}/mcp`,
            authorization_servers: [`${origin}/auth`],
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          issuer: `${origin}/auth`,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          code_challenge_methods_supported: ['S256'],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    origin = `http://localhost:${address.port}`;
    try {
      await expect(discoverMcpAuthorization(`${origin}/mcp`)).resolves.toMatchObject({
        protectedResource: { resource: `${origin}/mcp` },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('normalizes bracketed IPv6 discovery hosts', async () => {
    await expect(discoverMcpAuthorization('http://[::1]:1/mcp', { timeoutMs: 25 })).rejects.toThrow(
      /discovery failed/,
    );
    await expect(
      discoverMcpAuthorization('http://127.0.0.1/mcp', { timeoutMs: 25 }),
    ).rejects.toThrow(/discovery failed/);
  });

  it('builds HTTPS pinned requests for IP and named token endpoints', async () => {
    const exchange = (tokenEndpoint: string) =>
      exchangeMcpAuthorizationCode({
        authorizationServer: {
          issuer: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint,
          scopesSupported: [],
        },
        clientId: 'client',
        redirectUri: 'https://client.example.com/callback',
        resource: 'https://mcp.example.com/mcp',
        code: 'code',
        codeVerifier: 'a'.repeat(43),
        timeoutMs: 1,
        lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      });

    await expect(exchange('https://8.8.8.8')).rejects.toThrow();
    await expect(exchange('https://token.example.com')).rejects.toThrow();
  });
});

describe('HTTP transport authorization provider', () => {
  it('refreshes after one 401 challenge and retries with the replacement token', async () => {
    const originalFetch = globalThis.fetch;
    const seenAuthorization: string[] = [];
    const seenProtocolVersion: Array<string | null> = [];
    let token = 'old-token';
    const handleUnauthorized = vi.fn<NonNullable<MCPAuthorizationProvider['handleUnauthorized']>>(
      async (challenge) => {
        expect(challenge).toMatchObject({
          resourceMetadataUrl: 'https://m.test/.well-known/oauth-protected-resource',
          scopes: ['tools:read'],
        });
        token = 'new-token';
        return true;
      },
    );
    const provider: MCPAuthorizationProvider = {
      getAccessToken: async ({ resource }) => ({ accessToken: token, resource }),
      handleUnauthorized,
    };
    let initializeCalls = 0;
    globalThis.fetch = vi.fn(async (_input, init) => {
      const headers = new Headers(init?.headers);
      seenAuthorization.push(headers.get('authorization') ?? '');
      seenProtocolVersion.push(headers.get('mcp-protocol-version'));
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.method === 'initialize') {
        initializeCalls += 1;
        if (initializeCalls === 1) {
          return new Response('unauthorized', {
            status: 401,
            headers: {
              'www-authenticate':
                'Bearer resource_metadata="https://m.test/.well-known/oauth-protected-resource", scope="tools:read"',
            },
          });
        }
        return Response.json({ jsonrpc: '2.0', id: body.id, result: INIT_RESULT });
      }
      if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [] } });
    }) as typeof fetch;

    try {
      const transport = new StreamableHTTPTransport({
        name: 'auth-server',
        url: 'https://m.test/mcp',
        authorizationProvider: provider,
      });
      await transport.connect();

      expect(handleUnauthorized).toHaveBeenCalledOnce();
      expect(initializeCalls).toBe(2);
      expect(seenAuthorization.slice(0, 2)).toEqual(['Bearer old-token', 'Bearer new-token']);
      expect(seenProtocolVersion.slice(0, 2)).toEqual([null, null]);
      expect(seenProtocolVersion.slice(2)).toEqual(['2025-06-18', '2025-06-18']);
      await transport.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('never retries a second 401 response', async () => {
    const originalFetch = globalThis.fetch;
    const handleUnauthorized = vi.fn(async () => true);
    const provider: MCPAuthorizationProvider = {
      getAccessToken: async ({ resource }) => ({ accessToken: 'token', resource }),
      handleUnauthorized,
    };
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const transport = new StreamableHTTPTransport({
        name: 'auth-server',
        url: 'https://m.test/mcp',
        authorizationProvider: provider,
      });
      await expect(transport.connect()).rejects.toThrow(/initialize HTTP 401/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(handleUnauthorized).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
