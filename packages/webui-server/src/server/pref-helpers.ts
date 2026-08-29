/**
 * Pref-persistence helpers for the standalone WebUI server.
 *
 * Phase 1c of the god-module split (issue: God-modules >1500 lines).
 * `startWebUI` previously inlined four interlocking closures:
 *   - `PREF_KEYS` + `prefSnapshot()` — read the live context.meta subset
 *     the settings panel exposes
 *   - `updateGlobalConfig()` — unified read→decrypt→mutate→encrypt→write
 *     against config.json, serialized behind a non-poisoning lock
 *   - `persistPrefsToConfig()` — project a prefs.update payload back into
 *     config.json so a toggle made in the browser survives restarts
 *
 * All four move here. `updateGlobalConfig` returns the new lock so
 * `startWebUI` can keep its mutable `configWriteLock` reference; the other
 * two take explicit args. No behaviour change — the mutation ladder,
 * the FEATURE_MAP, and the touch-flags are preserved verbatim.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pluginEntryMatchesName } from '@wrongstack/core/plugin';
import { decryptConfigSecrets, encryptConfigSecrets } from '@wrongstack/core/security';
import type { SecretVault } from '@wrongstack/core/types';
import { atomicWrite, backupConfigFile, FORBIDDEN_PROTO_KEYS } from '@wrongstack/core/utils';

/** Pref keys exposed to the settings panel via prefs.get / prefs.updated. */
export const PREF_KEYS = [
  'autonomy',
  'autonomyDelayMs',
  'autoProceedMaxIterations',
  'yolo',
  'maxIterations',
  'chime',
  'confirmExit',
  'nextPrediction',
  'nextStepsTool',
  'enhanceEnabled',
  'enhanceDelayMs',
  'enhanceLanguage',
  'featureMcp',
  'featurePlugins',
  'featureMemory',
  'featureSkills',
  'featureModelsRegistry',
  'indexOnStart',
  'contextAutoCompact',
  'contextStrategy',
  'contextMode',
  'tokenSavingTier',
  // Identity-prompt size: lite | default | pro. Persisted to
  // config.systemPrompt.variant, the same key the CLI startup menu writes,
  // so a choice made in the browser is the one the next CLI boot offers.
  'systemPromptVariant',
  'maxConcurrent',
  'titleAnimation',
  'uiLocale',
  'logLevel',
  'auditLevel',
  'hqEnabled',
  'hqUrl',
  'hqRawContent',
  'tgConfigured',
  'tgSessionEnd',
  'tgDelegate',
  'tgLongToolMs',
  'reasoningMode',
  'reasoningEffort',
  'reasoningPreserve',
  'cacheTtl',
  'fallbackModels',
  'fallbackProfiles',
  'favoriteModels',
  'favoriteModelsOnly',
  'modelAvailabilitySchedule',
  'modelMatrix',
  'modelTiers',
  'fallbackAuto',
  // Refiner + TUI visual prefs (parity with the CLI's embedded server —
  // these were browser-editable there but rejected as unknown keys here).
  'refinerProvider',
  'refinerModel',
  'refinerFallbackProfile',
  'thinkingWord',
  'statuslineMode',
  'animationStyle',
  'showModelReasoning',
  // Safety / system prefs (parity with /settings breaker, fs-access, debug-stream).
  'breakerEnabled',
  'breakerAutoKillResetMs',
  'fsAccess',
  'debugStream',
  // Chimera (post-session) + auto-review (mid-session) settings.
  // Persisted to config.extensions['wstack-chimera'] / ['wstack-auto-review']
  // so the running plugins pick up changes after a session restart.
  'chimeraEnabled',
  'chimeraProvider',
  'chimeraModel',
  'chimeraMaxFiles',
  'chimeraAutoFix',
  'autoReviewEnabled',
  'autoReviewProvider',
  'autoReviewModel',
  'autoReviewFallbackProfile',
  'autoReviewModelSelection',
  'autoReviewFallbackModels',
  'autoReviewDebounceMs',
  'autoReviewMaxFilesPerBatch',
  'autoReviewMaxConcurrentReviews',
  'autoReviewCascadeOn',
  // Display-only toggles (purely visual WebUI prefs, not persisted to config).
  'groupToolCalls',
  'showThinkingLogs',
  // v15: chat-input auto-collapse (opt-in display toggle, default off).
  'autoCollapseInput',
  // Per-plugin enable/disable map (parity with the embedded server).
  'pluginsEnabled',
  // Fleet chat verbosity: off | full (migrated from streamFleet boolean).
  'fleetChatVerbosity',
  // WrongProxy / WrongTrace: master switch + configurable URL (default
  // http://localhost:3444). When `wrongProxyEnabled` is true and the daemon
  // is reachable, every provider's base URL flows through
  // `${wrongProxyUrl}/proxy/<host><path>`. openai-codex is excluded by spec.
  'wrongProxyEnabled',
  'wrongProxyUrl',
  // Display parity keys (TUI / WebUI)
  'showAgentSwarmPanel',
  'readSymbols',
  'showSageMemoryInject',
  'sageMemoryInjectThreshold',
  'preRefineSeconds',
  'multiDiffSummaryThreshold',
  'enhanceCountdownMs',
  'keyboardShortcuts',
] as const;

