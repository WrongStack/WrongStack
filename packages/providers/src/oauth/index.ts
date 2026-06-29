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

export { buildCodexAuthorizeUrl, CODEX_BASE_URL, CODEX_PROVIDER_ID } from './chatgpt.js';
export { buildClaudeAuthorizeUrl, CLAUDE_PROVIDER_ID } from './claude.js';
export { COPILOT_PROVIDER_ID, isUsableCopilotChatModel } from './copilot.js';
export {
  generatePkce,
  type LoopbackServer,
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
