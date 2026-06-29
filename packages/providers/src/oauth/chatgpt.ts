/**
 * ChatGPT — "Sign in with ChatGPT" OAuth (Authorization Code + PKCE).
 *
 * Headless port of the CLI's `openai-codex-oauth.ts` terminal flow. Drives the
 * loopback authorization-code exchange and returns a persistence-agnostic
 * {@link OAuthLoginOutcome}. See the CLI module's header for the protocol
 * rationale (ChatGPT backend, JWT account-id claim, etc.).
 */

import {
  CODEX_MODELS,
  FetchError,
  type ModelsRegistry,
  ParseError,
  type ProviderApiKey,
} from '@wrongstack/core';
import { extractAccountId } from '../openai-codex.js';
import {
  createState,
  generatePkce,
  type LoopbackServer,
  parseAuthorizationInput,
  startLoopbackServer,
} from './shared.js';
import type { BeginOAuthDeps, OAuthLoginOutcome, OAuthSession } from './types.js';

// ── Codex OAuth constants (verified against the real Codex CLI) ─────────────

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE_URL = 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const REDIRECT_PORT = 1455;
const REDIRECT_HOST = '127.0.0.1';
const REDIRECT_PATH = '/auth/callback';
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}${REDIRECT_PATH}`;
const SCOPE = 'openid profile email offline_access';
const ORIGINATOR = 'wrongstack';
export const CODEX_PROVIDER_ID = 'openai-codex';
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';

interface CodexTokens {
  access: string;
  refresh: string;
  /** Absolute expiry in epoch milliseconds. */
  expires: number;
}

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

/** Build the full authorize URL with all Codex-required query params. */
export function buildCodexAuthorizeUrl(challenge: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', ORIGINATOR);
  return url.toString();
}

// ── Model discovery (live backend → catalog → inline fallback) ────────────────

const FALLBACK_CODEX_MODELS: ReadonlyArray<{ id: string; name: string }> = CODEX_MODELS.map(
  (m) => ({
    id: m.id,
    name: m.name,
  }),
);
const CODEX_CATALOG_FAMILIES = new Set(['gpt-codex', 'gpt-codex-spark']);

export function filterCurrentCodexModelIds(ids: Iterable<string>): string[] {
  const available = new Set(ids);
  return FALLBACK_CODEX_MODELS.map((m) => m.id).filter((id) => available.has(id));
}

async function fetchCodexModels(
  accessToken: string,
  baseUrl?: string | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  const url = `${(baseUrl ?? CODEX_BASE_URL).replace(/\/+$/, '')}/models`;
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        originator: 'wrongstack',
        'OpenAI-Beta': 'responses=experimental',
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(8_000)])
        : AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as
      | { data?: Array<{ id?: string }> }
      | { models?: Array<{ id?: string }> }
      | null;
    if (!json) return [];
    const rawList: unknown[] =
      'data' in json && Array.isArray(json.data)
        ? (json.data as unknown[])
        : 'models' in json && Array.isArray(json.models)
          ? (json.models as unknown[])
          : [];
    const ids: string[] = [];
    for (const entry of rawList) {
      if (!entry || typeof entry !== 'object') continue;
      const id = (entry as Record<string, unknown>).id;
      if (typeof id === 'string' && id.length > 0) ids.push(id);
    }
    return ids;
  } catch {
    return [];
  }
}

async function resolveCodexModels(
  modelsRegistry: ModelsRegistry | undefined,
  accessToken: string,
  signal?: AbortSignal,
): Promise<string[]> {
  // Tier 1 — live backend
  const live = filterCurrentCodexModelIds(
    await fetchCodexModels(accessToken, CODEX_BASE_URL, signal),
  );
  if (live.length > 0) return live;

  // Tier 2 — models.dev catalog (best-effort; registry is optional)
  if (modelsRegistry) {
    try {
      const openaiProvider = await modelsRegistry.getProvider('openai');
      if (openaiProvider) {
        const catalog = openaiProvider.models
          .filter((m) => typeof m.family === 'string' && CODEX_CATALOG_FAMILIES.has(m.family))
          .map((m) => m.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        const currentCatalog = filterCurrentCodexModelIds(catalog);
        if (currentCatalog.length > 0) return currentCatalog;
      }
    } catch {
      /* catalog unavailable — fall through */
    }
  }

  // Tier 3 — inline fallback
  return FALLBACK_CODEX_MODELS.map((m) => m.id);
}

// ── Token exchange ────────────────────────────────────────────────────────────

async function readTokens(res: Response, op: string): Promise<CodexTokens> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new FetchError({
      message: `Codex token ${op} failed (${res.status}): ${text || res.statusText}`,
      status: res.status,
      context: { provider: 'openai-codex', op, url: TOKEN_URL },
    });
  }
  const json = (await res.json()) as TokenEndpointResponse | null;
  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new ParseError({
      message: `Codex token ${op} response missing fields`,
      source: 'openai-codex-token-response',
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
  verifier: string,
  signal?: AbortSignal,
): Promise<CodexTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }).toString(),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  return readTokens(res, 'exchange');
}

// ── Outcome assembly ──────────────────────────────────────────────────────────

async function buildOutcome(
  deps: BeginOAuthDeps | undefined,
  tokens: CodexTokens,
  signal?: AbortSignal,
): Promise<OAuthLoginOutcome> {
  const accountId = extractAccountId(tokens.access);
  if (!accountId) {
    throw new ParseError({
      message:
        'Signed in, but the token has no ChatGPT account id. This account may lack Codex/ChatGPT subscription access.',
      source: 'openai-codex-token-response',
    });
  }
  const models = await resolveCodexModels(deps?.modelsRegistry, tokens.access, signal);
  const apiKey: ProviderApiKey = {
    label: 'oauth-default',
    apiKey: tokens.access,
    createdAt: new Date().toISOString(),
    authMethod: 'oauth',
    expiresAt: new Date(tokens.expires).toISOString(),
    refreshToken: tokens.refresh,
    tokenType: 'bearer',
    scope: SCOPE,
    accountId,
  };
  return {
    providerId: CODEX_PROVIDER_ID,
    family: 'openai-codex',
    baseUrl: CODEX_BASE_URL,
    models,
    apiKey,
  };
}

// ── Session factory ────────────────────────────────────────────────────────────

export async function beginChatGPTLogin(
  deps: BeginOAuthDeps | undefined,
  signal?: AbortSignal,
): Promise<OAuthSession> {
  const pkce = generatePkce();
  const state = createState();
  const authorizeUrl = buildCodexAuthorizeUrl(pkce.challenge, state);

  const server: LoopbackServer = await startLoopbackServer({
    port: REDIRECT_PORT,
    host: REDIRECT_HOST,
    path: REDIRECT_PATH,
    expectedState: state,
    signal,
  });

  return {
    kind: 'chatgpt',
    providerId: CODEX_PROVIDER_ID,
    bound: server.bound,
    authorizeUrl,
    async waitForCompletion(waitSignal?: AbortSignal): Promise<OAuthLoginOutcome | null> {
      if (!server.bound) return null;
      const got = await server.waitForCode();
      if (!got?.code) return null;
      const tokens = await exchangeAuthorizationCode(got.code, pkce.verifier, waitSignal ?? signal);
      return buildOutcome(deps, tokens, waitSignal ?? signal);
    },
    async completeWithCode(input: string, codeSignal?: AbortSignal): Promise<OAuthLoginOutcome> {
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== state) {
        throw new Error('State mismatch — please restart the login flow.');
      }
      if (!parsed.code) throw new Error('No authorization code found in the pasted value.');
      const tokens = await exchangeAuthorizationCode(
        parsed.code,
        pkce.verifier,
        codeSignal ?? signal,
      );
      return buildOutcome(deps, tokens, codeSignal ?? signal);
    },
    close(): void {
      server.close();
    },
  };
}
