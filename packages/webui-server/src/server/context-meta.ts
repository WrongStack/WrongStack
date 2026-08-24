/**
 * Context-meta seeding for the standalone WebUI server.
 *
 * Phase 1c of the god-module split (issue: God-modules >1500 lines).
 * `startWebUI` in `./index.ts` previously inlined a ~70-line block that
 * mirrored the CLI's `getSettings()` mapping: it reads the persisted
 * `config.json` shape and projects the relevant fields onto `context.meta`
 * so the settings panel, autonomy engine, fallback chain, feature toggles,
 * and Telegram extension state all reflect the persisted config on first
 * connect — before any `prefs.update` arrives.
 *
 * Pure config → meta projection. No behaviour change.
 */

import { FallbackProfileManager } from '@wrongstack/core/agent';
import { resolvePluginEnablement } from '@wrongstack/core/plugin';
import type { Config } from '@wrongstack/core/types';
import { FORBIDDEN_PROTO_KEYS } from '@wrongstack/core/utils';

/**
 * Seed `context.meta` from the loaded config. Mirrors the CLI's
 * `getSettings()` mapping so TUI and WebUI agree. Without this the snapshot
 * is empty and every browser shows localStorage defaults (autonomy "off",
 * etc.) regardless of what config.json says.
 *
 * The `context` is typed structurally so this module does not take a
 * dependency on the higher `Context` class — anything with a writable
 * `meta: Record<string, unknown>` works.
 */
