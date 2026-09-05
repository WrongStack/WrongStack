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
import { decryptConfigSecrets, encryptConfigSecrets, noOpVault } from '@wrongstack/core/security';
import type { Config, ConfigStore, FleetChatVerbosity } from '@wrongstack/core/types';
import { normalizeTokenSavingTier, resolveFleetChatVerbosity } from '@wrongstack/core/types';
import { atomicWrite, deepMerge, type WstackPaths } from '@wrongstack/core/utils';
import { getProcessRegistry } from '@wrongstack/tools';
import type { LiveSettingsInput } from '../live-settings-input.js';
import { activeProfileConfigPath } from '../profile-config-path.js';
import {
  deriveFsAccessPair,
  filterSafeForProject,
  resolveActualTarget,
  resolvePersistPath,
} from '../settings-menu.js';
import { normalizeTuiThinkingWord } from '../tui-thinking-word.js';

/**
 * F-key panel ids in the canonical order. Mirrors `PANEL_IDS` in the TUI
 * package (packages/tui/src/ui-contracts.ts). Keep in sync — adding a new
 * panel id requires updating both lists. The CLI cannot import the TUI's
 * internal `ui-contracts` module because the TUI package only exports
 * from its root entry point.
 */
const PANEL_IDS_CLI = [
  'projectPicker',
  'fleet',
  'agents',
  'worktree',
  'plan',
  'todos',
  'queue',
  'processList',
  'goal',
  'sessions',
  'coordinator',
  'kanban',
  'connections',
] as const;

type PanelPositionCli = 'bottom' | 'sidebar';

/**
 * Coerce a persisted per-panel position map (or partial) into a full
 * map keyed by every F-key panel id. Unknown ids are dropped; missing
 * panels default to 'bottom'; invalid position values default to
 * 'bottom'. Mirrors coercePanelPositionMap in the TUI package.
 */
function coercePanelPositionMap(
  v: Partial<Record<string, PanelPositionCli>> | undefined | unknown,
): Readonly<Record<string, PanelPositionCli>> {
  const out: Record<string, PanelPositionCli> = {};
  for (const id of PANEL_IDS_CLI) {
    const value = (v as Partial<Record<string, PanelPositionCli>> | undefined)?.[id];
    out[id] = value === 'sidebar' ? 'sidebar' : 'bottom';
  }
  return out;
}

/**
 * Coerce a persisted showAgentSwarmPanel value (legacy boolean or tri-state
 * string) into a valid mode. Mirrors coerceAgentSwarmMode in the TUI package.
 */
function coerceAgentSwarmMode(
  v: boolean | string | undefined | unknown,
): 'bottom' | 'sidebar' | 'off' {
  if (v === true || v === undefined) return 'bottom';
  if (v === false) return 'off';
  if (typeof v === 'string' && (v === 'bottom' || v === 'sidebar' || v === 'off')) return v;
  return 'bottom';
}

interface SettingsAdapterContext {
  configStore: ConfigStore;
  wpaths: WstackPaths;
  fleetStreamController: { setMode?: ((mode: FleetChatVerbosity) => void) | undefined } | undefined;
  applyLiveSettings: ((s: LiveSettingsInput) => void) | undefined;
}

interface SettingsAdapter {
  getSettings: () => Record<string, unknown>;
  saveSettings: (s: LiveSettingsInput) => Promise<string | null>;
}

