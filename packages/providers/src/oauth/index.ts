/**
 * Headless OAuth login engine — drives a subscription sign-in (ChatGPT /
 * Claude / Copilot) to completion and returns a persistence-agnostic
 * {@link OAuthLoginOutcome}. Shared by the CLI auth-menu (terminal IO) and
 * both WebUI servers (WebSocket IO). Neither opens a browser nor writes config
 * — that is the caller's job.
 */

import { beginChatGPTLogin } from './chatgpt.js';
import { beginClaudeLogin } from './claude.js';
import { beginCopilotLogin } from './copilot.js';
import type { BeginOAuthDeps, OAuthKind, OAuthSession } from './types.js';

/**
 * Codex / "Sign in with ChatGPT" wire protocol — the single definition, shared
 * by the CLI terminal flow (`cli/src/auth-menu/openai-codex-oauth.ts`), the
 * headless flow (`./chatgpt.ts`), and the runtime provider's refresh path
 * (`../openai-codex.ts`). All three used to carry their own copy.
 */
export {
  buildCodexAuthorizeUrl,
  CODEX_AUTH_BASE_URL,
  CODEX_AUTHORIZE_URL,
  CODEX_BASE_URL,
  CODEX_CLIENT_ID,
  CODEX_FALLBACK_REDIRECT_PORT,
  CODEX_ORIGINATOR,
  CODEX_PROVIDER_ID,
  CODEX_REDIRECT_HOST,
  CODEX_REDIRECT_PATH,
  CODEX_REDIRECT_PORT,
  CODEX_SCOPE,
  CODEX_TOKEN_URL,
  type CodexTokens,
  codexRedirectUri,
  exchangeCodexAuthorizationCode,
  readCodexTokenResponse,
  refreshCodexTokens,
} from './codex-protocol.js';
export {
  CODEX_CATALOG_FAMILIES,
  FALLBACK_CODEX_MODELS,
  fallbackCodexModelIds,
  fallbackCodexProviderModels,
  fetchCodexModels,
  filterCurrentCodexModelIds,
  isCodexCatalogModel,
  resolveCodexModels,
} from './codex-models.js';
export { extractAccountId } from '../openai-codex-account.js';
export { buildClaudeAuthorizeUrl, CLAUDE_PROVIDER_ID } from './claude.js';
export { COPILOT_PROVIDER_ID, isUsableCopilotChatModel } from './copilot.js';
export {
  base64url,
  callbackHtml,
  createState,
  generatePkce,
  type LoopbackOptions,
  type LoopbackServer,
  parseAuthorizationInput,
  type Pkce,
  startLoopbackServer,
} from './shared.js';
export type {
  BeginOAuthDeps,
  OAuthKind,
  OAuthLoginOutcome,
  OAuthPhase,
  OAuthSession,
} from './types.js';

/** Canonical provider id each login kind stores its credential under. */
export const OAUTH_PROVIDER_IDS: Record<OAuthKind, string> = {
  chatgpt: 'openai-codex',
  claude: 'anthropic-oauth',
  copilot: 'github-copilot',
};

/**
 * Begin a subscription OAuth login. Returns a {@link OAuthSession} that is
 * already listening (loopback flows) or carries the device code (copilot),
 * so the caller can surface the authorize URL / user code immediately, then
 * `await session.waitForCompletion()`.
 */
export function beginOAuthLogin(
  kind: OAuthKind,
  deps?: BeginOAuthDeps,
  signal?: AbortSignal,
): Promise<OAuthSession> {
  switch (kind) {
    case 'chatgpt':
      return beginChatGPTLogin(deps, signal);
    case 'claude':
      return beginClaudeLogin(deps, signal);
    case 'copilot':
      return beginCopilotLogin(deps, signal);
    default: {
      const exhaustive: never = kind;
      return Promise.reject(new Error(`Unknown OAuth kind: ${String(exhaustive)}`));
    }
  }
}
