import type React from 'react';
import { Box, Text, useStdout } from '../ink.js';
import { PANEL_IDS } from '../ui-contracts.js';
import { buildSettingsFilterState } from './settings-picker-filter.js';
import { SETTINGS_PICKER_JUMP_CHORDS } from './settings-picker-jumps.js';
import type {
  AnimationStyleChoice,
  AuditLevel,
  CacheTtl,
  CompactorStrategy,
  ConfigScope,
  ContextMode,
  EnhanceLanguage,
  FleetChatVerbosityTui,
  LogLevel,
  ReasoningEffort,
  ReasoningMode,
  SettingsMode,
  StatuslineMode,
  TokenSavingTierTui,
} from './settings-picker-model.js';
import {
  CONTEXT_MODE_DESCS,
  FLEET_CHAT_MODE_DESCS,
  formatAnimationStyle,
  formatBreakerTimeout,
  formatEnhanceDelay,
  formatMaxIterations,
  formatMultiDiffSummaryThreshold,
  formatPreRefineSeconds,
  formatSageThreshold,
  formatSettingsDelay,
  MODE_DESC,
  SETTINGS_FIELD_LABELS,
  STATUSLINE_MODE_DESCS,
  TOKEN_SAVING_TIER_DESCS,
} from './settings-picker-model.js';
import { type SettingsPickerRowData, SettingsPickerRowList } from './settings-picker-row-list.js';

export {
  SETTINGS_PICKER_JUMP_CHORDS,
  type SettingsPickerJumpChord,
  type SettingsPickerJumpMod,
  settingsPickerJumpByName,
  settingsPickerJumpField,
  settingsPickerJumpNames,
} from './settings-picker-jumps.js';
export * from './settings-picker-model.js';