export function seedContextMeta(config: Config, context: { meta: Record<string, unknown> }): void {
  const meta = context.meta;
  const autonomyCfg = (config.autonomy ?? {}) as Record<string, unknown>;
  const rawMode = autonomyCfg['defaultMode'];
  meta['autonomy'] = rawMode === 'suggest' || rawMode === 'auto' ? rawMode : 'off';
  meta['autonomyDelayMs'] = (autonomyCfg['autoProceedDelayMs'] as number) ?? 45_000;
  meta['autoProceedMaxIterations'] = (autonomyCfg['autoProceedMaxIterations'] as number) ?? 50;
  meta['yolo'] = (autonomyCfg['yolo'] as boolean) ?? config.yolo ?? false;
  meta['chime'] = (autonomyCfg['chime'] as boolean) ?? false;
  meta['confirmExit'] = autonomyCfg['confirmExit'] !== false;
  meta['fleetChatVerbosity'] = (autonomyCfg['fleetChatVerbosity'] as string) ?? 'off';
  meta['enhanceEnabled'] = (autonomyCfg['enhance'] as boolean) ?? true;
  meta['enhanceDelayMs'] = (autonomyCfg['enhanceDelayMs'] as number) ?? 60_000;
  meta['enhanceLanguage'] = (autonomyCfg['enhanceLanguage'] as string) ?? 'original';
  meta['nextPrediction'] = config.nextPrediction ?? false;
  meta['nextStepsTool'] = config.tools?.nextsteps?.enabled === true;
  meta['fallbackModels'] = config.fallbackModels ?? [];
  meta['fallbackBridge'] = config.fallbackBridge ?? '';
  meta['fallbackProfiles'] = config.fallbackProfiles ?? {};
  meta['favoriteModels'] = config.favoriteModels ?? [];
  meta['favoriteModelsOnly'] = config.favoriteModelsOnly === true;
  meta['modelAvailabilitySchedule'] = config.modelAvailabilitySchedule ?? [];
  meta['modelMatrix'] = config.modelMatrix ?? {};
  meta['fallbackAuto'] = config.fallbackAuto !== false;
  // Display language — only seeded when the shared config pins one, so an
  // unset config leaves the client's browser-detected/local default intact.
  if (typeof config.uiLocale === 'string' && config.uiLocale) meta['uiLocale'] = config.uiLocale;
  meta['featureMcp'] = config.features?.mcp !== false;
  meta['featurePlugins'] = config.features?.plugins !== false;
  meta['featureMemory'] = config.features?.memory !== false;
  meta['featureSkills'] = config.features?.skills !== false;
  meta['featureModelsRegistry'] = config.features?.modelsRegistry !== false;
  meta['indexOnStart'] = config.indexing?.onSessionStart !== false;
  meta['contextAutoCompact'] = config.context?.autoCompact !== false;
  meta['contextStrategy'] = config.context?.strategy ?? 'hybrid';
  meta['logLevel'] = config.log?.level ?? 'info';
  meta['auditLevel'] = config.session?.auditLevel ?? 'standard';
  meta['maxIterations'] = config.tools?.maxIterations ?? 500;
  meta['contextMode'] = config.context?.mode ?? 'balanced';
  {
    const tsm = config.features?.tokenSavingMode;
    meta['tokenSavingTier'] = typeof tsm === 'string' ? tsm : tsm ? 'medium' : 'off';
  }
  meta['maxConcurrent'] = typeof config.maxConcurrent === 'number' ? config.maxConcurrent : 10;
  meta['titleAnimation'] = autonomyCfg['terminalTitleAnimation'] !== false;
  {
    const mr = (config.modelRuntime ?? {}) as {
      reasoning?: { mode?: string; effort?: string; preserve?: boolean };
      cache?: { ttl?: string };
    };
    meta['reasoningMode'] = mr.reasoning?.mode ?? 'auto';
    meta['reasoningEffort'] = mr.reasoning?.effort ?? 'high';
    meta['reasoningPreserve'] = mr.reasoning?.preserve === true;
    meta['cacheTtl'] = mr.cache?.ttl ?? 'default';
  }
  // Refiner + TUI visual prefs — parity with the CLI server's seeding so the
  // SettingsPanel shows persisted values on the standalone server too.
  meta['refinerProvider'] = (autonomyCfg['refinerProvider'] as string) ?? '';
  meta['refinerModel'] = (autonomyCfg['refinerModel'] as string) ?? '';
  meta['refinerFallbackProfile'] = (autonomyCfg['refinerFallbackProfile'] as string) ?? '';
  meta['thinkingWord'] = (autonomyCfg['thinkingWord'] as string) ?? 'thinking';
  meta['statuslineMode'] = (autonomyCfg['statuslineMode'] as string) ?? 'minimum';
  meta['animationStyle'] = (autonomyCfg['animationStyle'] as string) ?? 'rainbow';
  meta['showModelReasoning'] = autonomyCfg['showModelReasoning'] !== false;
  // Safety / system prefs
  meta['breakerEnabled'] = config.circuitBreaker?.enabled === true;
  meta['breakerAutoKillResetMs'] = config.circuitBreaker?.autoKillResetMs ?? 60_000;
  {
    // Same precedence as the CLI's deriveFsAccessPair: the canonical
    // features.allowOutsideProjectRoot wins when set, else the legacy
    // tools.restrictToProjectRoot, else unrestricted.
    const featuresAllow = config.features?.allowOutsideProjectRoot;
    const toolsRestrict = config.tools?.restrictToProjectRoot;
    const allow =
      featuresAllow !== undefined
        ? featuresAllow
        : toolsRestrict !== undefined
          ? !toolsRestrict
          : true;
    meta['fsAccess'] = allow ? 'unrestricted' : 'project';
  }
  meta['debugStream'] = config.debugStream === true;
  const hqConfig = (
    config as { hq?: { enabled?: boolean; url?: string; token?: string; rawContent?: boolean } }
  ).hq;
  meta['hqEnabled'] = hqConfig?.enabled === true;
  meta['hqUrl'] = hqConfig?.url ?? '';
  // hq.token is a bearer credential. Keep updates write-only: seeding the
  // decrypted value into context.meta exposes it through prefs snapshots to
  // every connected WebUI client.
  meta['hqRawContent'] = hqConfig?.rawContent === true;

  // Telegram plugin notification settings live under extensions.telegram —
  // same path the CLI's /telegram-settings writes. Seed the meta so the
  // SettingsPanel reflects the persisted config on first connect, before
  // any prefs.update arrives.
  const tgExt = (config.extensions as Record<string, Record<string, unknown>> | undefined)?.[
    'telegram'
  ];
  meta['tgConfigured'] = typeof tgExt?.['botToken'] === 'string' && tgExt['botToken'].length > 0;
  meta['tgSessionEnd'] = tgExt?.['notifyOnSessionEnd'] === true;
  meta['tgDelegate'] = tgExt?.['notifyOnDelegate'] !== false; // default true
  const tgMs = tgExt?.['longToolThresholdMs'];
  meta['tgLongToolMs'] = typeof tgMs === 'number' ? tgMs : 30_000;

  // WrongProxy / WrongTrace: seed the flat meta keys the WebUI panel reads
  // (`wrongProxyEnabled`, `wrongProxyUrl`) from the canonical nested shape
  // (`config.tools.wrongProxy.{enabled,url}` — the same shape
  // `persistPrefsToConfig` writes and `getSettings()` reads). Without this,
  // a restart boots with the panel showing defaults (toggle off, default
  // URL) even though the persisted config has the values — the user has to
  // reopen Settings before the toggle reappears. Mirrors the CLI's
  // `tui-settings-adapter.ts:266-268` read path so TUI and WebUI agree.
  meta['wrongProxyEnabled'] = config.tools?.wrongProxy?.enabled === true;
  meta['wrongProxyUrl'] = (config.tools?.wrongProxy?.url as string) ?? '';

  // Per-plugin toggles — seed the EFFECTIVE state for every plugin the config
  // actually decides, so the panel shows what is running rather than the
  // browser's last guess. Names reachable here always resolve from
  // `plugins[]` or a boolean `extensions.<name>.enabled`, so the catalog
  // `defaultState` is never consulted and the catalog itself is not needed;
  // plugins absent from both keep falling back to defaultState client-side.
  {
    const pluginsEnabled: Record<string, boolean> = {};
    const record = (name: string): void => {
      if (FORBIDDEN_PROTO_KEYS.has(name) || name in pluginsEnabled) return;
      pluginsEnabled[name] = resolvePluginEnablement({ name, config }).enabled;
    };
    for (const entry of config.plugins ?? []) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (typeof name === 'string') record(name);
    }
    for (const [name, options] of Object.entries(config.extensions ?? {})) {
      if (typeof options?.['enabled'] === 'boolean') record(name);
    }
    if (Object.keys(pluginsEnabled).length > 0) meta['pluginsEnabled'] = pluginsEnabled;
  }

  // Chimera (post-session review) — seed from extensions['wstack-chimera']
  // so the dedicated panel reflects the persisted config on first connect,
  // before any prefs.update arrives. The chimera plugin registers itself with
  // defaultState: 'inactive' — when there is no extensions.wstack-chimera
  // entry at all the plugin is NOT loaded, so the WebUI must default to
  // disabled to match. Contrast with the chimera-plugin.ts internal default
  // (enabled !== false) which only applies AFTER the plugin is explicitly
  // opted into. See also plugin-manager.ts defaultState.
  const chimeraExt = (config.extensions as Record<string, Record<string, unknown>> | undefined)?.[
    'wstack-chimera'
  ];
  meta['chimeraEnabled'] = chimeraExt?.['enabled'] === true; // default false (matches defaultState: 'inactive')
  meta['chimeraProvider'] = (chimeraExt?.['provider'] as string) ?? '';
  meta['chimeraModel'] = (chimeraExt?.['model'] as string) ?? '';
  meta['chimeraMaxFiles'] =
    typeof chimeraExt?.['maxFiles'] === 'number' && (chimeraExt['maxFiles'] as number) >= 1
      ? (chimeraExt['maxFiles'] as number)
      : 15;
  const autoFix = chimeraExt?.['autoFix'];
  meta['chimeraAutoFix'] =
    autoFix === 'off' || autoFix === 'ask' || autoFix === 'auto' ? autoFix : 'off';

  // Auto-review (mid-session continuous) — seed from extensions['wstack-auto-review'].
  // Defaults match ResolvedAutoReviewConfig in auto-review-plugin.ts:42
  // (enabled=false; provider/model resolve via fallbackProfile/effective chain).
  const autoReviewExt = (
    config.extensions as Record<string, Record<string, unknown>> | undefined
  )?.['wstack-auto-review'];
  meta['autoReviewEnabled'] = autoReviewExt?.['enabled'] === true; // default false (strict opt-in)
  meta['autoReviewProvider'] = (autoReviewExt?.['provider'] as string) ?? '';
  meta['autoReviewModel'] = (autoReviewExt?.['model'] as string) ?? '';
  meta['autoReviewFallbackProfile'] = (autoReviewExt?.['fallbackProfile'] as string) ?? '';
  meta['autoReviewModelSelection'] =
    autoReviewExt?.['modelSelection'] === 'random' ? 'random' : 'round-robin';
  meta['autoReviewFallbackModels'] = Array.isArray(autoReviewExt?.['fallbackModels'])
    ? (autoReviewExt?.['fallbackModels'] as string[])
    : [];
  meta['autoReviewDebounceMs'] =
    typeof autoReviewExt?.['debounceMs'] === 'number' &&
    (autoReviewExt['debounceMs'] as number) >= 0
      ? (autoReviewExt['debounceMs'] as number)
      : 15_000;
  meta['autoReviewMaxFilesPerBatch'] =
    typeof autoReviewExt?.['maxFilesPerBatch'] === 'number' &&
    (autoReviewExt['maxFilesPerBatch'] as number) >= 1
      ? (autoReviewExt['maxFilesPerBatch'] as number)
      : 15;
  meta['autoReviewMaxConcurrentReviews'] =
    typeof autoReviewExt?.['maxConcurrentReviews'] === 'number' &&
    (autoReviewExt['maxConcurrentReviews'] as number) >= 1
      ? (autoReviewExt['maxConcurrentReviews'] as number)
      : 2;
  const cascade = autoReviewExt?.['cascadeOn'];
  meta['autoReviewCascadeOn'] = cascade === 'critical' || cascade === 'high' ? cascade : 'off';

  // Resolve the effective fallback chain for auto-review via the same
  // FallbackProfileManager the plugin uses (auto-review-plugin.ts:62-69), so
  // the SettingsPanel displays the chain the plugin will actually run with.
  // Inputs: autoReviewExt.fallbackProfile (named profile) OR the session's
  // effective chain via config.fallbackModels + config.fallbackProfiles.
  {
    let resolvedChain: ReadonlyArray<{ providerId: string; model: string }> = [];
    try {
      const mgr = new FallbackProfileManager(config);
      const named = autoReviewExt?.['fallbackProfile'];
      resolvedChain =
        typeof named === 'string' && named.length > 0
          ? mgr.resolveEffective({ fallbackProfile: named, fallbackAuto: false })
          : mgr.resolveEffective({
              fallbackModels: config.fallbackModels,
              fallbackAuto: config.fallbackAuto !== false,
            });
    } catch {
      resolvedChain = [];
    }
    meta['autoReviewFallbackModels'] = resolvedChain.map((e) => `${e.providerId}/${e.model}`);
  }
}