export interface PrefHelperDeps {
  /** Path to the active profile config; the sole settings mutation target. */
  profileConfigPath: string;
  vault: SecretVault;
  logger: { warn(msg: string): void };
}

/**
 * Snapshot the pref keys currently present on `contextMeta`. Structural
 * typing on the meta keeps this decoupled from the `Context` class.
 */
export function prefSnapshot(contextMeta: Record<string, unknown>): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const k of PREF_KEYS) {
    if (k in contextMeta) snapshot[k] = contextMeta[k];
  }
  return snapshot;
}

/** Mutable holder for the serialized-config-write lock. The helpers update
 *  `lock` in place so callers keep a stable reference across writes (the
 *  lock is non-poisoning: a failed write resolves the chain but logs).
 *
 *  We use a holder object rather than returning the new lock because
 *  TypeScript flattens `Promise<Promise<void>>` into `Promise<void>`,
 *  which would make `await helper(...)` yield `void` instead of the new
 *  lock value. */
export interface ConfigWriteLockHolder {
  lock: Promise<void>;
}

/**
 * Write the mutated config to a single file path. Handles read/decrypt/mutate/encrypt/write.
 */
async function writeGlobalConfigFile(
  filePath: string,
  vault: SecretVault,
  mutate: (config: Record<string, unknown>) => void,
  logger: { warn(msg: string): void },
  errorLabel: string,
): Promise<void> {
  // Back up the current file before overwriting
  const globalRoot = path.dirname(filePath);
  await backupConfigFile(filePath, { globalRoot });
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    raw = '{}';
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    logger.warn(`${errorLabel}: refusing to overwrite corrupt config at ${filePath}`);
    return;
  }
  const decrypted = decryptConfigSecrets(parsed, vault) as Record<string, unknown>;
  mutate(decrypted);
  const encrypted = encryptConfigSecrets(decrypted, vault);
  await atomicWrite(filePath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
}

/**
 * Unified global config mutation: read → decrypt → mutate → encrypt → write.
 * All config writes MUST go through this helper so encryption is always
 * preserved and writes are serialized behind the holder's `lock`.
 *
 * Mutates `holder.lock` in place to the new (non-poisoning) chain value.
 */
