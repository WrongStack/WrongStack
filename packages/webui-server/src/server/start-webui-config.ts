import type { Config, SecretVault } from '@wrongstack/contracts/types';
import { expectDefined } from '@wrongstack/core/utils';
import { hasSubscriptionRefreshTransaction } from '@wrongstack/providers';
import { bootConfig, patchConfig } from './boot.js';
import {
  type ConfigWriteLockHolder,
  type PrefHelperDeps,
  updateGlobalConfig as updateGlobalConfigImpl,
} from './pref-helpers.js';
import { loadSavedProviders, mutateSavedProviders } from './provider-config-io.js';
import { installWebuiProviderPersisters } from './provider-token-persisters.js';
import { bootstrapWrongProxyFromConfig } from './proxy-runtime.js';
import type { WebUIOptions } from './types.js';

type BootResult = Awaited<ReturnType<typeof bootConfig>>;

/** Boot-time configuration resolved before any WebUI service is built. */
export interface PreparedWebuiConfig {
  boot: BootResult;
  vault: SecretVault;
  /** Initial config value; `startWebUI` owns the live (reassignable) binding. */
  config: Config;
  configWriteLock: ConfigWriteLockHolder;
  profileConfigPath: string;
  prefHelperDeps: PrefHelperDeps;
  updateGlobalConfig: (
    mutate: (cfg: Record<string, unknown>) => void,
    errorLabel: string,
  ) => Promise<void>;
  needsProvider: boolean;
}

/**
 * Boot phase of `startWebUI`: load config, seed the WrongProxy singleton,
 * pick the vault, resolve the active profile path + serialized config writer,
 * install the OAuth token persisters, and auto-select a saved provider.
 */
export async function prepareWebuiConfig(opts: WebUIOptions): Promise<PreparedWebuiConfig> {
  // Boot configuration
  const boot = await bootConfig();
  const { config: baseConfig, wpaths, logger } = boot;
  // Seed the WrongProxy / WrongTrace singleton from the persisted
  // `tools.wrongProxy.{enabled,url}` block and await the first probe BEFORE
  // the server's provider is built (in `createPreContextServices` →
  // `resolveSetupProvider`). Without this, every provider-build path in this
  // process reads the core singleton at its default `{enabled:false, url:'',
  // active:false}` and constructs providers with the raw base URL — so a
  // separate WebUI process would ignore the proxy toggle entirely. The CLI
  // host already does this (cli-main.ts / system-prompt.ts); the standalone
  // server must too.
  await bootstrapWrongProxyFromConfig(baseConfig);
  // PR 5 of Phase 2: when the caller (typically the CLI) supplies a
  // pre-built `BackendServices`, prefer its `vault` over the one the
  // default boot would construct. This lets `runWebUI` keep owning the
  // vault lifecycle (so it can decrypt/encrypt its own config writes
  // in lockstep with the rest of the CLI session) instead of having
  // the webui build a parallel vault it can never see.
  const vault = opts.services?.vault ?? boot.vault;
  let config = baseConfig;

  // Serialize concurrent profile-config writes to prevent races between
  // model.switch and key.add/key.update handlers.
  // Held in a mutable object so the pref-helpers (./pref-helpers.ts, Phase 1c)
  // can update the lock in place — TypeScript flattens Promise<Promise<void>>,
  // so we can't return the new lock from an async helper.
  const configWriteLock: ConfigWriteLockHolder = { lock: Promise.resolve() };

  // Unified global config mutation: read → decrypt → mutate → encrypt → write,
  // serialized behind configWriteLock. Implementation lives in
  // ./pref-helpers.ts; this thin wrapper preserves the two-arg signature the
  // route layer (provider routes, key handlers) expects.
  // Resolve the active profile config path so updateGlobalConfig writes settings
  // to the canonical profile file (~/.wrongstack/profiles/<name>/config.json)
  // instead of the thin root bootstrap (~/.wrongstack/config.json).
  const activeProfile =
    (config as { activeProfile?: string | undefined }).activeProfile ?? 'default';
  const profileConfigPath = wpaths.profileConfig(activeProfile);
  const prefHelperDeps: PrefHelperDeps = { profileConfigPath, vault, logger };
  const updateGlobalConfig = async (
    mutate: (cfg: Record<string, unknown>) => void,
    errorLabel: string,
  ): Promise<void> => updateGlobalConfigImpl(prefHelperDeps, configWriteLock, mutate, errorLabel);

  console.log('[WebUI] Config loaded:', config.provider ?? '(none)', '/', config.model ?? '(none)');
  // Rotated OAuth tokens must reach disk before any discovery below can renew
  // a credential (see the invalid_grant root cause). Standalone hosts always
  // install. A host injecting pre-built `services` normally installed its own
  // persisters — skip only when such a subscription-refresh transaction is
  // already present; an injected host that forgot them still gets one here,
  // because a renewal without it rotates the refresh token, drops the rotated
  // value, and every later renewal fails with invalid_grant.
  if (!opts.services || !hasSubscriptionRefreshTransaction()) {
    installWebuiProviderPersisters({
      load: () => loadSavedProviders(profileConfigPath, vault),
      mutate: (mutator) => mutateSavedProviders(profileConfigPath, vault, mutator),
      warn: (message) => logger.warn(message),
    });
  }

  // If no active provider is set but there are saved providers, pick the first one.
  // This handles configs written in older formats or by external tools.
  // Guard against config.providers being a string or other non-object value
  // (e.g., from a corrupted config or YAML parser misreading the value).
  if (
    !config.provider &&
    config.providers &&
    typeof config.providers === 'object' &&
    config.providers !== null &&
    !Array.isArray(config.providers) &&
    Object.keys(config.providers).length > 0
  ) {
    const firstKey = expectDefined(Object.keys(config.providers)[0]);
    // Also adopt a model when the provider carries a saved `models` allowlist.
    // Without this the auto-selected provider lands with a BLANK active model
    // (needsProvider stays true → chat opens with no model in the header).
    // A provider without a saved allowlist (e.g. a custom one to be probed)
    // still gets the provider; the model dropdown is populated on demand.
    const adoptModel = !config.model ? config.providers[firstKey]?.models?.[0] : undefined;
    config = patchConfig(config, {
      provider: firstKey,
      ...(adoptModel ? { model: adoptModel } : {}),
    });
    console.log(
      '[WebUI] No active provider — auto-selected:',
      firstKey,
      adoptModel ? `/ ${adoptModel}` : '',
    );
  }

  // If still no provider, the frontend will show a setup screen.
  // We still start the HTTP/WS servers so the user can configure via the UI.
  const needsProvider = !config.provider || !config.model;

  return {
    boot,
    vault,
    config,
    configWriteLock,
    profileConfigPath,
    prefHelperDeps,
    updateGlobalConfig,
    needsProvider,
  };
}
