import { beginChatGPTLogin } from './chatgpt.js';
import { beginClaudeLogin } from './claude.js';
import { beginCopilotLogin } from './copilot.js';
import type { BeginOAuthDeps, OAuthKind, OAuthSession } from './types.js';

/** Canonical provider id each historical login kind stores its credential under. */
export const OAUTH_PROVIDER_IDS: Record<OAuthKind, string> = {
  chatgpt: 'openai-codex',
  claude: 'anthropic-oauth',
  copilot: 'github-copilot',
};

/** Compatibility dispatcher retained for callers using the pre-registry API. */
export function beginOAuthLogin(
  kind: OAuthKind,
  deps?: BeginOAuthDeps,
  signal?: AbortSignal,
): Promise<OAuthSession> {
  if (kind === 'chatgpt') return beginChatGPTLogin(deps, signal);
  if (kind === 'claude') return beginClaudeLogin(deps, signal);
  if (kind === 'copilot') return beginCopilotLogin(deps, signal);
  return Promise.reject(new Error(`Unknown OAuth kind: ${String(kind)}`));
}
