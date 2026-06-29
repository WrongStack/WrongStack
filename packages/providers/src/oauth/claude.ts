/**
 * Claude — "Sign in with Claude" OAuth (Authorization Code + PKCE), Claude
 * Pro/Max subscription login. Headless port of the CLI's `anthropic-oauth.ts`.
 *
 * Anthropic quirks: authorize at claude.ai/oauth/authorize (`code=true`), the
 * OAuth `state` IS the PKCE verifier, JSON token exchange at
 * platform.claude.com/v1/oauth/token, loopback callback on :53692/callback.
 */

import { FetchError, ParseError, type ProviderApiKey } from '@wrongstack/core';
import {
  generatePkce,
  type LoopbackServer,
  parseAuthorizationInput,
  startLoopbackServer,
} from './shared.js';
import type { BeginOAuthDeps, OAuthLoginOutcome, OAuthSession } from './types.js';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const REDIRECT_PORT = 53692;
const REDIRECT_HOST = '127.0.0.1';
const REDIRECT_PATH = '/callback';
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}${REDIRECT_PATH}`;
const SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
export const CLAUDE_PROVIDER_ID = 'anthropic-oauth';
const CLAUDE_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_CLAUDE_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-8'];

interface ClaudeTokens {
  access: string;
  refresh: string;
  expires: number;
}

/** Build the Claude authorize URL. Anthropic uses the PKCE verifier as `state`. */
export function buildClaudeAuthorizeUrl(challenge: string, verifier: string): string {
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenJson {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

async function readTokens(res: Response, op: string): Promise<ClaudeTokens> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new FetchError({
      message: `Claude token ${op} failed (${res.status}): ${text || res.statusText}`,
      status: res.status,
      context: { provider: 'anthropic-oauth', op, url: TOKEN_URL },
    });
  }
  const json = (await res.json()) as TokenJson | null;
  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new ParseError({
      message: `Claude token ${op} response missing fields`,
      source: 'anthropic-oauth-token-response',
      context: { op },
    });
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

async function exchangeAuthorizationCode(
  code: string,
  state: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<ClaudeTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  return readTokens(res, 'exchange');
}

async function fetchClaudeModels(accessToken: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const res = await fetch(`${CLAUDE_BASE_URL}/v1/models?limit=100`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(8_000)])
        : AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id?: string }> } | null;
    return (json?.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.startsWith('claude-'));
  } catch {
    return [];
  }
}

async function buildOutcome(
  tokens: ClaudeTokens,
  signal?: AbortSignal,
): Promise<OAuthLoginOutcome> {
  const fetched = await fetchClaudeModels(tokens.access, signal);
  const models = fetched.length > 0 ? fetched : DEFAULT_CLAUDE_MODELS;
  const apiKey: ProviderApiKey = {
    label: 'oauth-default',
    apiKey: tokens.access,
    createdAt: new Date().toISOString(),
    authMethod: 'oauth',
    expiresAt: new Date(tokens.expires).toISOString(),
    refreshToken: tokens.refresh,
    tokenType: 'bearer',
    scope: SCOPES,
  };
  return {
    providerId: CLAUDE_PROVIDER_ID,
    family: 'anthropic-oauth',
    baseUrl: CLAUDE_BASE_URL,
    models,
    apiKey,
  };
}

export async function beginClaudeLogin(
  _deps: BeginOAuthDeps | undefined,
  signal?: AbortSignal,
): Promise<OAuthSession> {
  const { verifier, challenge } = generatePkce();
  // Anthropic reuses the PKCE verifier as the OAuth state.
  const state = verifier;
  const authorizeUrl = buildClaudeAuthorizeUrl(challenge, verifier);

  const server: LoopbackServer = await startLoopbackServer({
    port: REDIRECT_PORT,
    host: REDIRECT_HOST,
    path: REDIRECT_PATH,
    expectedState: state,
    signal,
  });

  return {
    kind: 'claude',
    providerId: CLAUDE_PROVIDER_ID,
    bound: server.bound,
    authorizeUrl,
    async waitForCompletion(waitSignal?: AbortSignal): Promise<OAuthLoginOutcome | null> {
      if (!server.bound) return null;
      const got = await server.waitForCode();
      if (!got?.code) return null;
      const tokens = await exchangeAuthorizationCode(
        got.code,
        state,
        verifier,
        waitSignal ?? signal,
      );
      return buildOutcome(tokens, waitSignal ?? signal);
    },
    async completeWithCode(input: string, codeSignal?: AbortSignal): Promise<OAuthLoginOutcome> {
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== state) {
        throw new Error('State mismatch — please restart the login flow.');
      }
      if (!parsed.code) throw new Error('No authorization code found in the pasted value.');
      const tokens = await exchangeAuthorizationCode(
        parsed.code,
        state,
        verifier,
        codeSignal ?? signal,
      );
      return buildOutcome(tokens, codeSignal ?? signal);
    },
    close(): void {
      server.close();
    },
  };
}
