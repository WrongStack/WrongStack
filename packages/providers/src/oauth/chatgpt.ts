/**
 * ChatGPT — "Sign in with ChatGPT" OAuth (Authorization Code + PKCE).
 *
 * The headless half of the flow: drives the loopback authorization-code
 * exchange and returns a persistence-agnostic {@link OAuthLoginOutcome}, so
 * both WebUI servers can sign in over a WebSocket with no terminal IO.
 *
 * The wire protocol itself (client id, endpoints, request bodies, response
 * validation) lives in `./codex-protocol.js` and model discovery in
 * `./codex-models.js` — shared with the CLI terminal flow and the runtime
 * provider's refresh path, which used to keep their own copies.
 */

import { ParseError, type ProviderApiKey } from '@wrongstack/core/types';
import { extractAccountId } from '../openai-codex-account.js';
import { resolveCodexModels } from './codex-models.js';
import {
  buildCodexAuthorizeUrl,
  CODEX_BASE_URL,
  CODEX_FALLBACK_REDIRECT_PORT,
  CODEX_PROVIDER_ID,
  CODEX_REDIRECT_HOST,
  CODEX_REDIRECT_PATH,
  CODEX_REDIRECT_PORT,
  CODEX_SCOPE,
  type CodexTokens,
  exchangeCodexAuthorizationCode,
} from './codex-protocol.js';
import {
  createState,
  generatePkce,
  type LoopbackServer,
  parseAuthorizationInput,
  startLoopbackServer,
} from './shared.js';
import type { BeginOAuthDeps, OAuthLoginOutcome, OAuthSession } from './types.js';

export { buildCodexAuthorizeUrl, CODEX_BASE_URL, CODEX_PROVIDER_ID } from './codex-protocol.js';
export { filterCurrentCodexModelIds } from './codex-models.js';

// ── Outcome assembly ──────────────────────────────────────────────────────────

async function buildOutcome(
  deps: BeginOAuthDeps | undefined,
  tokens: CodexTokens,
  signal?: AbortSignal,
): Promise<OAuthLoginOutcome> {
  const accountId =
    extractAccountId(tokens.access) ?? (tokens.idToken ? extractAccountId(tokens.idToken) : null);
  if (!accountId) {
    throw new ParseError({
      message:
        'Signed in, but the token has no ChatGPT account id. This account may lack Codex/ChatGPT subscription access.',
      source: 'openai-codex-token-response',
    });
  }
  const models = await resolveCodexModels(
    deps?.modelsRegistry,
    tokens.access,
    CODEX_BASE_URL,
    signal,
  );
  const apiKey: ProviderApiKey = {
    label: 'oauth-default',
    apiKey: tokens.access,
    createdAt: new Date().toISOString(),
    authMethod: 'oauth',
    expiresAt: new Date(tokens.expires).toISOString(),
    refreshToken: tokens.refresh,
    tokenType: 'bearer',
    scope: CODEX_SCOPE,
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

  const server: LoopbackServer = await startLoopbackServer({
    port: CODEX_REDIRECT_PORT,
    fallbackPorts: [CODEX_FALLBACK_REDIRECT_PORT],
    host: CODEX_REDIRECT_HOST,
    path: CODEX_REDIRECT_PATH,
    expectedState: state,
    signal,
  });
  const authorizeUrl = buildCodexAuthorizeUrl(pkce.challenge, state, server.port);

  return {
    kind: 'chatgpt',
    providerId: CODEX_PROVIDER_ID,
    bound: server.bound,
    authorizeUrl,
    async waitForCompletion(waitSignal?: AbortSignal): Promise<OAuthLoginOutcome | null> {
      if (!server.bound) return null;
      const got = await server.waitForCode();
      if (!got?.code) return null;
      const tokens = await exchangeCodexAuthorizationCode(
        got.code,
        pkce.verifier,
        waitSignal ?? signal,
        server.port,
      );
      return buildOutcome(deps, tokens, waitSignal ?? signal);
    },
    async completeWithCode(input: string, codeSignal?: AbortSignal): Promise<OAuthLoginOutcome> {
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== state) {
        throw new Error('State mismatch — please restart the login flow.');
      }
      if (!parsed.code) throw new Error('No authorization code found in the pasted value.');
      const tokens = await exchangeCodexAuthorizationCode(
        parsed.code,
        pkce.verifier,
        codeSignal ?? signal,
        server.port,
      );
      return buildOutcome(deps, tokens, codeSignal ?? signal);
    },
    close(): void {
      server.close();
    },
  };
}
