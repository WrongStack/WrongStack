import type { ProviderConfig } from '@wrongstack/contracts/types';
import { type HqCredentialService, startHqVaultBackgroundSync } from '@wrongstack/hq';
import {
  applyProviderOAuthRefresh,
  createSubscriptionRefreshTransaction,
  matchesActiveProviderCredential,
  onLeaseWanted,
  setAccountQuotaReporting,
  setChatGPTQuotaProviders,
  setCodexCliQuotaFallback,
  setExternalCredentialRefresher,
  setOAuthTokenPersister,
  setProviderModelPersister,
  setSubscriptionRefreshTransaction,
} from '@wrongstack/providers';

/** Standalone hosts must persist rotations as well as interactive login outcomes. */
export function installWebuiProviderPersisters(args: {
  load?: () => Promise<Record<string, ProviderConfig>>;
  /**
   * Renews an OAuth account an HQ key vault holds (it arrives without its
   * refresh token). The CLI-embedded host installs its own and skips this.
   */
  hq?: HqCredentialService | undefined;
  /** The machine root `hq` keeps its identity under; with it, HQ changes sync in the background. */
  hqGlobalRoot?: string | undefined;
  mutate: (
    mutator: (providers: Record<string, ProviderConfig>) => void | Promise<void>,
  ) => Promise<void>;
  warn: (message: string) => void;
}): void {
  // Post-turn plan-quota reads (Kimi Code, OpenCode Go, OpenRouter); host-only.
  setAccountQuotaReporting(true);
  setChatGPTQuotaProviders(args.load);
  // A direct ChatGPT sign-in cannot read its own usage; the Codex CLI's login
  // on this machine can (read-only, never refreshed).
  setCodexCliQuotaFallback(true);
  setSubscriptionRefreshTransaction(createSubscriptionRefreshTransaction(args.mutate));
  const hq = args.hq;
  if (hq) {
    setExternalCredentialRefresher((_id, credential, signal) => hq.renewKey(credential, signal));
    if (args.hqGlobalRoot) {
      startHqVaultBackgroundSync(args.hqGlobalRoot, {
        service: hq,
        warn: args.warn,
        onLeaseWanted,
      });
    }
  }
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
