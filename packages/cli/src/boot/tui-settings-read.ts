import type { ConfigStore } from '@wrongstack/contracts/types';
import {
  normalizeTokenSavingTier,
  resolveFleetChatVerbosity,
  resolveNextStepsMode,
} from '@wrongstack/contracts/types';
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
export function readTuiSettings(configStore: ConfigStore): Record<string, unknown> {
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
      : 'medium';
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
    delayMs: (autonomy?.autoProceedDelayMs as number) ?? 15_000,
    titleAnimation: autonomy?.terminalTitleAnimation !== false,
    yolo: cfg.yolo ?? (autonomy?.yolo as boolean | undefined) ?? true,
    fleetChatVerbosity: resolveFleetChatVerbosity(cfg.autonomy),
    chime: (autonomy?.chime as boolean) ?? true,
    confirmExit: autonomy?.confirmExit !== false,
    nextPrediction: cfg.nextPrediction ?? true,
    featureMcp: cfg.features?.mcp !== false,
    featurePlugins: cfg.features?.plugins !== false,
    featureMemory: cfg.features?.memory !== false,
    featureSkills: cfg.features?.skills !== false,
    featureModelsRegistry: cfg.features?.modelsRegistry !== false,
    featureToolCoach: cfg.features?.toolCoach !== false,
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
    maxConcurrent: cfg.maxConcurrent ?? 10,
    logLevel: cfg.log?.level ?? 'warn',
    auditLevel: cfg.session?.auditLevel ?? 'full',
    indexOnStart: cfg.indexing?.onSessionStart !== false,
    maxIterations: cfg.tools?.maxIterations ?? 0,
    // Multi-diff summary threshold — mirrors the WebUI parity path
    // (pref-helpers.ts reads/writes `decrypted.autonomy.multiDiffSummaryThreshold`;
    // here we read from `decrypted.tools.multiDiffSummaryThreshold` to
    // match the Tools-section write gate added in saveSettings).
    multiDiffSummaryThreshold:
      ((cfg.tools as unknown as Record<string, unknown> | undefined)?.multiDiffSummaryThreshold as
        | number
        | undefined) ?? 5,
    nextStepsTool: cfg.tools?.nextsteps?.enabled === true,
    nextStepsRequired: resolveNextStepsMode(autonomy?.nextSteps) === 'required',
    rememberStartupChoices: cfg.launch?.rememberStartupChoices !== false,
    restrictFsToRoot: resolvedRestrict,
    autoProceedMaxIterations:
      ((cfg.autonomy as Record<string, unknown> | undefined)?.autoProceedMaxIterations as number) ??
      0,
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
      cfg.systemPrompt?.variant === 'lite' ||
      cfg.systemPrompt?.variant === 'pro' ||
      cfg.systemPrompt?.variant === 'scout'
        ? cfg.systemPrompt.variant
        : cfg.systemPrompt?.variant === 'default'
          ? 'default'
          : 'pro',
    enhanceDelayMs:
      ((cfg.autonomy as Record<string, unknown> | undefined)?.enhanceDelayMs as number) ?? 15_000,
    enhanceEnabled:
      ((cfg.autonomy as Record<string, unknown> | undefined)?.enhance as boolean) ?? true,
    preRefineSeconds:
      ((cfg.autonomy as Record<string, unknown> | undefined)?.preRefineSeconds as number) ?? 3,
    enhanceLanguage:
      (cfg.autonomy as Record<string, unknown> | undefined)?.enhanceLanguage === 'english'
        ? ('english' as const)
        : (cfg.autonomy as Record<string, unknown> | undefined)?.enhanceLanguage === 'original'
          ? ('original' as const)
          : ('english' as const),
    enhanceRetryTimeoutMs: (cfg.autonomy as Record<string, unknown> | undefined)
      ?.enhanceRetryTimeoutMs as number | undefined,
    midRunSendPicker:
      ((cfg.autonomy as Record<string, unknown> | undefined)?.midRunSendPicker as boolean) ?? true,
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
    showModelReasoning: autonomy?.showModelReasoning ?? false,
    selectionMode: autonomy?.selectionMode === 'text' ? 'text' : 'block',
    toolResultViewMode:
      autonomy?.toolResultViewMode === 'minimal' || autonomy?.toolResultViewMode === 'full'
        ? autonomy.toolResultViewMode
        : 'normal',
    showAgentSwarmPanel: coerceAgentSwarmMode(autonomy?.showAgentSwarmPanel),
    showSidebar: autonomy?.showSidebar ?? true,
    lastSettingsField: autonomy?.lastSettingsField ?? 0,
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
