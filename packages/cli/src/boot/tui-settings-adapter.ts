/**
 * TUI Settings adapter — extracted from the runTui() options literal.
 *
 * Phase C step 1. The getSettings/saveSettings pair (~337 lines) reads
 * config from the ConfigStore and persists changes to disk. This module
 * owns both functions, receiving its dependencies through a typed context.
 *
 * `getSettings()` maps the full Config into the flat LiveSettingsInput
 * shape the TUI SettingsPicker consumes. `saveSettings()` does the
 * reverse: read → modify → encrypt → atomic-write for every section,
 * then syncs the in-memory store and applies live runtime effects.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type Config,
  type ConfigStore,
  type WstackPaths,
  atomicWrite,
  decryptConfigSecrets,
  encryptConfigSecrets,
  noOpVault,
  normalizeTokenSavingTier,
} from '@wrongstack/core';
import { deriveFsAccessPair, filterSafeForProject } from '../settings-menu.js';
import { normalizeTuiThinkingWord } from '../tui-thinking-word.js';
import type { LiveSettingsInput } from '../execution.js';

export interface SettingsAdapterContext {
  configStore: ConfigStore;
  wpaths: WstackPaths;
  fleetStreamController: { setEnabled: (enabled: boolean) => void } | undefined;
  applyLiveSettings: ((s: LiveSettingsInput) => void) | undefined;
}

export interface SettingsAdapter {
  getSettings: () => Record<string, unknown>;
  saveSettings: (s: LiveSettingsInput) => Promise<string | null>;
}

const ANIMATION_STYLES = ['rainbow', 'wave', 'pulse', 'dots', 'breathe', 'cycle'] as const;
type AnimationStyleValue = (typeof ANIMATION_STYLES)[number];

/** Widen an untyped config value to the animation-style union; default 'rainbow'. */
function normalizeAnimationStyle(raw: unknown): AnimationStyleValue {
  return typeof raw === 'string' && (ANIMATION_STYLES as readonly string[]).includes(raw)
    ? (raw as AnimationStyleValue)
    : 'rainbow';
}

/**
 * Build the getSettings/saveSettings pair for the TUI SettingsPicker.
 *
 * `getSettings` reads from the live ConfigStore on every call.
 * `saveSettings` persists to disk (global or project-local config),
 * syncs the in-memory store, and applies runtime effects immediately.
 */
