import type { ProviderConfig } from '@wrongstack/contracts/types';
import {
  applyProviderOAuthRefresh,
  createSubscriptionRefreshTransaction,
  matchesActiveProviderCredential,
  setAccountQuotaReporting,
  setChatGPTQuotaProviders,
  setOAuthTokenPersister,
  setProviderModelPersister,
  setSubscriptionRefreshTransaction,
} from '@wrongstack/providers';

/** Standalone hosts must persist rotations as well as interactive login outcomes. */
export function installWebuiProviderPersisters(args: {
  load?: () => Promise<Record<string, ProviderConfig>>;
  mutate: (
    mutator: (providers: Record<string, ProviderConfig>) => void | Promise<void>,
  ) => Promise<void>;
  warn: (message: string) => void;
}): void {
  // Post-turn plan-quota reads (Kimi Code, OpenCode Go, OpenRouter); host-only.
  setAccountQuotaReporting(true);
  setChatGPTQuotaProviders(args.load);
  setSubscriptionRefreshTransaction(createSubscriptionRefreshTransaction(args.mutate));
  setOAuthTokenPersister((id, creds, source) => {
    void args
      .mutate((providers) => {
        if (Object.hasOwn(providers, id)) applyProviderOAuthRefresh(providers[id]!, creds, source);
      })
      .catch(() =>
        args.warn(
          `OAuth token refresh for "${id}" could not be saved. Sign-in may be required next session.`,
        ),
      );
  });
  setProviderModelPersister((id, models, source) => {
    void args
      .mutate((providers) => {
        const provider = Object.hasOwn(providers, id) ? providers[id] : undefined;
        if (!provider || (source && !matchesActiveProviderCredential(provider, source))) return;
        provider.models = models.map((model) => model.id);
      })
      .catch(() => args.warn(`Model discovery for "${id}" could not be saved.`));
  });
}
