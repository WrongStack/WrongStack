import type { ProviderConfig } from '@wrongstack/contracts/types';
import {
  type AccountQuotaRefreshResult,
  readProviderAccountQuota,
  setChatGPTQuotaReporter,
} from './account-quota.js';
import {
  type CodexCliQuotaCredential,
  loadCodexCliQuotaCredential,
  readChatGPTQuotaViaCodexCli,
} from './codex-cli-quota.js';
import { makeProviderFromConfig, resolveActiveKeyEntry } from './provider-factory.js';
import { SubscriptionOAuthProvider } from './subscription-oauth.js';

let codexCliCredential: (() => Promise<CodexCliQuotaCredential | undefined>) | undefined;

/**
 * Let a direct `openai-chatgpt` account fall back to the Codex CLI's own login
 * (`~/.codex/auth.json`) for its quota read when no saved `openai-codex`
 * sign-in produced one. Host-only and off by default: a library consumer never
 * reads another tool's credentials it did not ask for. Pass `true` for the
 * standard location, a loader to override it, or `undefined` to turn it off.
 */
export function setCodexCliQuotaFallback(
  source: boolean | (() => Promise<CodexCliQuotaCredential | undefined>) | undefined,
): void {
  codexCliCredential =
    source === true
      ? () => loadCodexCliQuotaCredential()
      : typeof source === 'function'
        ? source
        : undefined;
}

export function setChatGPTQuotaProviders(
  load: (() => Promise<Record<string, ProviderConfig>>) | undefined,
): void {
  setChatGPTQuotaReporter(
    load
      ? async (provider) => {
          if (!(provider instanceof SubscriptionOAuthProvider)) return;
          const providers = await load();
          const cfg = Object.hasOwn(providers, provider.id) ? providers[provider.id] : undefined;
          if (!cfg) return;
          const key = resolveActiveKeyEntry(cfg);
          if (
            key?.apiKey !== provider.accountQuotaToken ||
            key.oauthClientId !== provider.chatGPTQuotaClientId
          )
            return;
          return readConfiguredProviderAccountQuota(provider.id, cfg, providers);
        }
      : undefined,
  );
}

/** Build saved selected credentials through normal renewal and persistence hooks. */
export async function readConfiguredProviderAccountQuota(
  providerId: string,
  cfg: ProviderConfig,
  providers: Readonly<Record<string, ProviderConfig>>,
): Promise<AccountQuotaRefreshResult | undefined> {
  const direct = (cfg.type ?? providerId) === 'openai-chatgpt';
  try {
    const provider = makeProviderFromConfig(providerId, {
      ...cfg,
      type: cfg.type ?? providerId,
      family: cfg.family ?? (direct ? 'openai' : 'openai-codex'),
    });
    const companions = direct
      ? Object.entries(providers).flatMap(([id, config]) => {
          if ((config.type ?? id) !== 'openai-codex' && config.family !== 'openai-codex') return [];
          try {
            return [
              makeProviderFromConfig(id, {
                ...config,
                type: config.type ?? id,
                family: config.family ?? 'openai-codex',
              }),
            ];
          } catch {
            return [];
          }
        })
      : [];
    const result = await readProviderAccountQuota(provider, { companions });
    if (result?.vendor !== 'chatgpt' || result.ok || !codexCliCredential) return result;
    const clientId =
      provider instanceof SubscriptionOAuthProvider ? provider.chatGPTQuotaClientId : undefined;
    const credential = clientId ? await codexCliCredential() : undefined;
    if (!clientId || !credential) return result;
    const snapshots = await readChatGPTQuotaViaCodexCli(providerId, clientId, credential);
    return { vendor: 'chatgpt', ok: snapshots.length > 0 };
  } catch {
    return { vendor: direct ? 'chatgpt' : 'codex', ok: false };
  }
}
