/**
 * Headless OAuth login engine — drives a subscription sign-in (ChatGPT /
 * Claude / Copilot) to completion and returns a persistence-agnostic
 * {@link OAuthLoginOutcome}. Shared by the CLI auth-menu (terminal IO) and
 * both WebUI servers (WebSocket IO). Neither opens a browser nor writes config
 * — that is the caller's job.
 */

export { extractAccountId } from '../openai-codex-account.js';
export {
  type ApplyProviderAuthOutcomeOptions,
  applyProviderAuthOutcome,
} from './apply-outcome.js';
export { createOpenRouterAuthStrategy } from './openrouter.js';
export { beginOAuthLogin, OAUTH_PROVIDER_IDS } from './legacy.js';
export {
  BUILTIN_PROVIDER_AUTH_STRATEGIES,
  createBuiltinProviderAuthRegistry,
  registerBuiltinProviderAuthStrategies,
} from './builtin-strategies.js';
export { buildClaudeAuthorizeUrl, CLAUDE_PROVIDER_ID } from './claude.js';
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
  CODEX_CLIENT_VERSION,
  CODEX_FALLBACK_REDIRECT_PORT,
  CODEX_ORIGINATOR,
  CODEX_PROVIDER_ID,
  CODEX_REDIRECT_HOST,
  CODEX_REDIRECT_PATH,
  CODEX_REDIRECT_PORT,
  CODEX_SCOPE,
  CODEX_TOKEN_URL,
  CODEX_USER_AGENT,
  type CodexTokens,
  codexRedirectUri,
  exchangeCodexAuthorizationCode,
  readCodexTokenResponse,
  refreshCodexTokens,
} from './codex-protocol.js';
export { COPILOT_PROVIDER_ID, isUsableCopilotChatModel } from './copilot.js';
export {
  base64url,
  callbackHtml,
  createState,
  generatePkce,
  type LoopbackOptions,
  type LoopbackServer,
  type Pkce,
  parseAuthorizationInput,
  startLoopbackServer,
} from './shared.js';
export type {
  BeginOAuthDeps,
  OAuthKind,
  OAuthLoginOutcome,
  OAuthPhase,
  OAuthSession,
} from './types.js';
