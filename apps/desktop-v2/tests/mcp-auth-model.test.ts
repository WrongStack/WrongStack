import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { McpAuthorization } from '../src/McpAuthorization';
import {
  mcpAuthScopes,
  mcpAuthStatus,
  mcpAuthSummary,
  safeAuthorizationUrl,
} from '../src/mcp-auth-model';

it('reads only the non-secret status the engine reports', () => {
  expect(mcpAuthStatus({ state: 'weird' })).toBeNull();
  expect(
    mcpAuthStatus({
      serverName: 'remote',
      state: 'authorized',
      expiresAt: 2_000,
      scopes: ['read'],
      canRefresh: true,
      accessToken: 'never-copied',
    }),
  ).toEqual({ state: 'authorized', expiresAt: 2_000, scopes: ['read'], canRefresh: true });
});

it('summarizes authorization, expiry and refresh honestly', () => {
  expect(mcpAuthSummary({ state: 'not_authorized', scopes: [], canRefresh: false })).toBe(
    'Not signed in.',
  );
  expect(
    mcpAuthSummary({ state: 'authorized', scopes: ['read'], canRefresh: false, expiresAt: 1 }, 5),
  ).toBe('Signed in with read. The access token has expired.');
  expect(mcpAuthSummary({ state: 'expired', scopes: [], canRefresh: true })).toBe(
    'The sign-in has expired. It can be refreshed without signing in again.',
  );
});

it('opens only https or loopback authorization pages', () => {
  expect(safeAuthorizationUrl('https://auth.example/authorize?x=1')).toBe(
    'https://auth.example/authorize?x=1',
  );
  expect(safeAuthorizationUrl('http://127.0.0.1:4000/authorize')).toBe(
    'http://127.0.0.1:4000/authorize',
  );
  expect(safeAuthorizationUrl('http://evil.example/authorize')).toBeNull();
  expect(safeAuthorizationUrl('javascript:alert(1)')).toBeNull();
  expect(safeAuthorizationUrl(42)).toBeNull();
  expect(mcpAuthScopes(' read,write  read ')).toEqual(['read', 'write']);
});

it('reads the status only when the panel is opened', () => {
  let calls = 0;
  const markup = renderToStaticMarkup(
    createElement(McpAuthorization, {
      name: 'remote',
      command: async () => {
        calls++;
        return {};
      },
    }),
  );
  expect(markup).toContain('Authorization');
  expect(calls).toBe(0);
});
