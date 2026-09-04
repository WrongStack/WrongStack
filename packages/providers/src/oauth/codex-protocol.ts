/**
 * Codex / "Sign in with ChatGPT" — the OAuth wire protocol, in one place.
 *
 * This existed three times: the CLI terminal flow
 * (`packages/cli/src/auth-menu/openai-codex-oauth.ts`), the headless WebUI
 * flow (`./chatgpt.ts`), and the runtime provider's refresh path
 * (`../openai-codex.ts`, whose header said in as many words "mirror packages/cli
 * auth-menu/openai-codex-oauth"). Three copies of the same client id, token
 * endpoint, request bodies, and response validation.
 *
 * That is not a style problem. The abort-listener leak fixed in 2026-08 was
 * present in two of the three copies and absent from the one that had already
 * been corrected — the copies drift silently because nothing makes them agree.
 * A rotated client id or a changed token-endpoint contract would have to be
 * found and applied three times, and being wrong in one of them means one
 * surface silently stops authenticating.
 *
 * Placement: `oauth/` rather than beside the provider, and deliberately free of
 * any import from `../openai-codex.js`. `openai-codex-account.ts` was already
 * split out so the OAuth entry could derive an account id "without bundling the
 * whole Codex provider"; this module keeps that direction — the provider
 * imports the protocol, never the reverse. Model discovery lives separately in
 * `./codex-models.ts` so the provider does not pull the models catalog in just
 * to refresh a token.
 *
 * @module oauth/codex-protocol
 */

import { FetchError, ParseError } from '@wrongstack/core/types';

// ── Constants (verified against the real Codex CLI) ─────────────────────────

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_AUTH_BASE_URL = 'https://auth.openai.com';
export const CODEX_AUTHORIZE_URL = `${CODEX_AUTH_BASE_URL}/oauth/authorize`;
export const CODEX_TOKEN_URL = `${CODEX_AUTH_BASE_URL}/oauth/token`;
export const CODEX_REDIRECT_PORT = 1455;
export const CODEX_FALLBACK_REDIRECT_PORT = 1457;
export const CODEX_REDIRECT_HOST = '127.0.0.1';
export const CODEX_REDIRECT_PATH = '/auth/callback';
export const CODEX_SCOPE =
  'openid profile email offline_access api.connectors.read api.connectors.invoke';
/** Telemetry/branding tag sent to authorize + as a request header. Free-form. */
export const CODEX_ORIGINATOR = 'wrongstack';
/** Canonical provider id under which ChatGPT-login credentials are stored. */
export const CODEX_PROVIDER_ID = 'openai-codex';
/** Default ChatGPT backend base. The wire family appends `/codex/responses`. */
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';

/** Request timeout for the token endpoint, in milliseconds. */
const TOKEN_TIMEOUT_MS = 30_000;

// ── Authorize URL ───────────────────────────────────────────────────────────

export function codexRedirectUri(port: number): string {
  return `http://localhost:${port}${CODEX_REDIRECT_PATH}`;
}

/** Build the full authorize URL with all Codex-required query params. */
export function buildCodexAuthorizeUrl(
  challenge: string,
  state: string,
  port = CODEX_REDIRECT_PORT,
): string {
  const url = new URL(CODEX_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CODEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', codexRedirectUri(port));
  url.searchParams.set('scope', CODEX_SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', CODEX_ORIGINATOR);
  return url.toString();
}

// ── Token endpoint ──────────────────────────────────────────────────────────

export interface CodexTokens {
  access: string;
  refresh: string;
  /** Absolute expiry in epoch milliseconds. */
  expires: number;
  idToken?: string | undefined;
}

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

/**
 * Validate a token-endpoint response into {@link CodexTokens}.
 *
 * The real status is preserved on the thrown {@link FetchError}: `recoverable`
 * is derived from it (429/5xx → true), so collapsing a transient 503 into a
 * fixed 401 made callers drop the credential and force a re-login instead of
 * retrying. The provider's own copy of this had already learned that; the
 * shared version keeps the lesson.
 */
export async function readCodexTokenResponse(res: Response, op: string): Promise<CodexTokens> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new FetchError({
      message: `Codex token ${op} failed (${res.status}): ${text || res.statusText}`,
      status: res.status,
      context: { provider: CODEX_PROVIDER_ID, op, url: CODEX_TOKEN_URL },
    });
  }
  const json = (await res.json()) as TokenEndpointResponse | null;
  if (
    !json?.access_token ||
    !json.refresh_token ||
    typeof json.expires_in !== 'number' ||
    !Number.isFinite(json.expires_in) ||
    json.expires_in <= 0
  ) {
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
    idToken: json.id_token,
  };
}

/** Exchange an authorization code (+ PKCE verifier) for tokens. */
export async function exchangeCodexAuthorizationCode(
  code: string,
  verifier: string,
  signal?: AbortSignal,
  port = CODEX_REDIRECT_PORT,
): Promise<CodexTokens> {
  const res = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: codexRedirectUri(port),
    }).toString(),
    signal: withTimeout(signal, TOKEN_TIMEOUT_MS),
  });
  return readCodexTokenResponse(res, 'exchange');
}

/**
 * Refresh an expired access token using the stored refresh token. Codex
 * rotates the refresh token on every refresh, so the caller must persist the
 * returned `refresh` value, not the one it passed in.
 */
export async function refreshCodexTokens(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<CodexTokens> {
  const res = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CODEX_CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
    signal: withTimeout(signal, TOKEN_TIMEOUT_MS),
  });
  return readCodexTokenResponse(res, 'refresh');
}
