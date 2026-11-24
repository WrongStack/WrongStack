import type { Config, Logger, SecretVault } from '@wrongstack/contracts/types';
import type { WstackPaths } from '@wrongstack/core/utils';
import { startHqVaultBackgroundSync } from '@wrongstack/hq';
import {
  applyProviderOAuthRefresh,
  createSubscriptionRefreshTransaction,
  matchesActiveProviderCredential,
  setAccountQuotaReporting,
  setChatGPTQuotaProviders,
  setCodexCliQuotaFallback,
  setExternalCredentialRefresher,
  setOAuthTokenPersister,
  setProviderModelPersister,
  setSubscriptionRefreshTransaction,
} from '@wrongstack/providers';
import { HqCredentialService } from '../hq-vault/service.js';
import { activeProfileConfigPath } from '../profile-config-path.js';
import {
  globalRootForConfigPath,
  loadConfigProviders,
  mutateConfigProviders,
} from '../provider-config-utils.js';

export { applyProviderOAuthRefresh } from '@wrongstack/providers';

/**
 * Install the process-wide provider persisters: rotated OAuth tokens and a
 * subscription provider's live model list, both written back to the active
 * profile config.
 *
 * Installed at TWO points on purpose. The interactive path installs them after
 * the launch menu, but `boot()` dispatches subcommands before that — and one
 * of those subcommands is `wstack acp`, the long-lived server an editor spawns
 * (Zed, JetBrains, VS Code). Without an installed persister its refreshes
 * rotated the token in memory only: Codex and Claude invalidate the previous
 * refresh token on use, so the config kept a dead one and the next launch
 * demanded a fresh sign-in. Re-installing later is harmless — the second call
 * replaces the first with an equivalent writer.
 */
export function installProviderPersisters(args: {
  config: Pick<Config, 'activeProfile'>;
  paths: Pick<WstackPaths, 'profileConfig'>;
  vault: SecretVault;
  logger?: Pick<Logger, 'warn'> | undefined;
}): void {
  const profileConfigPath = activeProfileConfigPath(args.paths, args.config);

  // Post-turn plan-quota reads for vendors whose transport cannot report its
  // own (Kimi Code, OpenCode Go, OpenRouter). Host-only: a library consumer
  // never makes an account call it did not ask for.
  setAccountQuotaReporting(true);
  setChatGPTQuotaProviders(() => loadConfigProviders(profileConfigPath, args.vault));
  // A direct ChatGPT sign-in cannot read its own usage; the Codex CLI's login
  // on this machine can (read-only, never refreshed).
  setCodexCliQuotaFallback(true);
  setSubscriptionRefreshTransaction(
    createSubscriptionRefreshTransaction((mutator) =>
      mutateConfigProviders(profileConfigPath, args.vault, mutator),
    ),
  );

  // An OAuth account an HQ key vault holds arrives without its refresh token:
  // HQ renews it, and the provider runtime asks HQ here when the access token
  // is about to expire. Only `source.kind === 'hq'` entries reach this.
  const hqRoot = globalRootForConfigPath(profileConfigPath);
  const hq = new HqCredentialService({ globalRoot: hqRoot, vault: args.vault, profileConfigPath });
  setExternalCredentialRefresher((_providerId, credential, signal) =>
    hq.renewKey(credential, signal),
  );
  // Keep what HQ grants in step without a manual Sync: HQ's `hq.vault_changed`
  // notices and a slow revision poll run one sync per change (one scheduler
  // per process). The config watcher hands the result to the live provider.
  startHqVaultBackgroundSync(hqRoot, { service: hq, warn: (m) => args.logger?.warn(m) });

  setOAuthTokenPersister((providerId, creds, source) => {
    void mutateConfigProviders(profileConfigPath, args.vault, (all) => {
      const p = all[providerId];
      if (!p) return;
      applyProviderOAuthRefresh(p, creds, source);
    }).catch(() =>
      args.logger?.warn(
        `OAuth token refresh for "${providerId}" could not be saved. Sign-in may be required next session.`,
      ),
    );
  });

  // Live model-list persistence. A subscription provider's model list is
  // ACCOUNT state, not a WrongStack release artifact: it changes when a model
  // rolls out to the account. The provider publishes it off the catalog probe
  // it already makes at request boundaries, so this costs no extra request.
  setProviderModelPersister((providerId, models, source) => {
    void mutateConfigProviders(profileConfigPath, args.vault, (all) => {
      const p = all[providerId];
      if (!p) return;
      if (source && !matchesActiveProviderCredential(p, source)) return;
      const live = models.map((m) => m.id);
      // Order matters — the picker shows this list in order, and the backend
      // returns it newest-first. Skip the write when nothing moved so a
      // five-minute catalog re-read does not rewrite config on a timer.
      if (p.models?.length === live.length && p.models.every((id, i) => id === live[i])) return;
      p.models = live;
    }).catch(() => args.logger?.warn(`Model discovery for "${providerId}" could not be saved.`));
  });
}