export interface SettingsPickerProps {
  /** Focused row index. */
  field: number;
  // ── Autonomy ──
  mode: SettingsMode;
  delayMs: number;
  // ── UX ──
  titleAnimation: boolean;
  yolo: boolean;
  fleetChat: FleetChatVerbosityTui;
  chime: boolean;
  confirmExit: boolean;
  nextPrediction: boolean;
  // ── Features ──
  featureMcp: boolean;
  featurePlugins: boolean;
  featureMemory: boolean;
  featureSkills: boolean;
  featureModelsRegistry: boolean;
  /** Token-saving tier: off | minimal | light | medium | aggressive. */
  tokenSavingTier: TokenSavingTierTui;
  /** Allow tools to read/write paths outside the project root directory. Default: true. */
  allowOutsideProjectRoot: boolean;
  // ── Tools ──
  maxIterations: number;
  /** Maximum auto-proceed iterations before stopping (0 = unlimited). */
  autoProceedMaxIterations: number;
  /** Prompt refinement preview countdown (ms). Cycled via ENHANCE_DELAY_PRESETS. */
  enhanceDelayMs: number;
  /** Enable/disable prompt refinement. */
  enhanceEnabled: boolean;
  /** Default language for refinement: original (keep user's language) or english. */
  enhanceLanguage: EnhanceLanguage;
  /** Pre-refine grace countdown (seconds). 0 = skip. */
  preRefineSeconds: number;
  /** Run incremental index at session start. */
  indexOnStart: boolean;
  /** User-tunable cutoff for the multi-file diff summary footer. 0 = off. */
  multiDiffSummaryThreshold: number;
  // ── Reasoning ──
  /** Thinking word displayed in status bar while agent is working. */
  thinkingWord: string;
  /** True while the user is free-text editing the thinking word (Enter on the row). */
  thinkingWordEditing?: boolean | undefined;
  /** In-progress text buffer shown while `thinkingWordEditing`. */
  thinkingWordDraft?: string | undefined;
  /** Reasoning mode: auto (provider default) | on | off. */
  reasoningMode: ReasoningMode;
  /** Reasoning effort level. */
  reasoningEffort: ReasoningEffort;
  /** Preserve thinking across turns. */
  reasoningPreserve: boolean;
  /** Prompt cache TTL. */
  cacheTtl: CacheTtl;
  // ── Context ──
  contextAutoCompact: boolean;
  contextStrategy: CompactorStrategy;
  contextMode: ContextMode;
  // ── Fleet ──
  maxConcurrent: number;
  // ── Logging ──
  logLevel: LogLevel;
  auditLevel: AuditLevel;
  // ── Safety ──
  /** Whether the process circuit breaker gates bash/exec. */
  breakerEnabled: boolean;
  /** Auto kill/reset delay (ms) when the breaker trips. 0 = manual recovery. */
  breakerAutoKillResetMs: number;
  // ── Display ──
  /** Show the "Model Reasoning" blocks in chat history. Default: true. */
  showModelReasoning: boolean;
  /**
   * Show the Mission Queue section (todo items) in the right sidebar. The
   * lower-region FleetPanel is always visible when there is fleet activity;
   * this toggle controls only the sidebar mission queue. Default: 'bottom'.
   */
  showAgentSwarmPanel: import('../app-settings-type.js').AgentSwarmPanelMode;
  /** Show SAGE Memory Inject blocks in tool results. Default: false. */
  showSageMemoryInject: boolean;
  /** Minimum relation strength for SAGE memory injection. Default: 0.85. */
  sageMemoryInjectThreshold: number;
  /** Register the leader's agent-callable `nextsteps` tool. Default: false. */
  nextStepsTool: boolean;
  // ── Tools ──
  /** When true, read tool includes codebase-index symbols alongside file content. */
  readSymbols: boolean;
  /**
   * Per-panel placement map (F-key bottom vs right sidebar). One picker row
   * per PanelId in PANEL_IDS order; each row cycles 'bottom' ↔ 'sidebar'.
   */
  panelPositions: import('../ui-contracts.js').PanelPositionMap;
  // ── Debug ──
  /** Raw SSE stream debugging toggle — hex-dump every byte received from providers. */
  debugStream: boolean;
  /** Statusline density: minimum single-line or detailed multi-line. */
  statuslineMode: StatuslineMode;
  /** Where settings are persisted. */
  configScope: ConfigScope;
  /** Active profile config path used when {@link configScope} is global. */
  profileConfigPath?: string | undefined;
  /**
   * Animation style for the status bar's working/thinking chip.
   * One of the AnimationStyle values, or 'cycle' to rotate through variants.
   */
  animationStyle: AnimationStyleChoice;
  /**
   * Live filter for the row-search modal (entered via `/`). When non-empty,
   * the picker renders only matching rows. The leading `/` is part of the
   * value (matches fzf/vim convention) — the matcher strips it before
   * matching against row labels.
   */
  filter?: string | undefined;
  hint?: string | undefined;
}