const ANIMATION_STYLES = [
  'rainbow',
  'wave',
  'pulse',
  'dots',
  'breathe',
  'static',
  'cycle',
] as const;
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
    const modelRuntime = (
      cfg as {
        modelRuntime?: {
          reasoning?: { mode?: string; effort?: string; preserve?: boolean };
          cache?: { ttl?: string };
        };
      }
    ).modelRuntime;
    const contextModeRaw = cfg.context?.mode;
    const contextMode =
      contextModeRaw === 'frugal' || contextModeRaw === 'deep' ? contextModeRaw : 'balanced';
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
      yolo: cfg.yolo ?? (autonomy?.yolo as boolean | undefined) ?? false,
      fleetChatVerbosity: resolveFleetChatVerbosity(cfg.autonomy),
      chime: (autonomy?.chime as boolean) ?? false,
      confirmExit: autonomy?.confirmExit !== false,
      nextPrediction: cfg.nextPrediction ?? false,
      featureMcp: cfg.features?.mcp !== false,
      featurePlugins: cfg.features?.plugins !== false,
      featureMemory: cfg.features?.memory !== false,
      featureSkills: cfg.features?.skills !== false,
      featureModelsRegistry: cfg.features?.modelsRegistry !== false,
      // Preserve the 'auto' sentinel for the picker DISPLAY (normalize would
      // collapse it to 'off', which would then overwrite 'auto' on save);
      // everything else normalizes to a concrete tier.
      featureTokenSaving:
        cfg.features?.tokenSavingMode === 'auto'
          ? 'auto'
          : normalizeTokenSavingTier(cfg.features?.tokenSavingMode),
      allowOutsideProjectRoot: resolvedAllow,
      contextAutoCompact: cfg.context?.autoCompact !== false,
      contextStrategy: cfg.context?.strategy ?? 'hybrid',
      contextMode,
      maxConcurrent: cfg.maxConcurrent ?? 4,
      logLevel: cfg.log?.level ?? 'info',
      auditLevel: cfg.session?.auditLevel ?? 'standard',
      indexOnStart: cfg.indexing?.onSessionStart !== false,
      maxIterations: cfg.tools?.maxIterations ?? 500,
      // Multi-diff summary threshold — mirrors the WebUI parity path
      // (pref-helpers.ts reads/writes `decrypted.autonomy.multiDiffSummaryThreshold`;
      // here we read from `decrypted.tools.multiDiffSummaryThreshold` to
      // match the Tools-section write gate added in saveSettings).
      multiDiffSummaryThreshold:
        ((cfg.tools as unknown as Record<string, unknown> | undefined)?.multiDiffSummaryThreshold as
          | number
          | undefined) ?? 5,
      nextStepsTool: cfg.tools?.nextsteps?.enabled === true,
      restrictFsToRoot: resolvedRestrict,
      autoProceedMaxIterations:
        ((cfg.autonomy as Record<string, unknown> | undefined)
          ?.autoProceedMaxIterations as number) ?? 50,
      debugStream: cfg.debugStream ?? false,
      shellBangWarningDontShowAgain: autonomy?.shellBangWarningDontShowAgain === true,
      statuslineMode:
        autonomy?.statuslineMode === 'no-color'
          ? 'no-color'
          : autonomy?.statuslineMode === 'detailed'
            ? 'detailed'
            : 'minimum',
      thinkingWord: normalizeTuiThinkingWord(autonomy?.thinkingWord),
      animationStyle: normalizeAnimationStyle(autonomy?.animationStyle),
      configScope: cfg.configScope ?? 'global',
      systemPromptVariant:
        cfg.systemPrompt?.variant === 'lite' || cfg.systemPrompt?.variant === 'pro'
          ? cfg.systemPrompt.variant
          : 'default',
      enhanceDelayMs:
        ((cfg.autonomy as Record<string, unknown> | undefined)?.enhanceDelayMs as number) ?? 60_000,
      enhanceEnabled:
        ((cfg.autonomy as Record<string, unknown> | undefined)?.enhance as boolean) ?? true,
      enhanceLanguage:
        (cfg.autonomy as Record<string, unknown> | undefined)?.enhanceLanguage === 'english'
          ? ('english' as const)
          : ('original' as const),
      midRunSendPicker:
        ((cfg.autonomy as Record<string, unknown> | undefined)?.midRunSendPicker as boolean) ??
        true,
      mouseMode: (autonomy?.mouseMode as boolean) ?? false,
      autonomyNextPrompt:
        ((cfg.autonomy as Record<string, unknown> | undefined)?.autonomyNextPrompt as
          | string
          | undefined) ?? 'auto {{suggestion}}',
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
      showModelReasoning: autonomy?.showModelReasoning ?? true,
      showAgentSwarmPanel: coerceAgentSwarmMode(autonomy?.showAgentSwarmPanel),
      showSidebar: autonomy?.showSidebar ?? true,
      // Migrate the legacy `autonomy.showAgentSwarmPanel: 'sidebar'` into
      // the new per-panel `panelPositions.fleet` map at the read boundary
      // so users with old configs (no `panelPositions` key on disk) get
      // their sidebar routing. Only migrate when the per-panel key is
      // UNDEFINED — an explicit `panelPositions.fleet: 'bottom'` must
      // NOT be reverted to `'sidebar'`.
      panelPositions: coercePanelPositionMap({
        ...(autonomy?.panelPositions as Partial<Record<string, 'bottom' | 'sidebar'>> | undefined),
        ...(coerceAgentSwarmMode(autonomy?.showAgentSwarmPanel) === 'sidebar' &&
        (autonomy?.panelPositions as Partial<Record<string, 'bottom' | 'sidebar'>> | undefined)
          ?.fleet === undefined
          ? { fleet: 'sidebar' as const }
          : {}),
      }),
      showSageMemoryInject: autonomy?.showSageMemoryInject ?? false,
      readSymbols: autonomy?.readAdvancedMode ?? false,
      sageMemoryInjectThreshold: (cfg.Sage as Record<string, unknown> | undefined)?.inject
        ? ((cfg.Sage as Record<string, unknown>).inject as Record<string, unknown>)?.relationFloor
        : undefined,
      // WrongProxy / WrongTrace: read from `tools.wrongProxy.{enabled,url}`
      // so the persistence shape mirrors the WebUI `LocalPrefs` shape
      // (single object with two fields, not two top-level keys). The
      // canonical type is `ToolsConfig.wrongProxy?: WrongProxyToolConfig`
      // — no index-signature widening cast needed.
      wrongProxyEnabled: cfg.tools?.wrongProxy?.enabled === true,
      wrongProxyUrl: cfg.tools?.wrongProxy?.url,
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
        s.fleetChatVerbosity !== undefined ||
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
        s.multiDiffSummaryThreshold !== undefined ||
        s.nextStepsTool !== undefined ||
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
        s.cacheTtl !== undefined ||
        s.breakerEnabled !== undefined ||
        s.breakerAutoKillResetMs !== undefined ||
        s.showModelReasoning !== undefined ||
        s.showAgentSwarmPanel !== undefined ||
        s.showSidebar !== undefined ||
        s.panelPositions !== undefined ||
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
          vault: noOpVault,
          resolveProfilePath: (name: string) => wpaths.profileConfig(name),
        };
        const targetPath = resolvePersistPath(persistDeps);
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
        if (s.fleetChatVerbosity !== undefined) {
          autonomy.fleetChatVerbosity = s.fleetChatVerbosity;
        }
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
        if (s.showModelReasoning !== undefined) autonomy.showModelReasoning = s.showModelReasoning;
        if (s.showAgentSwarmPanel !== undefined)
          autonomy.showAgentSwarmPanel = s.showAgentSwarmPanel;
        if (s.showSidebar !== undefined) autonomy.showSidebar = s.showSidebar;
        if (s.panelPositions !== undefined) autonomy.panelPositions = s.panelPositions;
        if (s.showSageMemoryInject !== undefined)
          autonomy.showSageMemoryInject = s.showSageMemoryInject;
        if (s.readSymbols !== undefined) autonomy.readAdvancedMode = s.readSymbols;
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
          if (fsAccess !== undefined) tools.restrictToProjectRoot = fsAccess.restrictToProjectRoot;
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
          if (s.breakerAutoKillResetMs !== undefined) cb.autoKillResetMs = s.breakerAutoKillResetMs;
          decrypted.circuitBreaker = cb;
        }
        // Re-resolve the target path after the mutation block: the mutator
        // may have changed configScope (or another field the canonical
        // resolveActualTarget checks), so the pre-mutation snapshot is stale.
        const actualTarget = resolveActualTarget(
          persistDeps,
          decrypted as Record<string, unknown>,
          targetPath,
        );
        // When the scope switch moved the target away from the file we
        // read at the top (targetPath → actualTarget), the decrypted
        // object is a mutation of the SOURCE config. Writing it verbatim
        // to the DESTINATION clobbers any keys that exist only in the
        // destination (e.g. a profile config with autonomy options the
        // project config doesn't have). Deep-merge the destination's
        // existing keys under our mutated values so nothing is lost.
        let mergedToWrite: Record<string, unknown> = decrypted;
        if (actualTarget !== targetPath) {
          try {
            const destRaw = await fs.readFile(actualTarget, 'utf8');
            const destParsed = JSON.parse(destRaw) as Record<string, unknown>;
            const destDecrypted = decryptConfigSecrets(destParsed, noOpVault) as Record<
              string,
              unknown
            >;
            mergedToWrite = deepMerge(destDecrypted, decrypted);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw new Error(
                `Failed to read destination config at ${actualTarget}: ${err instanceof Error ? err.message : String(err)}`,
                { cause: err },
              );
            }
            // Destination doesn't exist yet — write the mutated config as-is.
          }
        }
        // Only filter for project safety when writing to the in-project
        // config (.wrongstack/config.json). The active profile config stores
        // the full trusted user settings; the root bootstrap is never targeted.
        const isProjectTarget = actualTarget === wpaths.inProjectConfig;
        const toWrite = isProjectTarget ? filterSafeForProject(mergedToWrite) : mergedToWrite;
        const encrypted = encryptConfigSecrets(toWrite, noOpVault);
        await fs.mkdir(path.dirname(actualTarget), { recursive: true });
        await atomicWrite(actualTarget, JSON.stringify(encrypted, null, 2), { mode: 0o600 });

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
