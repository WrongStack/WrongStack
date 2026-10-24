import type { ProviderConfig } from '@wrongstack/contracts/types';
import {
  type AccountQuotaRefreshResult,
  readProviderAccountQuota,
  setChatGPTQuotaReporter,
} from './account-quota.js';
import { makeProviderFromConfig, resolveActiveKeyEntry } from './provider-factory.js';
import { SubscriptionOAuthProvider } from './subscription-oauth.js';

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
    return await readProviderAccountQuota(provider, { companions });
  } catch {
    return { vendor: direct ? 'chatgpt' : 'codex', ok: false };
  }
}