export function SettingsPicker({
  field,
  filter,
  mode,
  delayMs,
  titleAnimation,
  yolo,
  fleetChat,
  chime,
  confirmExit,
  nextPrediction,
  featureMcp,
  featurePlugins,
  featureMemory,
  featureSkills,
  featureModelsRegistry,
  tokenSavingTier,
  allowOutsideProjectRoot,
  maxIterations,
  autoProceedMaxIterations,
  enhanceDelayMs,
  enhanceEnabled,
  enhanceLanguage,
  preRefineSeconds,
  indexOnStart,
  multiDiffSummaryThreshold,
  thinkingWord,
  thinkingWordEditing,
  thinkingWordDraft,
  reasoningMode,
  reasoningEffort,
  reasoningPreserve,
  cacheTtl,
  contextAutoCompact,
  contextStrategy,
  contextMode,
  maxConcurrent,
  logLevel,
  auditLevel,
  debugStream,
  statuslineMode,
  configScope,
  profileConfigPath = '~/.wrongstack/profiles/default/config.json',
  animationStyle,
  breakerEnabled,
  breakerAutoKillResetMs,
  showModelReasoning,
  showAgentSwarmPanel,
  showSageMemoryInject,
  sageMemoryInjectThreshold,
  nextStepsTool,
  readSymbols,
  panelPositions,
  hint,
}: SettingsPickerProps): React.ReactElement {
  const boolVal = (v: boolean) => (v ? 'on' : 'off');

  const rows: SettingsPickerRowData[] = [
    // ── Autonomy ──
    { section: 'Autonomy' },
    { label: 'Default autonomy mode', value: mode, detail: MODE_DESC[mode] },
    {
      label: 'Auto-proceed delay',
      value: formatSettingsDelay(delayMs),
      detail: 'Wait before auto-continuing in auto mode',
    },
    // ── UX ──
    { section: 'UX' },
    {
      label: 'Terminal title animation',
      value: boolVal(titleAnimation),
      detail: 'Animated window/tab title with status',
    },
    {
      label: 'YOLO mode',
      value: boolVal(yolo),
      detail: 'Skip all confirmation prompts',
    },
    {
      label: 'Fleet chat',
      value: fleetChat,
      detail: FLEET_CHAT_MODE_DESCS[fleetChat],
    },
    {
      label: 'Completion chime',
      value: boolVal(chime),
      detail: 'Play a sound when agent finishes',
    },
    {
      label: 'Confirm before exit',
      value: boolVal(confirmExit),
      detail: 'Confirmation on Esc interrupt & Ctrl+C exit',
    },
    {
      label: 'Next-step prediction',
      value: boolVal(nextPrediction),
      detail: 'Show LLM-predicted next steps (/next)',
    },
    // ── Features ──
    { section: 'Features' },
    {
      label: 'MCP servers',
      value: boolVal(featureMcp),
      detail: 'Load MCP servers from config',
    },
    {
      label: 'Plugins',
      value: boolVal(featurePlugins),
      detail: 'Load npm plugins from config',
    },
    {
      label: 'Memory',
      value: boolVal(featureMemory),
      detail: 'Enable remember/forget tools',
    },
    {
      label: 'Skills',
      value: boolVal(featureSkills),
      detail: 'Discover and load skills from disk',
    },
    {
      label: 'Models registry',
      value: boolVal(featureModelsRegistry),
      detail: 'Fetch models.dev catalog at startup',
    },
    {
      label: 'Token-saving mode',
      value: tokenSavingTier,
      detail: TOKEN_SAVING_TIER_DESCS[tokenSavingTier],
    },
    {
      label: 'Allow outside project',
      value: boolVal(allowOutsideProjectRoot),
      detail: 'Allow tools to access paths outside project root',
    },
    // ── Tools ──
    { section: 'Tools' },
    {
      label: 'Max iterations',
      value: formatMaxIterations(maxIterations),
      detail: '100–1000 or unlimited (0)',
    },
    {
      label: 'Auto-proceed max iterations',
      value: formatMaxIterations(autoProceedMaxIterations),
      detail: 'Stop auto-proceed after N iterations (0 = unlimited, default 50)',
    },
    {
      label: 'Refine preview countdown',
      value: formatEnhanceDelay(enhanceDelayMs),
      detail: 'Timeout for prompt refinement preview (15s–120s)',
    },
    {
      label: 'Refine',
      value: boolVal(enhanceEnabled),
      detail: 'Enable prompt refinement before sending',
    },
    {
      label: 'Refine language',
      value: enhanceLanguage,
      detail: 'original (keep language) | english (translate)',
    },
    {
      label: 'Index on session start',
      value: boolVal(indexOnStart),
      detail: 'Run incremental index at session start',
    },
    {
      label: 'Multi-diff summary',
      value: formatMultiDiffSummaryThreshold(multiDiffSummaryThreshold),
      detail: 'Min files before aggregate header (0 = off, default 5, 10 for big diffs)',
    },
    // ── Reasoning ──
    { section: 'Reasoning' },
    {
      label: 'Thinking word',
      value: thinkingWordEditing ? `${thinkingWordDraft ?? ''}▏` : thinkingWord,
      detail: thinkingWordEditing
        ? 'type a word · Enter ✓ · Esc ✗ (≤16, letters/digits/_/-)'
        : 'Status-bar working word · thinking/random = surprise me · ←/→ presets · Enter to type',
    },
    {
      label: 'Reasoning mode',
      value: reasoningMode,
      detail: 'auto (provider default) | on | off',
    },
    {
      label: 'Reasoning effort',
      value: reasoningEffort,
      detail: 'none–max (model-dependent)',
    },
    {
      label: 'Preserve thinking',
      value: boolVal(reasoningPreserve),
      detail: 'Keep reasoning across turns',
    },
    {
      label: 'Cache TTL',
      value: cacheTtl,
      detail: 'Prompt cache TTL (5m | 1h)',
    },
    // ── Context ──
    { section: 'Context' },
    {
      label: 'Auto-compact',
      value: boolVal(contextAutoCompact),
      detail: 'Auto-compact context when thresholds crossed',
    },
    {
      label: 'Compactor strategy',
      value: contextStrategy,
      detail: 'hybrid (fast) | intelligent (LLM) | selective',
    },
    {
      label: 'Context mode',
      value: contextMode,
      detail: CONTEXT_MODE_DESCS[contextMode],
    },
    // ── Fleet ──
    { section: 'Fleet' },
    {
      label: 'Max concurrent',
      value: maxConcurrent === 0 ? 'default' : String(maxConcurrent),
      detail: 'Max subagents (0 = default)',
    },
    // ── Logging ──
    { section: 'Logging' },
    {
      label: 'Log level',
      value: logLevel,
      detail: 'Console log verbosity',
    },
    {
      label: 'Audit level',
      value: auditLevel,
      detail: 'minimal | standard | full (large)',
    },
    // ── Debug ──
    { section: 'Debug' },
    {
      label: 'Stream debug logging',
      value: boolVal(debugStream),
      detail: 'Hex-dump raw SSE bytes to stderr',
    },
    {
      label: 'Statusline',
      value: statuslineMode,
      detail: STATUSLINE_MODE_DESCS[statuslineMode],
    },
    {
      label: 'Config scope',
      value: configScope,
      detail: 'global (~/.wrongstack/) or project (.wrongstack/)',
    },
    {
      label: 'Animation',
      value: animationStyle,
      detail: formatAnimationStyle(animationStyle),
    },
    // ── Safety ──
    { section: 'Safety' },
    {
      label: 'Circuit breaker',
      value: boolVal(breakerEnabled),
      detail: 'Gate bash/exec after repeated failures',
    },
    {
      label: 'Breaker timeout',
      value: formatBreakerTimeout(breakerAutoKillResetMs),
      detail: 'Auto kill/reset delay when tripped (manual = /kill reset)',
    },
    // ── Display ──
    { section: 'Display' },
    {
      label: 'Show model reasoning',
      value: boolVal(showModelReasoning),
      detail: 'Show LLM reasoning blocks in chat history',
    },
    {
      label: 'Agent swarm panel',
      value: showAgentSwarmPanel,
      detail: 'bottom = lower region, sidebar = right sidebar, off = hidden',
    },
    {
      label: 'Pre-refine countdown',
      value: formatPreRefineSeconds(preRefineSeconds),
      detail: 'Grace period before refiner starts (0 = skip)',
    },
    // Appended to preserve the established field indices used by settings
    // reducers, slash commands, and persisted lastSettingsField values.
    {
      label: 'Read symbols',
      value: boolVal(readSymbols),
      detail: 'Include codebase-index symbols in read tool results',
    },
    {
      label: 'Show SAGE Memory Inject',
      value: boolVal(showSageMemoryInject),
      detail: 'Show SAGE memory injection blocks in tool results',
    },
    {
      label: 'SAGE Memory Inject threshold',
      value: formatSageThreshold(sageMemoryInjectThreshold),
      detail: 'Min relation strength for injection (0.72–0.95)',
    },
    {
      label: 'Nextsteps tool',
      value: boolVal(nextStepsTool),
      detail: 'Let the agent record <nextsteps> via a tool call (next session)',
    },
    // ── Panels (fields 46–58) ─────────────────────────────────────────────
    // One row per PanelId in PANEL_IDS order. SETTINGS_FIELD_LABELS indexes
    // 46..58 must stay in lock-step with PANEL_IDS — the resolveSettingsFieldValue
    // switch and the reducer's settingsValueChange arrow-key path both
    // index `PANEL_IDS[field - PANEL_POSITION_FIELD_START]` for these rows. ←/→ cycles the value
    // between 'bottom' (F-key) and 'sidebar' (right sidebar) — the
    // renderer (sidebar.tsx + overlay-key-router) reads `panelPositions`
    // at render time to decide where each panel surfaces.
    { section: 'Panels' },
    ...PANEL_IDS.map((panelId, i) => ({
      label: SETTINGS_FIELD_LABELS[45 + i] ?? panelId,
      value: panelPositions[panelId],
      detail:
        panelPositions[panelId] === 'sidebar'
          ? 'Render in right sidebar'
          : 'Render in lower F-key region',
    })),
  ];

  // Build field → row index mapping. `rows` includes section headers
  // that are NOT counted by `field`; without this mapping the highlight
  // lands on the wrong row (or never shows on the first field).
  const fieldRowIndex: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i]?.section) fieldRowIndex.push(i);
  }

  const { filterActive, rankedResults, filteredFieldIndices, highlightSegments } =
    buildSettingsFilterState(filter, SETTINGS_PICKER_JUMP_CHORDS);

  // Compute visible window. On small terminals, the picker can overflow;
  // we show at most VISIBLE_FIELDS around the current selection so every
  // field stays reachable. The window grows with the terminal: 8 fields is
  // the floor (the historical fixed size), taller terminals show more.
  // Reserved rows: picker chrome (border/title/legend/scroll indicators/
  // footer, ~9) + the input box, statusline and key-hint bar below (~8)
  // + up to 9 section-header lines that render inside the window.
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;
  const VISIBLE_FIELDS = Math.max(8, termRows - 26);
  const totalFields = fieldRowIndex.length; // = SETTINGS_FIELD_COUNT
  const windowStart =
    totalFields <= VISIBLE_FIELDS
      ? 0
      : Math.max(0, Math.min(field - Math.floor(VISIBLE_FIELDS / 2), totalFields - VISIBLE_FIELDS));
  const windowEnd = Math.min(windowStart + VISIBLE_FIELDS, totalFields);
  const hasAbove = windowStart > 0;
  const hasBelow = windowEnd < totalFields;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="cyan" bold>
        ━━ Settings ━━
      </Text>
      {filterActive ? (
        <Text
          color="yellow"
          bold
        >{`Filter: ${filter} (${filteredFieldIndices.length} match${filteredFieldIndices.length === 1 ? '' : 'es'})`}</Text>
      ) : (
        <Text dimColor>↑/↓ field · ←/→ change + autosave · `/` to search · F5 to close</Text>
      )}
      {hasAbove && !filterActive ? (
        <Text dimColor>{`  ↑ ${windowStart} field${windowStart === 1 ? '' : 's'} above`}</Text>
      ) : null}
      {filterActive && filteredFieldIndices.length === 0 ? (
        <Text dimColor italic>
          No matching settings rows.
        </Text>
      ) : null}
      <SettingsPickerRowList
        rows={rows}
        field={field}
        fieldRowIndex={fieldRowIndex}
        filterActive={filterActive}
        rankedResults={rankedResults}
        highlightSegments={highlightSegments}
        windowStart={windowStart}
        windowEnd={windowEnd}
      />
      {hasBelow && !filterActive ? (
        <Text
          dimColor
        >{`  ↓ ${totalFields - windowEnd} field${totalFields - windowEnd === 1 ? '' : 's'} below`}</Text>
      ) : null}
      <Text dimColor>
        {configScope === 'project'
          ? 'Persisted to <project>/.wrongstack/config.json'
          : `Persisted to ${profileConfigPath}`}
      </Text>
      {hint ? <Text color="yellow">{hint}</Text> : null}
    </Box>
  );
}
