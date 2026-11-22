import { describe, expect, it } from 'vitest';
import {
  createMcpAuthorizationRequest,
  parseAuthorizationServerMetadata,
  validateMcpAuthorizationServerMetadata,
} from '../src/authorization.js';
import { secureOAuthUrl } from '../src/authorization-discovery.js';

// F1054: RFC 6749 §3.1/§3.2 — the authorization and token endpoints may carry
// a query component (Azure AD B2C names its policy as `?p=…`) that must be
// retained when the client adds its own parameters.
describe('OAuth endpoint query components', () => {
  const metadata = parseAuthorizationServerMetadata(
    {
      issuer: 'https://auth.example.com/tenant',
      authorization_endpoint: 'https://auth.example.com/tenant/authorize?p=b2c_1_signin',
      token_endpoint: 'https://auth.example.com/tenant/token?p=b2c_1_signin',
      code_challenge_methods_supported: ['S256'],
    },
    'https://auth.example.com/tenant',
  );

  it('accepts and keeps an endpoint query through discovery and persistence', () => {
    expect(metadata.authorizationEndpoint).toBe(
      'https://auth.example.com/tenant/authorize?p=b2c_1_signin',
    );
    expect(metadata.tokenEndpoint).toBe('https://auth.example.com/tenant/token?p=b2c_1_signin');
    expect(validateMcpAuthorizationServerMetadata(metadata)).toMatchObject({
      authorizationEndpoint: metadata.authorizationEndpoint,
      tokenEndpoint: metadata.tokenEndpoint,
    });
  });

  it('retains the endpoint query in the authorization URL', () => {
    const session = createMcpAuthorizationRequest({
      authorizationServer: metadata,
      clientId: 'client-1',
      redirectUri: 'http://127.0.0.1:8123/callback',
      resource: 'https://mcp.example.com/mcp',
    });
    const url = new URL(session.authorizationUrl);
    expect(url.searchParams.get('p')).toBe('b2c_1_signin');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('keeps a query on an origin-path endpoint and still refuses it where not allowed', () => {
    expect(secureOAuthUrl('https://auth.example.com/?p=x', 'token endpoint', true).toString()).toBe(
      'https://auth.example.com/?p=x',
    );
    expect(() => secureOAuthUrl('https://auth.example.com/?p=x', 'issuer')).toThrow(
      /must not contain credentials, query, or fragment/,
    );
    expect(() =>
      secureOAuthUrl('https://auth.example.com/t?p=x#f', 'token endpoint', true),
    ).toThrow(/must not contain credentials, query, or fragment/);
  });
});