export function createSettingsAdapter(ctx: SettingsAdapterContext): SettingsAdapter {
  const { configStore, wpaths, fleetStreamController, applyLiveSettings } = ctx;

  // Filesystem-access pair derivation is shared with the slash command
  // and the cli-main live-apply path. See settings-menu.ts for the
  // single source of truth and the precedence rules.
  const deriveFsAccess = deriveFsAccessPair;

  function getSettings(): Record<string, unknown> {
    const cfg = configStore.get();
    const autonomy = cfg.autonomy as Record<string, unknown> | undefined;
    const rawMode = autonomy?.defaultMode as string | undefined;
    const mode: 'off' | 'suggest' | 'auto' =
      rawMode === 'suggest' || rawMode === 'auto' ? rawMode : 'off';
    const modelRuntime = (cfg as { modelRuntime?: { reasoning?: { mode?: string; effort?: string; preserve?: boolean }; cache?: { ttl?: string } } }).modelRuntime;
    const contextModeRaw = cfg.context?.mode;
    const contextMode =
      contextModeRaw === 'frugal' || contextModeRaw === 'deep' || contextModeRaw === 'archival'
        ? contextModeRaw
        : 'balanced';
    const reasoningEffortRaw = modelRuntime?.reasoning?.effort;
    const reasoningEffort =
      reasoningEffortRaw === 'none' ||
      reasoningEffortRaw === 'minimal' ||
      reasoningEffortRaw === 'low' ||
      reasoningEffortRaw === 'medium' ||
      reasoningEffortRaw === 'high' ||
      reasoningEffortRaw === 'xhigh' ||
      reasoningEffortRaw === 'max'
        ? reasoningEffortRaw
        : 'high';
    // Resolve the filesystem-access pair from whichever side of the
    // duplicated config (features.allowOutsideProjectRoot vs
    // tools.restrictToProjectRoot) the user actually wrote. They MUST
    // round-trip as inverses of each other — otherwise the picker would
    // show contradictory values, and saving would silently flip the
    // user's intent. Source of truth order matches `deriveFsAccessPair`
    // in settings-menu.ts: features.allowOutsideProjectRoot wins if set.
    const featuresAllow = cfg.features?.allowOutsideProjectRoot;
    const toolsRestrict = cfg.tools?.restrictToProjectRoot;
    const resolvedAllow =
      featuresAllow !== undefined
        ? featuresAllow
        : toolsRestrict !== undefined
          ? !toolsRestrict
          : true;
    const resolvedRestrict = !resolvedAllow;
    return {
      mode,
      delayMs: (autonomy?.autoProceedDelayMs as number) ?? 45_000,
      titleAnimation: autonomy?.terminalTitleAnimation !== false,
      yolo: cfg.yolo ?? ((autonomy?.yolo as boolean | undefined) ?? false),
      streamFleet: autonomy?.streamFleet !== false,
      chime: (autonomy?.chime as boolean) ?? false,
      confirmExit: autonomy?.confirmExit !== false,
      nextPrediction: cfg.nextPrediction ?? false,
      featureMcp: cfg.features?.mcp !== false,
      featurePlugins: cfg.features?.plugins !== false,
      featureMemory: cfg.features?.memory !== false,
      featureSkills: cfg.features?.skills !== false,
      featureModelsRegistry: cfg.features?.modelsRegistry !== false,
      featureTokenSaving: normalizeTokenSavingTier(cfg.features?.tokenSavingMode),
      allowOutsideProjectRoot: resolvedAllow,
      contextAutoCompact: cfg.context?.autoCompact !== false,
      contextStrategy: cfg.context?.strategy ?? 'hybrid',
      contextMode,
      maxConcurrent: cfg.maxConcurrent ?? 4,
      logLevel: cfg.log?.level ?? 'info',
      auditLevel: cfg.session?.auditLevel ?? 'standard',
      indexOnStart: cfg.indexing?.onSessionStart !== false,
      maxIterations: cfg.tools?.maxIterations ?? 500,
      restrictFsToRoot: resolvedRestrict,
      autoProceedMaxIterations:
        ((cfg.autonomy as Record<string, unknown> | undefined)
          ?.autoProceedMaxIterations as number) ?? 50,
      debugStream: cfg.debugStream ?? false,
      shellBangWarningDontShowAgain: autonomy?.shellBangWarningDontShowAgain === true,
      statuslineMode: autonomy?.statuslineMode === 'minimum' ? 'minimum' : 'detailed',
      thinkingWord: normalizeTuiThinkingWord(autonomy?.thinkingWord),
      animationStyle: normalizeAnimationStyle(autonomy?.animationStyle),
      configScope: cfg.configScope ?? 'global',
      enhanceDelayMs:
        ((cfg.autonomy as Record<string, unknown> | undefined)?.enhanceDelayMs as number) ??
        60_000,
      enhanceEnabled:
        ((cfg.autonomy as Record<string, unknown> | undefined)?.enhance as boolean) ?? true,
      enhanceLanguage:
        (cfg.autonomy as Record<string, unknown> | undefined)?.enhanceLanguage === 'english'
          ? ('english' as const)
          : ('original' as const),
      midRunSendPicker:
        ((cfg.autonomy as Record<string, unknown> | undefined)?.midRunSendPicker as boolean) ?? true,
      mouseMode: (autonomy?.mouseMode as boolean) ?? false,
      autonomyNextPrompt:
        ((cfg.autonomy as Record<string, unknown> | undefined)
          ?.autonomyNextPrompt as string | undefined) ?? 'auto {{suggestion}}',
      reasoningMode:
        modelRuntime?.reasoning?.mode === 'on' || modelRuntime?.reasoning?.mode === 'off'
          ? modelRuntime.reasoning.mode
          : 'auto',
      reasoningEffort,
      reasoningPreserve: modelRuntime?.reasoning?.preserve === true,
      cacheTtl:
        modelRuntime?.cache?.ttl === '5m' || modelRuntime?.cache?.ttl === '1h'
          ? modelRuntime.cache.ttl
          : 'default',
      breakerEnabled: cfg.circuitBreaker?.enabled === true,
      breakerAutoKillResetMs: cfg.circuitBreaker?.autoKillResetMs ?? 60_000,
    };
  }

  async function saveSettings(s: LiveSettingsInput): Promise<string | null> {
    try {
      // Persist the full TUI settings snapshot to one target file. This keeps
      // global/project scope switches coherent: autonomy, UX, refine, and the
      // other settings all land in the newly selected scope together.
      if (
        s.mode !== undefined ||
        s.delayMs !== undefined ||
        s.titleAnimation !== undefined ||
        s.yolo !== undefined ||
        s.streamFleet !== undefined ||
        s.chime !== undefined ||
        s.confirmExit !== undefined ||
        s.mouseMode !== undefined ||
        s.featureMcp !== undefined ||
        s.featurePlugins !== undefined ||
        s.featureMemory !== undefined ||
        s.featureSkills !== undefined ||
        s.featureModelsRegistry !== undefined ||
        s.featureTokenSaving !== undefined ||
        s.allowOutsideProjectRoot !== undefined ||
        s.contextAutoCompact !== undefined ||
        s.contextStrategy !== undefined ||
        s.contextMode !== undefined ||
        s.maxConcurrent !== undefined ||
        s.logLevel !== undefined ||
        s.auditLevel !== undefined ||
        s.indexOnStart !== undefined ||
        s.maxIterations !== undefined ||
        s.restrictFsToRoot !== undefined ||
        s.nextPrediction !== undefined ||
        s.debugStream !== undefined ||
        s.shellBangWarningDontShowAgain !== undefined ||
        s.configScope !== undefined ||
        s.enhanceDelayMs !== undefined ||
        s.enhanceEnabled !== undefined ||
        s.enhanceLanguage !== undefined ||
        s.midRunSendPicker !== undefined ||
        s.statuslineMode !== undefined ||
        s.thinkingWord !== undefined ||
        s.animationStyle !== undefined ||
        s.autonomyNextPrompt !== undefined ||
        s.autoProceedMaxIterations !== undefined ||
        s.reasoningMode !== undefined ||
        s.reasoningEffort !== undefined ||
        s.reasoningPreserve !== undefined ||
        s.cacheTtl !== undefined
      ) {
        const configScope = s.configScope ?? configStore.get().configScope ?? 'global';
        const targetPath =
          configScope === 'project' && wpaths.inProjectConfig
            ? wpaths.inProjectConfig
            : wpaths.globalConfig;
        let raw: string;
        try {
          raw = await fs.readFile(targetPath, 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new Error(
              `Failed to read config at ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            );
          }
          raw = '{}';
        }
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const decrypted = decryptConfigSecrets(parsed, noOpVault) as Record<string, unknown>;

        const autonomy = (decrypted.autonomy as Record<string, unknown>) ?? {};
        if (s.mode !== undefined) autonomy.defaultMode = s.mode;
        if (s.delayMs !== undefined) autonomy.autoProceedDelayMs = s.delayMs;
        if (s.titleAnimation !== undefined) autonomy.terminalTitleAnimation = s.titleAnimation;
        if (s.yolo !== undefined) autonomy.yolo = s.yolo;
        if (s.streamFleet !== undefined) autonomy.streamFleet = s.streamFleet;
        if (s.chime !== undefined) autonomy.chime = s.chime;
        if (s.confirmExit !== undefined) autonomy.confirmExit = s.confirmExit;
        if (s.mouseMode !== undefined) autonomy.mouseMode = s.mouseMode;
        if (s.enhanceDelayMs !== undefined) autonomy.enhanceDelayMs = s.enhanceDelayMs;
        if (s.enhanceEnabled !== undefined) autonomy.enhance = s.enhanceEnabled;
        if (s.enhanceLanguage !== undefined) autonomy.enhanceLanguage = s.enhanceLanguage;
        if (s.midRunSendPicker !== undefined) autonomy.midRunSendPicker = s.midRunSendPicker;
        if (s.shellBangWarningDontShowAgain !== undefined)
          autonomy.shellBangWarningDontShowAgain = s.shellBangWarningDontShowAgain;
        if (s.statuslineMode !== undefined) autonomy.statuslineMode = s.statuslineMode;
        if (s.thinkingWord !== undefined)
          autonomy.thinkingWord = normalizeTuiThinkingWord(s.thinkingWord);
        if (s.animationStyle !== undefined) autonomy.animationStyle = s.animationStyle;
        if (s.autonomyNextPrompt !== undefined) autonomy.autonomyNextPrompt = s.autonomyNextPrompt;
        if (s.autoProceedMaxIterations !== undefined)
          autonomy.autoProceedMaxIterations = s.autoProceedMaxIterations;
        decrypted.autonomy = autonomy;

        if (s.nextPrediction !== undefined) decrypted.nextPrediction = s.nextPrediction;
        if (s.yolo !== undefined) decrypted.yolo = s.yolo;
        // Derive the filesystem-access pair ONCE here, so both the
        // `features.allowOutsideProjectRoot` and `tools.restrictToProjectRoot`
        // writes below stay consistent. The previous implementation had three
        // separate write sites that could disagree when both picker knobs
        // were set in the same save.
        const fsAccess = deriveFsAccess(s);
        if (
          s.featureMcp !== undefined ||
          s.featurePlugins !== undefined ||
          s.featureMemory !== undefined ||
          s.featureSkills !== undefined ||
          s.featureModelsRegistry !== undefined ||
          s.featureTokenSaving !== undefined ||
          fsAccess !== undefined
        ) {
          const feats = (decrypted.features as Record<string, unknown>) ?? {};
          if (s.featureMcp !== undefined) feats.mcp = s.featureMcp;
          if (s.featurePlugins !== undefined) feats.plugins = s.featurePlugins;
          if (s.featureMemory !== undefined) feats.memory = s.featureMemory;
          if (s.featureSkills !== undefined) feats.skills = s.featureSkills;
          if (s.featureModelsRegistry !== undefined) feats.modelsRegistry = s.featureModelsRegistry;
          if (s.featureTokenSaving !== undefined) feats.tokenSavingMode = s.featureTokenSaving;
          if (fsAccess !== undefined) feats.allowOutsideProjectRoot = fsAccess.allowOutsideProjectRoot;
          decrypted.features = feats;
        }
        if (
          s.contextAutoCompact !== undefined ||
          s.contextStrategy !== undefined ||
          s.contextMode !== undefined
        ) {
          const c = (decrypted.context as Record<string, unknown>) ?? {};
          if (s.contextAutoCompact !== undefined) c.autoCompact = s.contextAutoCompact;
          if (s.contextStrategy !== undefined) c.strategy = s.contextStrategy;
          if (s.contextMode !== undefined) c.mode = s.contextMode;
          decrypted.context = c;
        }
        if (s.maxConcurrent !== undefined) decrypted.maxConcurrent = s.maxConcurrent;
        if (s.logLevel !== undefined) {
          const log = (decrypted.log as Record<string, unknown>) ?? {};
          log.level = s.logLevel;
          decrypted.log = log;
        }
        if (s.auditLevel !== undefined) {
          const sess = (decrypted.session as Record<string, unknown>) ?? {};
          sess.auditLevel = s.auditLevel;
          decrypted.session = sess;
        }
        if (s.indexOnStart !== undefined) {
          const idx = (decrypted.indexing as Record<string, unknown>) ?? {};
          idx.onSessionStart = s.indexOnStart;
          decrypted.indexing = idx;
        }
        if (
          s.maxIterations !== undefined ||
          fsAccess !== undefined
        ) {
          const tools = (decrypted.tools as Record<string, unknown>) ?? {};
          if (s.maxIterations !== undefined) tools.maxIterations = s.maxIterations;
          // Single source of truth for the inverse: deriveFsAccess above.
          if (fsAccess !== undefined) tools.restrictToProjectRoot = fsAccess.restrictToProjectRoot;
          decrypted.tools = tools;
        }
        if (s.debugStream !== undefined) {
          decrypted.debugStream = s.debugStream;
          const { setDebugStreamEnabled } = await import('@wrongstack/providers');
          setDebugStreamEnabled(s.debugStream);
        }
        if (s.configScope !== undefined) decrypted.configScope = s.configScope;
        if (
          s.reasoningMode !== undefined ||
          s.reasoningEffort !== undefined ||
          s.reasoningPreserve !== undefined ||
          s.cacheTtl !== undefined
        ) {
          const modelRuntime = (decrypted.modelRuntime as Record<string, unknown>) ?? {};
          if (
            s.reasoningMode !== undefined ||
            s.reasoningEffort !== undefined ||
            s.reasoningPreserve !== undefined
          ) {
            const reasoning = (modelRuntime.reasoning as Record<string, unknown>) ?? {};
            if (s.reasoningMode !== undefined) reasoning.mode = s.reasoningMode;
            if (s.reasoningEffort !== undefined) reasoning.effort = s.reasoningEffort;
            if (s.reasoningPreserve !== undefined) reasoning.preserve = s.reasoningPreserve;
            modelRuntime.reasoning = reasoning;
          }
          if (s.cacheTtl !== undefined) {
            const cache = (modelRuntime.cache as Record<string, unknown>) ?? {};
            if (s.cacheTtl === 'default') {
              delete cache.ttl;
            } else {
              cache.ttl = s.cacheTtl;
            }
            if (Object.keys(cache).length > 0) modelRuntime.cache = cache;
            else delete modelRuntime.cache;
          }
          decrypted.modelRuntime = modelRuntime;
        }
        const toWrite = targetPath === wpaths.globalConfig ? decrypted : filterSafeForProject(decrypted);
        const encrypted = encryptConfigSecrets(toWrite, noOpVault);
        if (targetPath !== wpaths.globalConfig) {
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
        }
        await atomicWrite(targetPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });

        const currentConfig = configStore.get();
        const nextModelRuntime = {
          ...currentConfig.modelRuntime,
          ...((decrypted.modelRuntime as Record<string, unknown> | undefined) ?? {}),
        } as Record<string, unknown>;
        if (s.cacheTtl === 'default') {
          delete nextModelRuntime.cache;
        }

        configStore.update({
          ...(s.nextPrediction !== undefined ? { nextPrediction: s.nextPrediction } : {}),
          ...(s.yolo !== undefined ? { yolo: s.yolo } : {}),
          ...(s.featureMcp !== undefined ||
          s.featurePlugins !== undefined ||
          s.featureMemory !== undefined ||
          s.featureSkills !== undefined ||
          s.featureModelsRegistry !== undefined ||
          s.featureTokenSaving !== undefined ||
          fsAccess !== undefined
            ? {
                features: {
                  ...currentConfig.features,
                  ...((decrypted.features as Record<string, unknown> | undefined) ?? {}),
                } as Config['features'],
              }
            : {}),
          ...(s.contextAutoCompact !== undefined ||
          s.contextStrategy !== undefined ||
          s.contextMode !== undefined
            ? {
                context: {
                  ...currentConfig.context,
                  ...((decrypted.context as Record<string, unknown> | undefined) ?? {}),
                } as Config['context'],
              }
            : {}),
          ...(s.maxConcurrent !== undefined ? { maxConcurrent: s.maxConcurrent } : {}),
          ...(s.logLevel !== undefined
            ? {
                log: {
                  ...currentConfig.log,
                  ...((decrypted.log as Record<string, unknown> | undefined) ?? {}),
                } as Config['log'],
              }
            : {}),
          ...(s.auditLevel !== undefined
            ? {
                session: {
                  ...currentConfig.session,
                  ...((decrypted.session as Record<string, unknown> | undefined) ?? {}),
                } as Config['session'],
              }
            : {}),
          ...(s.indexOnStart !== undefined
            ? {
                indexing: {
                  ...currentConfig.indexing,
                  ...((decrypted.indexing as Record<string, unknown> | undefined) ?? {}),
                } as Config['indexing'],
              }
            : {}),
          ...(s.maxIterations !== undefined ||
          fsAccess !== undefined
            ? {
                tools: {
                  ...currentConfig.tools,
                  ...((decrypted.tools as Record<string, unknown> | undefined) ?? {}),
                } as Config['tools'],
              }
            : {}),
          ...(s.debugStream !== undefined ? { debugStream: s.debugStream } : {}),
          ...(s.configScope !== undefined ? { configScope: s.configScope as 'global' | 'project' } : {}),
          autonomy: {
            ...currentConfig.autonomy,
            ...((decrypted.autonomy as Record<string, unknown> | undefined) ?? {}),
          } as Config['autonomy'],
          ...(s.reasoningMode !== undefined ||
          s.reasoningEffort !== undefined ||
          s.reasoningPreserve !== undefined ||
          s.cacheTtl !== undefined
            ? {
                modelRuntime: nextModelRuntime as Config['modelRuntime'],
              }
            : {}),
        });
      }

      if (s.streamFleet !== undefined) fleetStreamController?.setEnabled(s.streamFleet);
      applyLiveSettings?.(s);
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.debug(
        JSON.stringify({
          level: 'error',
          event: 'execution.settings_persist_failed',
          message,
          errorName: err instanceof Error ? err.name : undefined,
          timestamp: new Date().toISOString(),
        }),
      );
      return message;
    }
  }

  return { getSettings, saveSettings };
}
