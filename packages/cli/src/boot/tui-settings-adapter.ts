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

import type {
  Config,
  ConfigStore,
  FleetChatVerbosity,
  SecretVault,
} from '@wrongstack/contracts/types';
import {
  isSystemInstructionVariant,
  persistSystemPromptVariant,
  readSavedSystemPromptVariant,
  type SystemInstructionVariant,
} from '@wrongstack/core/agent';

import type { WstackPaths } from '@wrongstack/core/utils';
import { getProcessRegistry } from '@wrongstack/tools';
import type { LiveSettingsInput } from '../live-settings-input.js';
import { activeProfileConfigPath } from '../profile-config-path.js';
import { deriveFsAccessPair, persistConfigSetting } from '../settings-menu.js';
import { normalizeTuiThinkingWord } from '../tui-thinking-word.js';
import { readTuiSettings } from './tui-settings-read.js';

interface SettingsAdapterContext {
  configStore: ConfigStore;
  wpaths: WstackPaths;
  vault: SecretVault;
  fleetStreamController: { setMode?: ((mode: FleetChatVerbosity) => void) | undefined } | undefined;
  applyLiveSettings: ((s: LiveSettingsInput) => void) | undefined;
}

interface SettingsAdapter {
  getSettings: () => Record<string, unknown>;
  saveSettings: (s: LiveSettingsInput) => Promise<string | null>;
}

/**
 * Build the getSettings/saveSettings pair for the TUI SettingsPicker.
 *
 * `getSettings` reads from the live ConfigStore on every call.
 * `saveSettings` persists to disk (global or project-local config),
 * syncs the in-memory store, and applies runtime effects immediately.
 */
