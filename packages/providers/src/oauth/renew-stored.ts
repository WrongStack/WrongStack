/**
 * Renew a stored OAuth account with its own refresh token, whichever sign-in
 * made it — the one switch a host that refreshes centrally (the HQ key vault)
 * calls, instead of building a provider just to renew its credential.
 *
 * `signIn` is the strategy id the account came from (`chatgpt`, `copilot`,
 * `xai`, `kimi`, `meta`, `chatgpt-api`). Returns `undefined` when the account
 * cannot be renewed here (no refresh token, or a sign-in that needs host
 * configuration such as Antigravity's OAuth client) and a credential that
 * needs no renewal (OpenRouter's key has no expiry) is never passed in.
 */
import type { ProviderApiKey } from '@wrongstack/contracts/types';
import { refreshCopilotToken } from '../github-copilot-token.js';
import { extractAccountId } from '../openai-codex-account.js';
import { refreshChatGPTDirect } from './chatgpt-direct.js';
import { refreshCodexTokens } from './codex-protocol.js';
import { refreshDeviceSubscription } from './subscription-flows.js';

/** Sign-ins {@link renewStoredOAuthCredential} can renew. */
export const RENEWABLE_SIGN_INS: ReadonlySet<string> = new Set([
  'chatgpt',
  'copilot',
  'xai',
  'kimi',
  'meta',
  'chatgpt-api',
  // OpenRouter's sign-in yields a plain key without an expiry: nothing to renew.
  'openrouter',
]);

export async function renewStoredOAuthCredential(
  credential: ProviderApiKey,
  signIn: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<ProviderApiKey | undefined> {
  const refreshToken = credential.refreshToken;
  if (!refreshToken) return undefined;
  switch (signIn) {
    case 'chatgpt': {
      const tokens = await refreshCodexTokens(refreshToken, opts.signal);
      return {
        ...credential,
        apiKey: tokens.access,
        refreshToken: tokens.refresh,
        expiresAt: new Date(tokens.expires).toISOString(),
        accountId: extractAccountId(tokens.access) ?? credential.accountId,
        ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
      };
    }
    case 'copilot': {
      // The GitHub token does not rotate; it mints a short-lived Copilot token.
      const copilot = await refreshCopilotToken(refreshToken, opts.signal);
      return {
        ...credential,
        apiKey: copilot.token,
        expiresAt: new Date(copilot.expires).toISOString(),
      };
    }
    case 'xai':
    case 'kimi':
    case 'meta':
      return refreshDeviceSubscription(
        { ...credential, oauthStrategyId: signIn },
        opts.fetchImpl,
        opts.signal,
      );
    case 'chatgpt-api':
      return refreshChatGPTDirect(
        { ...credential, oauthStrategyId: signIn },
        opts.fetchImpl,
        opts.signal,
      );
    default:
      return undefined;
  }
}