export async function updateGlobalConfig(
  deps: PrefHelperDeps,
  holder: ConfigWriteLockHolder,
  mutate: (config: Record<string, unknown>) => void,
  errorLabel: string,
): Promise<void> {
  const { profileConfigPath, vault, logger } = deps;
  const write = async (): Promise<void> => {
    await writeGlobalConfigFile(profileConfigPath, vault, mutate, logger, errorLabel);
  };
  const next = holder.lock.then(write);
  holder.lock = next.then(
    () => undefined,
    () => undefined,
  );
  try {
    await next;
  } catch (err) {
    logger.warn(
      `${errorLabel}: failed to persist to config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Persist pref changes into the active profile config — the SAME keys the TUI
 * settings picker writes — so a toggle made in the browser survives restarts
 * and is visible to the CLI/TUI (and vice versa on next boot). Best-effort
 * and serialized behind the holder's `lock`; failures log but never break
 * the WS reply.
 */
/** Display-only keys listed in PREF_KEYS for snapshot/get but never persisted. */
const DISPLAY_ONLY_KEYS = new Set([
  'groupToolCalls',
  'showThinkingLogs',
  // v15: chat-input auto-collapse (opt-in display toggle, default off).
  'autoCollapseInput',
  'autoReviewFallbackModels',
  'allowOutsideProjectRoot',
  'enhanceCountdownMs',
  'keyboardShortcuts',
]);

export async function persistPrefsToConfig(
  deps: PrefHelperDeps,
  holder: ConfigWriteLockHolder,
  payload: Record<string, unknown>,
): Promise<void> {
  // Clone to avoid mutating the caller's payload object.
  payload = { ...payload };
  // Strip display-only keys to avoid a no-op config rewrite cycle.
  for (const k of DISPLAY_ONLY_KEYS) delete payload[k];
  if (Object.keys(payload).length === 0) return;

  return updateGlobalConfig(
    deps,
    holder,
    (decrypted) => {
      const autonomyCfg = (decrypted.autonomy as Record<string, unknown>) ?? {};
      let autonomyTouched = false;
      const setAutonomy = (key: string, val: unknown): void => {
        autonomyCfg[key] = val;
        autonomyTouched = true;
      };
      if (
        typeof payload['autonomy'] === 'string' &&
        ['off', 'suggest', 'auto', 'eternal', 'eternal-parallel'].includes(payload['autonomy'])
      ) {
        setAutonomy('defaultMode', payload['autonomy']);
      }
      if (typeof payload['autonomyDelayMs'] === 'number')
        setAutonomy('autoProceedDelayMs', payload['autonomyDelayMs']);
      if (typeof payload['autoProceedMaxIterations'] === 'number')
        setAutonomy('autoProceedMaxIterations', payload['autoProceedMaxIterations']);
      if (typeof payload['yolo'] === 'boolean') {
        setAutonomy('yolo', payload['yolo']);
        decrypted.yolo = payload['yolo'];
      }
      if (typeof payload['chime'] === 'boolean') setAutonomy('chime', payload['chime']);
      if (typeof payload['confirmExit'] === 'boolean')
        setAutonomy('confirmExit', payload['confirmExit']);
      if (typeof payload['fleetChatVerbosity'] === 'string')
        setAutonomy('fleetChatVerbosity', payload['fleetChatVerbosity']);
      if (typeof payload['enhanceEnabled'] === 'boolean')
        setAutonomy('enhance', payload['enhanceEnabled']);
      if (typeof payload['enhanceDelayMs'] === 'number')
        setAutonomy('enhanceDelayMs', payload['enhanceDelayMs']);
      if (typeof payload['enhanceLanguage'] === 'string')
        setAutonomy('enhanceLanguage', payload['enhanceLanguage']);
      if (typeof payload['refinerProvider'] === 'string')
        setAutonomy('refinerProvider', payload['refinerProvider']);
      if (typeof payload['refinerModel'] === 'string')
        setAutonomy('refinerModel', payload['refinerModel']);
      if (typeof payload['refinerFallbackProfile'] === 'string')
        setAutonomy('refinerFallbackProfile', payload['refinerFallbackProfile']);
      if (typeof payload['thinkingWord'] === 'string')
        setAutonomy('thinkingWord', payload['thinkingWord']);
      if (typeof payload['statuslineMode'] === 'string')
        setAutonomy('statuslineMode', payload['statuslineMode']);
      if (typeof payload['animationStyle'] === 'string')
        setAutonomy('animationStyle', payload['animationStyle']);
      if (typeof payload['showModelReasoning'] === 'boolean')
        setAutonomy('showModelReasoning', payload['showModelReasoning']);
      if (typeof payload['showAgentSwarmPanel'] === 'string')
        setAutonomy('showAgentSwarmPanel', payload['showAgentSwarmPanel']);
      if (typeof payload['readSymbols'] === 'boolean')
        setAutonomy('readAdvancedMode', payload['readSymbols']);
      if (typeof payload['showSageMemoryInject'] === 'boolean')
        setAutonomy('showSageMemoryInject', payload['showSageMemoryInject']);
      if (typeof payload['preRefineSeconds'] === 'number')
        setAutonomy('preRefineSeconds', payload['preRefineSeconds']);
      if (typeof payload['multiDiffSummaryThreshold'] === 'number')
        setAutonomy('multiDiffSummaryThreshold', payload['multiDiffSummaryThreshold']);
      if (autonomyTouched) decrypted.autonomy = autonomyCfg;

      if (typeof payload['nextPrediction'] === 'boolean')
        decrypted.nextPrediction = payload['nextPrediction'];

      // SAGE memory inject threshold → Sage.inject.relationFloor
      if (typeof payload['sageMemoryInjectThreshold'] === 'number') {
        const sageSec = (decrypted.Sage as Record<string, unknown>) ?? {};
        const inject = (sageSec.inject as Record<string, unknown>) ?? {};
        inject.relationFloor = payload['sageMemoryInjectThreshold'];
        sageSec.inject = inject;
        decrypted.Sage = sageSec;
      }

      // Model switching uses the same serialized/encrypted config boundary.
      if (typeof payload['provider'] === 'string') decrypted.provider = payload['provider'];
      if (typeof payload['model'] === 'string') decrypted.model = payload['model'];

      // Display language — top-level Config.uiLocale (shared across surfaces).
      if (typeof payload['uiLocale'] === 'string') decrypted.uiLocale = payload['uiLocale'];

      // Global fallback model chain (top-level config). Read live by the leader's
      // fallback extension each turn (effectiveFallbackChain), so it takes effect
      // without a restart.
      if (Array.isArray(payload['fallbackModels']))
        decrypted.fallbackModels = payload['fallbackModels'];
      if (
        payload['fallbackProfiles'] &&
        typeof payload['fallbackProfiles'] === 'object' &&
        !Array.isArray(payload['fallbackProfiles'])
      ) {
        decrypted.fallbackProfiles = payload['fallbackProfiles'] as Record<string, string[]>;
      }
      if (Array.isArray(payload['favoriteModels']))
        decrypted.favoriteModels = payload['favoriteModels'];
      if (typeof payload['favoriteModelsOnly'] === 'boolean')
        decrypted.favoriteModelsOnly = payload['favoriteModelsOnly'];
      if (Array.isArray(payload['modelAvailabilitySchedule']))
        decrypted.modelAvailabilitySchedule = payload['modelAvailabilitySchedule'];
      if (
        payload['modelMatrix'] &&
        typeof payload['modelMatrix'] === 'object' &&
        !Array.isArray(payload['modelMatrix'])
      ) {
        decrypted.modelMatrix = payload['modelMatrix'] as typeof decrypted.modelMatrix;
      }
      if (
        payload['modelTiers'] &&
        typeof payload['modelTiers'] === 'object' &&
        !Array.isArray(payload['modelTiers'])
      ) {
        decrypted.modelTiers = payload['modelTiers'] as typeof decrypted.modelTiers;
      }
      if (typeof payload['fallbackAuto'] === 'boolean')
        decrypted.fallbackAuto = payload['fallbackAuto'];

      const FEATURE_MAP: Record<string, string> = {
        featureMcp: 'mcp',
        featurePlugins: 'plugins',
        featureMemory: 'memory',
        featureSkills: 'skills',
        featureModelsRegistry: 'modelsRegistry',
      };
      for (const [prefKey, cfgKey] of Object.entries(FEATURE_MAP)) {
        if (typeof payload[prefKey] === 'boolean') {
          const feats = (decrypted.features as Record<string, unknown>) ?? {};
          feats[cfgKey] = payload[prefKey];
          decrypted.features = feats;
        }
      }

      if (
        typeof payload['contextAutoCompact'] === 'boolean' ||
        typeof payload['contextStrategy'] === 'string' ||
        typeof payload['contextMode'] === 'string'
      ) {
        const ctxCfg = (decrypted.context as Record<string, unknown>) ?? {};
        if (typeof payload['contextAutoCompact'] === 'boolean')
          ctxCfg.autoCompact = payload['contextAutoCompact'];
        if (typeof payload['contextStrategy'] === 'string')
          ctxCfg.strategy = payload['contextStrategy'];
        if (typeof payload['contextMode'] === 'string') ctxCfg.mode = payload['contextMode'];
        decrypted.context = ctxCfg;
      }
      if (typeof payload['tokenSavingTier'] === 'string') {
        const featsCfg = (decrypted.features as Record<string, unknown>) ?? {};
        featsCfg.tokenSavingMode = payload['tokenSavingTier'];
        decrypted.features = featsCfg;
      }
      // Writing the key explicitly is what marks the choice as *made*: the
      // config loader materializes `variant: 'default'` in memory for every
      // config, so only its presence on disk distinguishes "user picked
      // Standard" from "never asked". The WebUI first-run picker reads that
      // same signal back through `readSavedSystemPromptVariant`.
      if (typeof payload['systemPromptVariant'] === 'string') {
        const promptCfg = (decrypted.systemPrompt as Record<string, unknown>) ?? {};
        promptCfg.variant = payload['systemPromptVariant'];
        decrypted.systemPrompt = promptCfg;
      }
      if (typeof payload['maxConcurrent'] === 'number') {
        decrypted.maxConcurrent = payload['maxConcurrent'];
      }
      if (typeof payload['titleAnimation'] === 'boolean') {
        const autoCfg = (decrypted.autonomy as Record<string, unknown>) ?? {};
        autoCfg.terminalTitleAnimation = payload['titleAnimation'];
        decrypted.autonomy = autoCfg;
      }
      if (typeof payload['logLevel'] === 'string') {
        const logCfg = (decrypted.log as Record<string, unknown>) ?? {};
        logCfg.level = payload['logLevel'];
        decrypted.log = logCfg;
      }
      if (typeof payload['auditLevel'] === 'string') {
        const sessionCfg = (decrypted.session as Record<string, unknown>) ?? {};
        sessionCfg.auditLevel = payload['auditLevel'];
        decrypted.session = sessionCfg;
      }
      if (typeof payload['indexOnStart'] === 'boolean') {
        const indexingCfg = (decrypted.indexing as Record<string, unknown>) ?? {};
        indexingCfg.onSessionStart = payload['indexOnStart'];
        decrypted.indexing = indexingCfg;
      }
      if (typeof payload['maxIterations'] === 'number') {
        const toolsCfg = (decrypted.tools as Record<string, unknown>) ?? {};
        toolsCfg.maxIterations = payload['maxIterations'];
        decrypted.tools = toolsCfg;
      }
      if (typeof payload['nextStepsTool'] === 'boolean') {
        // Read at boot by registerCanonicalHostTools, so the toggle is
        // persisted now and the tool appears in the next session.
        const toolsCfg = (decrypted.tools as Record<string, unknown>) ?? {};
        toolsCfg.nextsteps = { enabled: payload['nextStepsTool'] };
        decrypted.tools = toolsCfg;
      }

      const hqTouched =
        typeof payload['hqEnabled'] === 'boolean' ||
        typeof payload['hqUrl'] === 'string' ||
        typeof payload['hqToken'] === 'string' ||
        typeof payload['hqRawContent'] === 'boolean';
      if (hqTouched) {
        const hqCfg = (decrypted.hq as Record<string, unknown>) ?? {};
        if (typeof payload['hqEnabled'] === 'boolean') hqCfg.enabled = payload['hqEnabled'];
        if (typeof payload['hqUrl'] === 'string') hqCfg.url = payload['hqUrl'];
        if (typeof payload['hqToken'] === 'string') hqCfg.token = payload['hqToken'];
        if (typeof payload['hqRawContent'] === 'boolean')
          hqCfg.rawContent = payload['hqRawContent'];
        decrypted.hq = hqCfg;
      }

      const tgTouched =
        typeof payload['tgSessionEnd'] === 'boolean' ||
        typeof payload['tgDelegate'] === 'boolean' ||
        typeof payload['tgLongToolMs'] === 'number';
      if (tgTouched) {
        const ext = (decrypted.extensions as Record<string, Record<string, unknown>>) ?? {};
        const tg = ext['telegram'] ?? {};
        if (typeof payload['tgSessionEnd'] === 'boolean') {
          tg['notifyOnSessionEnd'] = payload['tgSessionEnd'];
        }
        if (typeof payload['tgDelegate'] === 'boolean') {
          tg['notifyOnDelegate'] = payload['tgDelegate'];
        }
        if (typeof payload['tgLongToolMs'] === 'number') {
          tg['longToolThresholdMs'] = payload['tgLongToolMs'];
        }
        ext['telegram'] = tg;
        decrypted.extensions = ext;
      }

      // Reasoning / cache runtime controls → Config.modelRuntime
      const modelRuntimeTouched =
        typeof payload['reasoningMode'] === 'string' ||
        typeof payload['reasoningEffort'] === 'string' ||
        typeof payload['reasoningPreserve'] === 'boolean' ||
        typeof payload['cacheTtl'] === 'string';
      if (modelRuntimeTouched) {
        const mr = (decrypted.modelRuntime as Record<string, unknown>) ?? {};
        const reasoning = (mr.reasoning as Record<string, unknown>) ?? {};
        if (typeof payload['reasoningMode'] === 'string') reasoning.mode = payload['reasoningMode'];
        // 'auto' = "follow the general setting" sentinel: valid as this tab's
        // session-scoped pref, but it must never become the persisted global
        // effort or it would reach the wire as a literal level on models with
        // an undocumented vocabulary.
        if (typeof payload['reasoningEffort'] === 'string' && payload['reasoningEffort'] !== 'auto')
          reasoning.effort = payload['reasoningEffort'];
        if (typeof payload['reasoningPreserve'] === 'boolean')
          reasoning.preserve = payload['reasoningPreserve'];
        mr.reasoning = reasoning;
        if (typeof payload['cacheTtl'] === 'string' && payload['cacheTtl'] !== 'default') {
          mr.cache = { ttl: payload['cacheTtl'] };
        } else if (payload['cacheTtl'] === 'default') {
          delete mr.cache;
        }
        decrypted.modelRuntime = mr;
      }

      // Process circuit breaker → Config.circuitBreaker
      if (
        typeof payload['breakerEnabled'] === 'boolean' ||
        typeof payload['breakerAutoKillResetMs'] === 'number'
      ) {
        const cb = (decrypted.circuitBreaker as Record<string, unknown>) ?? {};
        if (typeof payload['breakerEnabled'] === 'boolean') cb.enabled = payload['breakerEnabled'];
        if (typeof payload['breakerAutoKillResetMs'] === 'number')
          cb.autoKillResetMs = payload['breakerAutoKillResetMs'];
        decrypted.circuitBreaker = cb;
      }

      // Filesystem access scope — dual-write the inverse pair, same as the
      // CLI's deriveFsAccessPair (tools.restrictToProjectRoot is legacy,
      // features.allowOutsideProjectRoot is canonical; they must stay inverses).
      if (payload['fsAccess'] === 'unrestricted' || payload['fsAccess'] === 'project') {
        const restrict = payload['fsAccess'] === 'project';
        const toolsCfg = (decrypted.tools as Record<string, unknown>) ?? {};
        toolsCfg.restrictToProjectRoot = restrict;
        decrypted.tools = toolsCfg;
        const featsCfg = (decrypted.features as Record<string, unknown>) ?? {};
        featsCfg.allowOutsideProjectRoot = !restrict;
        decrypted.features = featsCfg;
      }

      // Raw SSE debug dump → top-level Config.debugStream
      if (typeof payload['debugStream'] === 'boolean')
        decrypted.debugStream = payload['debugStream'];

      // WrongProxy / WrongTrace → nested `tools.wrongProxy.{enabled,url}`.
      // Mirrors the TUI adapter (`packages/cli/src/boot/tui-settings-adapter.ts:475-480`)
      // and the canonical schema (`ToolsConfig.wrongProxy?: WrongProxyToolConfig`).
      // DO NOT write to top-level `wrongProxyEnabled` / `wrongProxyUrl` —
      // nothing reads them back: the runtime probe (`runtime-controller-deps.ts:144-148`)
      // and the TUI picker (field 59) both read `config.tools?.wrongProxy?.*`, so a
      // top-level write would land on disk, survive `prefs.update`, and be ignored
      // on next boot (the symptom this branch fixes).
      // Only assign fields present in the payload so unset keys preserve their
      // on-disk values (parity with the TUI adapter).
      if (
        typeof payload['wrongProxyEnabled'] === 'boolean' ||
        typeof payload['wrongProxyUrl'] === 'string'
      ) {
        const toolsCfg = (decrypted.tools as Record<string, unknown>) ?? {};
        const wp = (toolsCfg['wrongProxy'] as Record<string, unknown>) ?? {};
        if (typeof payload['wrongProxyEnabled'] === 'boolean')
          wp['enabled'] = payload['wrongProxyEnabled'];
        if (typeof payload['wrongProxyUrl'] === 'string') wp['url'] = payload['wrongProxyUrl'];
        toolsCfg['wrongProxy'] = wp;
        decrypted.tools = toolsCfg;
      }

      // Note: `autoReviewFallbackModels` is intentionally NOT a persisted
      // user-configurable input. It's a *resolved output* computed by the
      // auto-review plugin via FallbackProfileManager (auto-review-plugin.ts:67-69).
      // It's exposed on LocalPrefs for read-only display in the panel; the
      // panel writes the source inputs (`autoReviewFallbackProfile`,
      // `autoReviewProvider`, `autoReviewModel`) and the server seeds the
      // resolved chain from config on next boot.

      // Per-plugin enable/disable → extensions.<name>.enabled. Parity with the
      // embedded server (prefs-seeding.ts) so a browser toggling plugins against
      // the standalone server persists instead of erroring.
      if (typeof payload['pluginsEnabled'] === 'object' && payload['pluginsEnabled'] !== null) {
        const ext = (decrypted.extensions as Record<string, Record<string, unknown>>) ?? {};
        const toggled: Array<[string, boolean]> = [];
        for (const [pluginName, enabled] of Object.entries(
          payload['pluginsEnabled'] as Record<string, boolean>,
        )) {
          // Plugin names are the only attacker-controlled KEYS in this whole
          // ladder (every other ext[...] site is a hardcoded literal). Without
          // this guard, `{"pluginsEnabled":{"__proto__":true}}` makes
          // `ext['__proto__']` read back Object.prototype, and the next line
          // writes `Object.prototype.enabled = true` — every object in the
          // process then inherits `.enabled`, silently defeating the
          // `?? true`-style plugin gates. JSON.parse yields `__proto__` as an
          // own enumerable key, so Object.entries hands it to us.
          if (FORBIDDEN_PROTO_KEYS.has(pluginName)) continue;
          if (typeof enabled !== 'boolean') continue;
          const pExt = ext[pluginName] ?? {};
          pExt['enabled'] = enabled;
          ext[pluginName] = pExt;
          toggled.push([pluginName, enabled]);
        }
        decrypted.extensions = ext;

        // `config.plugins` OUTRANKS `extensions.<name>.enabled` (see
        // resolvePluginEnablement). Writing only the extension left the switch
        // decorative for every plugin that also has a plugins[] entry — the
        // toggle moved, the config changed, and the plugin kept its old state.
        // Keep the winning layer in sync; plugins with no entry are still
        // decided by the extension alone.
        if (Array.isArray(decrypted.plugins) && toggled.length > 0) {
          decrypted.plugins = (
            decrypted.plugins as Array<string | { name?: unknown; enabled?: boolean }>
          ).map((entry) => {
            const entryName = typeof entry === 'string' ? entry : entry?.name;
            if (typeof entryName !== 'string') return entry;
            const hit = toggled.find(([name]) => pluginEntryMatchesName(entryName, name));
            if (!hit) return entry;
            const [, enabled] = hit;
            if (typeof entry === 'string') return enabled ? entry : { name: entry, enabled: false };
            return { ...entry, enabled };
          });
        }
      }

      // Chimera (post-session review) → extensions['wstack-chimera']
      // Matches the ResolvedChimeraConfig shape from chimera-plugin.ts:34.
      const chimeraTouched =
        typeof payload['chimeraEnabled'] === 'boolean' ||
        typeof payload['chimeraProvider'] === 'string' ||
        typeof payload['chimeraModel'] === 'string' ||
        typeof payload['chimeraMaxFiles'] === 'number' ||
        typeof payload['chimeraAutoFix'] === 'string';
      if (chimeraTouched) {
        const ext = (decrypted.extensions as Record<string, Record<string, unknown>>) ?? {};
        const chimera = ext['wstack-chimera'] ?? {};
        if (typeof payload['chimeraEnabled'] === 'boolean')
          chimera['enabled'] = payload['chimeraEnabled'];
        if (typeof payload['chimeraProvider'] === 'string')
          chimera['provider'] = payload['chimeraProvider'];
        if (typeof payload['chimeraModel'] === 'string') chimera['model'] = payload['chimeraModel'];
        if (typeof payload['chimeraMaxFiles'] === 'number' && payload['chimeraMaxFiles'] >= 1) {
          chimera['maxFiles'] = payload['chimeraMaxFiles'];
        }
        if (typeof payload['chimeraAutoFix'] === 'string') {
          if (
            payload['chimeraAutoFix'] === 'off' ||
            payload['chimeraAutoFix'] === 'ask' ||
            payload['chimeraAutoFix'] === 'auto'
          ) {
            chimera['autoFix'] = payload['chimeraAutoFix'];
          }
        }
        ext['wstack-chimera'] = chimera;
        decrypted.extensions = ext;
      }

      // Auto-review (mid-session continuous) → extensions['wstack-auto-review']
      // Matches the ResolvedAutoReviewConfig shape from auto-review-plugin.ts:42.
      const autoReviewTouched =
        typeof payload['autoReviewEnabled'] === 'boolean' ||
        typeof payload['autoReviewProvider'] === 'string' ||
        typeof payload['autoReviewModel'] === 'string' ||
        typeof payload['autoReviewFallbackProfile'] === 'string' ||
        typeof payload['autoReviewModelSelection'] === 'string' ||
        Array.isArray(payload['autoReviewFallbackModels']) ||
        typeof payload['autoReviewDebounceMs'] === 'number' ||
        typeof payload['autoReviewMaxFilesPerBatch'] === 'number' ||
        typeof payload['autoReviewMaxConcurrentReviews'] === 'number' ||
        typeof payload['autoReviewCascadeOn'] === 'string';
      if (autoReviewTouched) {
        const ext = (decrypted.extensions as Record<string, Record<string, unknown>>) ?? {};
        const ar = ext['wstack-auto-review'] ?? {};
        if (typeof payload['autoReviewEnabled'] === 'boolean')
          ar['enabled'] = payload['autoReviewEnabled'];
        if (typeof payload['autoReviewProvider'] === 'string')
          ar['provider'] = payload['autoReviewProvider'];
        if (typeof payload['autoReviewModel'] === 'string')
          ar['model'] = payload['autoReviewModel'];
        if (typeof payload['autoReviewFallbackProfile'] === 'string') {
          // Empty string = clear the named profile (plugin falls back to
          // resolveEffective({ fallbackAuto: true })).
          if (payload['autoReviewFallbackProfile'] === '') {
            delete ar['fallbackProfile'];
          } else {
            ar['fallbackProfile'] = payload['autoReviewFallbackProfile'];
          }
        }
        if (
          payload['autoReviewModelSelection'] === 'round-robin' ||
          payload['autoReviewModelSelection'] === 'random'
        ) {
          ar['modelSelection'] = payload['autoReviewModelSelection'];
        }
        // Note: `autoReviewFallbackModels` is not a config input — it's
        // derived from `fallbackProfile` + `config.fallbackModels` by the
        // plugin's resolver. Ignore incoming writes to avoid silently
        // persisting a value that the plugin discards on every load.
        if (
          typeof payload['autoReviewDebounceMs'] === 'number' &&
          payload['autoReviewDebounceMs'] >= 0
        ) {
          ar['debounceMs'] = payload['autoReviewDebounceMs'];
        }
        if (
          typeof payload['autoReviewMaxFilesPerBatch'] === 'number' &&
          payload['autoReviewMaxFilesPerBatch'] >= 1
        ) {
          ar['maxFilesPerBatch'] = payload['autoReviewMaxFilesPerBatch'];
        }
        if (
          typeof payload['autoReviewMaxConcurrentReviews'] === 'number' &&
          payload['autoReviewMaxConcurrentReviews'] >= 1
        ) {
          ar['maxConcurrentReviews'] = payload['autoReviewMaxConcurrentReviews'];
        }
        if (typeof payload['autoReviewCascadeOn'] === 'string') {
          if (
            payload['autoReviewCascadeOn'] === 'off' ||
            payload['autoReviewCascadeOn'] === 'critical' ||
            payload['autoReviewCascadeOn'] === 'high'
          ) {
            ar['cascadeOn'] = payload['autoReviewCascadeOn'];
          }
        }
        ext['wstack-auto-review'] = ar;
        decrypted.extensions = ext;
      }
    },
    'prefs',
  );
}