export function createSettingsAdapter(ctx: SettingsAdapterContext): SettingsAdapter {
  const { configStore, wpaths, vault, fleetStreamController, applyLiveSettings } = ctx;

  // Filesystem-access pair derivation is shared with the slash command
  // and the cli-main live-apply path. See settings-menu.ts for the
  // single source of truth and the precedence rules.
  const deriveFsAccess = deriveFsAccessPair;

  // System prompt chosen for the next session. Kept out of the live
  // ConfigStore on purpose: the store's variant drives this session's status
  // bar and tool surface, which must keep describing the prompt it runs on.
  let nextSystemPromptVariant: SystemInstructionVariant | undefined;
  // Seed from disk: a Scout picked "for this launch only" outside a project
  // is in the store but not saved, so the store alone would show the wrong
  // next-session value.
  void (async () => {
    const saved = await readSavedSystemPromptVariant(
      activeProfileConfigPath(wpaths, configStore.get()),
    );
    if (saved && nextSystemPromptVariant === undefined) nextSystemPromptVariant = saved;
  })().catch(() => undefined);

  function getSettings(): Record<string, unknown> {
    const settings = readTuiSettings(configStore);
    return {
      ...settings,
      nextSystemPromptVariant: nextSystemPromptVariant ?? settings.systemPromptVariant,
    };
  }

  async function saveSettings(s: LiveSettingsInput): Promise<string | null> {
    try {
      // Profile config, like the startup menu that reads it next launch
      // (`readSavedSystemPromptVariant(profileConfigPath)`). The picker
      // auto-saves its whole snapshot, so write only on an actual change.
      if (isSystemInstructionVariant(s.nextSystemPromptVariant)) {
        const pending = getSettings().nextSystemPromptVariant;
        if (s.nextSystemPromptVariant !== pending) {
          await persistSystemPromptVariant(
            activeProfileConfigPath(wpaths, configStore.get()),
            s.nextSystemPromptVariant,
          );
          nextSystemPromptVariant = s.nextSystemPromptVariant;
        }
      }
      // Persist the full TUI settings snapshot to one target file. This keeps
      // global/project scope switches coherent: autonomy, UX, refine, and the
      // other settings all land in the newly selected scope together.
      if (
        s.mode !== undefined ||
        s.delayMs !== undefined ||
        s.titleAnimation !== undefined ||
        s.yolo !== undefined ||
        s.fleetChatVerbosity !== undefined ||
        s.chime !== undefined ||
        s.confirmExit !== undefined ||
        s.mouseMode !== undefined ||
        s.featureMcp !== undefined ||
        s.featurePlugins !== undefined ||
        s.featureMemory !== undefined ||
        s.featureSkills !== undefined ||
        s.featureModelsRegistry !== undefined ||
        s.featureToolCoach !== undefined ||
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
        s.multiDiffSummaryThreshold !== undefined ||
        s.nextStepsTool !== undefined ||
        s.nextStepsRequired !== undefined ||
        s.rememberStartupChoices !== undefined ||
        s.restrictFsToRoot !== undefined ||
        s.nextPrediction !== undefined ||
        s.debugStream !== undefined ||
        s.shellBangWarningDontShowAgain !== undefined ||
        s.configScope !== undefined ||
        s.enhanceDelayMs !== undefined ||
        s.enhanceEnabled !== undefined ||
        s.preRefineSeconds !== undefined ||
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
        s.cacheTtl !== undefined ||
        s.breakerEnabled !== undefined ||
        s.breakerAutoKillResetMs !== undefined ||
        s.showModelReasoning !== undefined ||
        s.toolResultViewMode !== undefined ||
        s.selectionMode !== undefined ||
        s.showAgentSwarmPanel !== undefined ||
        s.showSidebar !== undefined ||
        s.panelPositions !== undefined ||
        s.lastSettingsField !== undefined ||
        s.showSageMemoryInject !== undefined ||
        s.sageMemoryInjectThreshold !== undefined ||
        s.readSymbols !== undefined ||
        // WrongProxy / WrongTrace: gate the persisted-section write on
        // either key being present in the live patch. Without this, a
        // picker toggle round-trip would silently no-op the persistence
        // layer (the runtime probe would never read the change).
        s.wrongProxyEnabled !== undefined ||
        s.wrongProxyUrl !== undefined
      ) {
        const cfg = configStore.get();
        // Delegate path resolution to the canonical resolver. This keeps
        // the three-way routing (project → profile → bootstrap) consistent
        // with the settings-menu.ts slash commands and the run-tui live-apply
        // path; a future fourth target (e.g. org config) only needs one update.
        const persistDeps = {
          configStore,
          // Third copy of "which profile is active" — an inline cast plus a
          // `?? 'default'`, identical to `activeProfileConfigPath` two files
          // over. The comment above already promised this resolution was
          // delegated; now it is.
          profileConfigPath: activeProfileConfigPath(wpaths, cfg),
          inProjectConfigPath: wpaths.inProjectConfig,
          vault,
          resolveProfilePath: (name: string) => wpaths.profileConfig(name),
        };
        let fsAccess: ReturnType<typeof deriveFsAccess>;
        let decrypted: Record<string, unknown> = {};
        await persistConfigSetting(persistDeps, (nextConfig) => {
          decrypted = nextConfig;
          const autonomy = (decrypted.autonomy as Record<string, unknown>) ?? {};
          if (s.mode !== undefined) autonomy.defaultMode = s.mode;
          if (s.delayMs !== undefined) autonomy.autoProceedDelayMs = s.delayMs;
          if (s.titleAnimation !== undefined) autonomy.terminalTitleAnimation = s.titleAnimation;
          if (s.yolo !== undefined) autonomy.yolo = s.yolo;
          if (s.fleetChatVerbosity !== undefined) {
            autonomy.fleetChatVerbosity = s.fleetChatVerbosity;
          }
          if (s.chime !== undefined) autonomy.chime = s.chime;
          if (s.confirmExit !== undefined) autonomy.confirmExit = s.confirmExit;
          if (s.mouseMode !== undefined) autonomy.mouseMode = s.mouseMode;
          if (s.enhanceDelayMs !== undefined) autonomy.enhanceDelayMs = s.enhanceDelayMs;
          if (s.enhanceEnabled !== undefined) autonomy.enhance = s.enhanceEnabled;
          if (s.preRefineSeconds !== undefined) autonomy.preRefineSeconds = s.preRefineSeconds;
          if (s.enhanceLanguage !== undefined) autonomy.enhanceLanguage = s.enhanceLanguage;
          if (s.midRunSendPicker !== undefined) autonomy.midRunSendPicker = s.midRunSendPicker;
          if (s.shellBangWarningDontShowAgain !== undefined)
            autonomy.shellBangWarningDontShowAgain = s.shellBangWarningDontShowAgain;
          if (s.statuslineMode !== undefined) autonomy.statuslineMode = s.statuslineMode;
          if (s.thinkingWord !== undefined)
            autonomy.thinkingWord = normalizeTuiThinkingWord(s.thinkingWord);
          if (s.animationStyle !== undefined) autonomy.animationStyle = s.animationStyle;
          if (s.showModelReasoning !== undefined)
            autonomy.showModelReasoning = s.showModelReasoning;
          if (s.toolResultViewMode !== undefined)
            autonomy.toolResultViewMode = s.toolResultViewMode;
          if (s.selectionMode !== undefined) autonomy.selectionMode = s.selectionMode;
          if (s.showAgentSwarmPanel !== undefined)
            autonomy.showAgentSwarmPanel = s.showAgentSwarmPanel;
          if (s.showSidebar !== undefined) autonomy.showSidebar = s.showSidebar;
          if (s.panelPositions !== undefined) autonomy.panelPositions = s.panelPositions;
          if (s.lastSettingsField !== undefined) autonomy.lastSettingsField = s.lastSettingsField;
          if (s.showSageMemoryInject !== undefined)
            autonomy.showSageMemoryInject = s.showSageMemoryInject;
          if (s.readSymbols !== undefined) autonomy.readAdvancedMode = s.readSymbols;
          if (s.autonomyNextPrompt !== undefined)
            autonomy.autonomyNextPrompt = s.autonomyNextPrompt;
          if (s.autoProceedMaxIterations !== undefined)
            autonomy.autoProceedMaxIterations = s.autoProceedMaxIterations;
          if (s.nextStepsRequired !== undefined)
            autonomy.nextSteps = s.nextStepsRequired ? 'required' : 'optional';
          decrypted.autonomy = autonomy;

          if (s.nextPrediction !== undefined) decrypted.nextPrediction = s.nextPrediction;
          if (s.yolo !== undefined) decrypted.yolo = s.yolo;
          // Derive the filesystem-access pair ONCE here, so both the
          // `features.allowOutsideProjectRoot` and `tools.restrictToProjectRoot`
          // writes below stay consistent. The previous implementation had three
          // separate write sites that could disagree when both picker knobs
          // were set in the same save.
          fsAccess = deriveFsAccess(s);
          if (
            s.featureMcp !== undefined ||
            s.featurePlugins !== undefined ||
            s.featureMemory !== undefined ||
            s.featureSkills !== undefined ||
            s.featureModelsRegistry !== undefined ||
            s.featureToolCoach !== undefined ||
            s.featureTokenSaving !== undefined ||
            fsAccess !== undefined
          ) {
            const feats = (decrypted.features as Record<string, unknown>) ?? {};
            if (s.featureMcp !== undefined) feats.mcp = s.featureMcp;
            if (s.featurePlugins !== undefined) feats.plugins = s.featurePlugins;
            if (s.featureMemory !== undefined) feats.memory = s.featureMemory;
            if (s.featureSkills !== undefined) feats.skills = s.featureSkills;
            if (s.featureModelsRegistry !== undefined)
              feats.modelsRegistry = s.featureModelsRegistry;
            if (s.featureToolCoach !== undefined) feats.toolCoach = s.featureToolCoach;
            if (s.featureTokenSaving !== undefined) feats.tokenSavingMode = s.featureTokenSaving;
            if (fsAccess !== undefined)
              feats.allowOutsideProjectRoot = fsAccess.allowOutsideProjectRoot;
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
          if (s.rememberStartupChoices !== undefined) {
            const launch = (decrypted.launch as Record<string, unknown>) ?? {};
            launch.rememberStartupChoices = s.rememberStartupChoices;
            decrypted.launch = launch;
          }
          if (
            s.maxIterations !== undefined ||
            s.nextStepsTool !== undefined ||
            fsAccess !== undefined ||
            // WrongProxy / WrongTrace: include either key in the tools-section
            // write guard so a picker toggle round-trip actually persists to
            // `tools.wrongProxy.{enabled,url}`. Without this, the gate at
            // line 279 would short-circuit and skip the whole section write.
            s.wrongProxyEnabled !== undefined ||
            s.wrongProxyUrl !== undefined
          ) {
            const tools = (decrypted.tools as Record<string, unknown>) ?? {};
            if (s.maxIterations !== undefined) tools.maxIterations = s.maxIterations;
            // Multi-diff summary threshold — persisted on the Tools section so
            // it travels with `maxIterations` (both gate on the Tools write
            // trigger and land under `decrypted.tools`). Mirrors the WebUI
            // pref-helpers.ts setAutonomy('multiDiffSummaryThreshold', ...)
            // path and the overlay-key-router.ts:331 read.
            if (s.multiDiffSummaryThreshold !== undefined) {
              tools.multiDiffSummaryThreshold = s.multiDiffSummaryThreshold;
            }
            if (s.nextStepsTool !== undefined) tools.nextsteps = { enabled: s.nextStepsTool };
            // Single source of truth for the inverse: deriveFsAccess above.
            if (fsAccess !== undefined)
              tools.restrictToProjectRoot = fsAccess.restrictToProjectRoot;
            // WrongProxy / WrongTrace: write to `tools.wrongProxy.{enabled,url}`
            // as a single nested object (mirrors the WebUI `LocalPrefs`
            // shape). Only assign when the key is present in the live
            // patch so unset keys preserve their on-disk values.
            if (s.wrongProxyEnabled !== undefined || s.wrongProxyUrl !== undefined) {
              const wp = (tools.wrongProxy as Record<string, unknown>) ?? {};
              if (s.wrongProxyEnabled !== undefined) wp.enabled = s.wrongProxyEnabled;
              if (s.wrongProxyUrl !== undefined) wp.url = s.wrongProxyUrl;
              tools.wrongProxy = wp;
            }
            decrypted.tools = tools;
          }
          if (s.debugStream !== undefined) {
            decrypted.debugStream = s.debugStream;
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
          if (s.sageMemoryInjectThreshold !== undefined) {
            const sageSec = (decrypted.Sage as Record<string, unknown>) ?? {};
            const inject = (sageSec.inject as Record<string, unknown>) ?? {};
            inject.relationFloor = s.sageMemoryInjectThreshold;
            sageSec.inject = inject;
            decrypted.Sage = sageSec;
          }
          if (s.breakerEnabled !== undefined || s.breakerAutoKillResetMs !== undefined) {
            const cb = (decrypted.circuitBreaker as Record<string, unknown>) ?? {};
            if (s.breakerEnabled !== undefined) cb.enabled = s.breakerEnabled;
            if (s.breakerAutoKillResetMs !== undefined)
              cb.autoKillResetMs = s.breakerAutoKillResetMs;
            decrypted.circuitBreaker = cb;
          }
        });

        const effectiveScope = s.configScope ?? cfg.configScope;
        const hasProfileOnlySettings =
          s.mode !== undefined ||
          s.yolo !== undefined ||
          s.nextStepsRequired !== undefined ||
          fsAccess !== undefined ||
          s.maxIterations !== undefined ||
          s.wrongProxyEnabled !== undefined ||
          s.wrongProxyUrl !== undefined;
        if (effectiveScope === 'project' && hasProfileOnlySettings) {
          await persistConfigSetting(
            { ...persistDeps, forceGlobal: true, updateStore: false },
            (profileConfig) => {
              if (
                s.mode !== undefined ||
                s.yolo !== undefined ||
                s.nextStepsRequired !== undefined
              ) {
                const autonomy = (profileConfig.autonomy as Record<string, unknown>) ?? {};
                if (s.mode !== undefined) autonomy.defaultMode = s.mode;
                if (s.yolo !== undefined) autonomy.yolo = s.yolo;
                // User-owned: a project config cannot carry it (in-project policy).
                if (s.nextStepsRequired !== undefined)
                  autonomy.nextSteps = s.nextStepsRequired ? 'required' : 'optional';
                profileConfig.autonomy = autonomy;
              }
              if (s.yolo !== undefined) profileConfig.yolo = s.yolo;
              if (fsAccess !== undefined) {
                const features = (profileConfig.features as Record<string, unknown>) ?? {};
                features.allowOutsideProjectRoot = fsAccess.allowOutsideProjectRoot;
                profileConfig.features = features;
              }
              if (
                fsAccess !== undefined ||
                s.maxIterations !== undefined ||
                s.wrongProxyEnabled !== undefined ||
                s.wrongProxyUrl !== undefined
              ) {
                const tools = (profileConfig.tools as Record<string, unknown>) ?? {};
                if (fsAccess !== undefined)
                  tools.restrictToProjectRoot = fsAccess.restrictToProjectRoot;
                if (s.maxIterations !== undefined) tools.maxIterations = s.maxIterations;
                if (s.wrongProxyEnabled !== undefined || s.wrongProxyUrl !== undefined) {
                  const wrongProxy = (tools.wrongProxy as Record<string, unknown>) ?? {};
                  if (s.wrongProxyEnabled !== undefined) wrongProxy.enabled = s.wrongProxyEnabled;
                  if (s.wrongProxyUrl !== undefined) wrongProxy.url = s.wrongProxyUrl;
                  tools.wrongProxy = wrongProxy;
                }
                profileConfig.tools = tools;
              }
            },
          );
        }

        if (s.debugStream !== undefined) {
          const { setDebugStreamEnabled } = await import('@wrongstack/providers');
          setDebugStreamEnabled(s.debugStream);
        }

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
          s.featureToolCoach !== undefined ||
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
          ...(s.rememberStartupChoices !== undefined
            ? {
                launch: {
                  ...currentConfig.launch,
                  rememberStartupChoices: s.rememberStartupChoices,
                },
              }
            : {}),
          ...(s.maxIterations !== undefined ||
          s.multiDiffSummaryThreshold !== undefined ||
          s.nextStepsTool !== undefined ||
          fsAccess !== undefined ||
          // WrongProxy / WrongTrace: must be in the tools guard or the
          // in-memory ConfigStore never sees the freshly-saved values,
          // and the next picker open in the same process would overwrite
          // the on-disk selection with stale state. See Chimera review.
          s.wrongProxyEnabled !== undefined ||
          s.wrongProxyUrl !== undefined
            ? {
                tools: {
                  ...currentConfig.tools,
                  ...((decrypted.tools as Record<string, unknown> | undefined) ?? {}),
                } as Config['tools'],
              }
            : {}),
          ...(s.debugStream !== undefined ? { debugStream: s.debugStream } : {}),
          ...(s.configScope !== undefined
            ? { configScope: s.configScope as 'global' | 'project' }
            : {}),
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
          ...(s.breakerEnabled !== undefined || s.breakerAutoKillResetMs !== undefined
            ? {
                circuitBreaker: {
                  ...currentConfig.circuitBreaker,
                  ...((decrypted.circuitBreaker as Record<string, unknown> | undefined) ?? {}),
                } as Config['circuitBreaker'],
              }
            : {}),
          ...(s.sageMemoryInjectThreshold !== undefined
            ? {
                Sage: {
                  ...currentConfig.Sage,
                  ...((decrypted.Sage as Record<string, unknown> | undefined) ?? {}),
                  inject: {
                    ...((currentConfig.Sage?.inject as Record<string, unknown> | undefined) ?? {}),
                    ...(((decrypted.Sage as Record<string, unknown> | undefined)?.inject as
                      | Record<string, unknown>
                      | undefined) ?? {}),
                  } as Record<string, unknown>,
                } as Config['Sage'],
              }
            : {}),
        });
      }

      if (s.breakerEnabled !== undefined || s.breakerAutoKillResetMs !== undefined) {
        getProcessRegistry().setBreakerConfig({
          ...(s.breakerEnabled !== undefined ? { enabled: s.breakerEnabled } : {}),
          ...(s.breakerAutoKillResetMs !== undefined
            ? { autoKillResetMs: s.breakerAutoKillResetMs }
            : {}),
        });
      }
      if (s.fleetChatVerbosity !== undefined) {
        if (fleetStreamController?.setMode) fleetStreamController.setMode(s.fleetChatVerbosity);
      }
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
