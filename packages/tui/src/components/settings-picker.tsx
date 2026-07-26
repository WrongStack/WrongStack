import { Box, Text, useStdout } from '../ink.js';
import type React from 'react';
import {
  SETTINGS_PICKER_JUMP_CHORDS,
} from './settings-picker-jumps.js';
import { buildSettingsFilterState } from './settings-picker-filter.js';
import { SettingsPickerRowList, type SettingsPickerRowData } from './settings-picker-row-list.js';
import {
  CONTEXT_MODE_DESCS,
  FLEET_CHAT_MODE_DESCS,
  MODE_DESC,
  STATUSLINE_MODE_DESCS,
  TOKEN_SAVING_TIER_DESCS,
  formatAnimationStyle,
  formatBreakerTimeout,
  formatEnhanceDelay,
  formatMaxIterations,
  formatMultiDiffSummaryThreshold,
  formatSettingsDelay,
} from './settings-picker-model.js';
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
export * from './settings-picker-model.js';

export {
  SETTINGS_PICKER_JUMP_CHORDS,
  settingsPickerJumpByName,
  settingsPickerJumpField,
  settingsPickerJumpNames,
  type SettingsPickerJumpChord,
  type SettingsPickerJumpMod,
} from './settings-picker-jumps.js';

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
   * Show the persistent FleetPanel below the status bar, including AGENT SWARM
   * activity and its todo mission queue. Full-screen agent/queue/goal overlays
   * remain independently available through their panel shortcuts. Default: true.
   */
  showAgentSwarmPanel: boolean;
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
      detail:
        'Min files before aggregate header (0 = off, default 5, 10 for big diffs)',
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
      label: 'Show agent swarm panel',
      value: boolVal(showAgentSwarmPanel),
      detail: 'Show persistent agent activity and mission queue',
    },
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
        <Text color="yellow" bold>{`Filter: ${filter} (${filteredFieldIndices.length} match${filteredFieldIndices.length === 1 ? '' : 'es'})`}</Text>
      ) : (
        <Text dimColor>↑/↓ field · ←/→ change + autosave · `/` to search · F5 to close</Text>
      )}
      {hasAbove && !filterActive ? (
        <Text dimColor>{`  ↑ ${windowStart} field${windowStart === 1 ? '' : 's'} above`}</Text>
      ) : null}
      {filterActive && filteredFieldIndices.length === 0 ? (
        <Text dimColor italic>No matching settings rows.</Text>
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
        <Text dimColor>{`  ↓ ${totalFields - windowEnd} field${totalFields - windowEnd === 1 ? '' : 's'} below`}</Text>
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
