import type React from 'react';
import { useEffect } from 'react';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, Text } from '../ink.js';
import { PANEL_IDS, SETTINGS_PICKER_MAX_HEIGHT } from '../ui-contracts.js';
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
import {
  deriveSettingsSectionFieldStarts,
  type SettingsPickerRowData,
  SettingsPickerRowList,
} from './settings-picker-row-list.js';

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
  /** Effort levels the active model documents (absent = undocumented). */
  reasoningEffortLevels?: string[] | undefined;
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
  /** Right sidebar master toggle. */
  showSidebar?: boolean | undefined;
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
  // ── Integrations ──
  /**
   * WrongProxy / WrongTrace: master switch. When true AND the daemon at
   * `wrongProxyUrl` is reachable, every provider's base URL is rewritten
   * through `${wrongProxyUrl}/proxy/<host><path>`. openai-codex is
   * excluded by spec. Toggled on the row at field index 59.
   */
  wrongProxyEnabled: boolean;
  /**
   * WrongProxy / WrongTrace URL. Default `http://localhost:3444`. Text
   * field (Enter on the row opens an inline edit). Picker field 60.
   */
  wrongProxyUrl: string;
  /** True while free-text editing the WrongProxy URL (Enter on its row). */
  wrongProxyUrlEditing: boolean;
  /** In-progress text buffer while `wrongProxyUrlEditing`. */
  wrongProxyUrlDraft: string;
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
  /**
   * Real rendered height of the Input box below the picker (rows).
   * When omitted, defaults to 3 (single-line prompt + 2 border/padding
   * rows). Passed from AppView so the picker's height budget accounts
   * for multi-line input buffers instead of assuming a constant.
   */
  inputHeight?: number | undefined;
  hint?: string | undefined;
  /** @internal Test seam for asserting the production row/header layout contract. */
  onLayoutComputed?:
    | ((layout: {
        rows: readonly SettingsPickerRowData[];
        fieldRowIndex: readonly number[];
      }) => void)
    | undefined;
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
  wrongProxyUrlEditing,
  wrongProxyUrlDraft,
  reasoningMode,
  reasoningEffort,
  reasoningEffortLevels,
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
  showSidebar,
  showSageMemoryInject,
  sageMemoryInjectThreshold,
  nextStepsTool,
  readSymbols,
  panelPositions,
  // WrongProxy / WrongTrace: pick these from the same slice as
  // `nextStepsTool` and `readSymbols`. The runtime probe (see
  // `runtime-controller-deps.ts:applyLiveSettings`) reads them off the
  // same object, so adding both at the destructuring level keeps the
  // mid-session effect coherent.
  wrongProxyEnabled,
  wrongProxyUrl,
  inputHeight,
  hint,
  onLayoutComputed,
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
      detail: reasoningEffortLevels?.length
        ? `documented for this model: ${reasoningEffortLevels.join(' · ')}`
        : 'none–max (model-dependent)',
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
    // ── Integrations (fields 59–60) ─────────────────────────────────────
    // WrongProxy / WrongTrace. Appended at the end so the existing
    // field indices 0–58 (including the panel-position block 46–58)
    // remain stable — see the SettingsPicker "Appended to preserve"
    // comment above. The runtime probe (see
    // `runtime-controller-deps.ts:applyLiveSettings`) reads both keys
    // from the same SettingsPicker slice, so adding them at the
    // destructuring level keeps the mid-session effect coherent.
    {
      label: 'WrongProxy / WrongTrace',
      value: boolVal(wrongProxyEnabled),
      detail:
        'Route base URLs through the local proxy (default http://localhost:3444). openai-codex is excluded.',
    },
    {
      label: 'WrongProxy URL',
      value: wrongProxyUrlEditing ? `${wrongProxyUrlDraft ?? ''}▏` : wrongProxyUrl,
      detail: wrongProxyUrlEditing
        ? 'type a URL · Enter ✓ · Esc ✗ (http://host:port or https://host:port)'
        : 'Where the local proxy daemon listens. Probed at <url>/api/health every 30s.',
    },
    {
      label: 'Right sidebar',
      value: boolVal(showSidebar ?? true),
      detail: 'Show or hide the right sidebar in the TUI (chat history takes full width when off)',
    },
  ];

  // Build field → row index mapping. `rows` includes section headers
  // that are NOT counted by `field`; without this mapping the highlight
  // lands on the wrong row (or never shows on the first field).
  const fieldRowIndex: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i]?.section) fieldRowIndex.push(i);
  }
  useEffect(() => {
    onLayoutComputed?.({ rows, fieldRowIndex });
  });

  const { filterActive, rankedResults, filteredFieldIndices, highlightSegments } =
    buildSettingsFilterState(filter, SETTINGS_PICKER_JUMP_CHORDS);

  // ── Terminal geometry & row budget ──────────────────────────────────
  //
  // The picker must NEVER emit more terminal rows than are available.
  // An overflowing frame desyncs Ink's erase math: previously-written
  // rows survive into the next frame, duplicate/stale content stacks
  // up, and the top of the screen turns into a garbled block — the bug
  // seen when scrolling fields on short terminals like Ubuntu's default
  // 24-row GNOME Terminal.
  //
  // Two safety layers work together:
  //   1. VISIBLE_FIELDS  — limits how many field rows are rendered so
  //                        the content normally fits without clipping.
  //   2. height + overflowY — a hard cap on the picker Box that clips
  //                        any residual overflow (estimation error,
  //                        unexpected section headers, etc.) instead of
  //                        scrolling the terminal.
  //
  // Both numbers derive from the same chain so they cannot disagree:
  //
  //   pickerHeight     = clamp(termRows − inputHeight − bottomChromeRows, borderRows, maxHeight)
  //   innerHeight      = pickerHeight − BORDER_ROWS
  //   visible window  = largest centered field range whose exact wrapped
  //                     field rows + intersecting headers fit innerHeight.
  //
  // Field rows render a 40-char prefix ("  " + label.padEnd(26) +
  // value.padEnd(12)) followed by detail text. Deriving each field's wrapped
  // line cost avoids both narrow-terminal overflow and wide blank gaps.
  const { columns: termCols, rows: termRows } = useTerminalSize({
    fallbackColumns: 80,
    fallbackRows: 24,
  });

  // Content width inside the bordered, padded picker Box.
  // borderStyle="round" consumes 2 cols (left + right borders);
  // paddingX={1} consumes 2 more (1 col each side).
  const contentWidth = Math.max(10, termCols - 4);
  // Match renderPickerRow's exact printable width: selection prefix + padded
  // label + padded value + detail. A fixed "2 lines at 80 cols" estimate
  // over-counted short rows and still left a large blank area in the box.
  const fieldLineCount = (fieldIdx: number): number => {
    const rowIdx = fieldRowIndex[fieldIdx];
    const row = rowIdx === undefined ? undefined : rows[rowIdx];
    const printableWidth =
      2 +
      Math.max(26, (row?.label ?? '').length) +
      Math.max(12, String(row?.value ?? '').length) +
      (row?.detail ?? '').length;
    return Math.max(1, Math.ceil(printableWidth / contentWidth));
  };

  // Fixed rows consumed regardless of field count.
  // Real input height (passed from AppView) accounts for multi-line
  // buffers; default to 3 (single-line prompt + 2 chrome rows) when not
  // supplied (tests, standalone rendering).
  const INPUT_ROWS = inputHeight ?? 3;
  // StatusBar renders below the picker inside the bottom region.
  // Minimum/no-color reserves one status rail; detailed reserves its
  // four-rail worst case.
  const bottomChromeRows = statuslineMode === 'detailed' ? 4 : 1;
  const BORDER_ROWS = 2; // picker top + bottom borders
  // Title + legend/filter summary + footer. The keyboard legend wraps to a
  // second line below 64 content columns, so reserve that real extra row.
  const BASE_CHROME_ROWS = contentWidth < 64 ? 4 : 3;

  // Picker Box height (borders included). Leaves INPUT_ROWS for the
  // Input box and bottomChromeRows for StatusBar below.
  // Keep only the two border rows as the minimum so tiny terminals do not
  // reserve content space they cannot display. The max prevents large
  // terminals from expanding the menu to the full available screen height.
  const pickerHeight = Math.min(
    SETTINGS_PICKER_MAX_HEIGHT,
    Math.max(BORDER_ROWS, termRows - INPUT_ROWS - bottomChromeRows),
  );
  const innerHeight = pickerHeight - BORDER_ROWS;

  // VISIBLE_FIELDS — non-filter mode. Each field row renders linesPerField
  // lines; section headers (── Section ──) render one line and only for
  // sections that intersect the window. The old worst-case budget
  // (linesPerField + 1 per field — one header per field) under-filled the
  // box whenever fields clustered under headers, leaving a large blank
  // area above the picker's bottom border. Instead, find the largest
  // window (centered on the focused field, clamped as before) whose exact
  // rendered row count fits the available inner height.
  const totalFields = fieldRowIndex.length; // = SETTINGS_FIELD_COUNT

  // Shared with SettingsPickerRowList so the exact-fit budget and renderer
  // cannot silently disagree about which fields begin sections.
  const sectionFieldStarts = deriveSettingsSectionFieldStarts(fieldRowIndex);

  // Exact rows consumed by window [start, end): the measured line cost of
  // each field, plus one line per section header that intersects the window.
  // This includes the header of a section that began above the window and
  // still contains `start`.
  const countWindowLines = (start: number, end: number): number => {
    let lines = 0;
    for (let fieldIdx = start; fieldIdx < end; fieldIdx++) {
      lines += fieldLineCount(fieldIdx);
    }
    for (const secStart of sectionFieldStarts) {
      if (secStart >= start && secStart < end) lines++;
    }
    if (start > 0 && !sectionFieldStarts.includes(start)) lines++;
    return lines;
  };

  // Window start for a given width N, centered on `field` (clamped as
  // before). The window grows by exactly one field per step, so the exact
  // row count is monotone in N and binary search finds the maximum fit.
  const windowStartFor = (n: number): number =>
    totalFields <= n ? 0 : Math.max(0, Math.min(field - Math.floor(n / 2), totalFields - n));

  const windowFits = (fieldCount: number): boolean => {
    const start = windowStartFor(fieldCount);
    const end = Math.min(start + fieldCount, totalFields);
    const scrollIndicatorRows = (start > 0 ? 1 : 0) + (end < totalFields ? 1 : 0);
    const chromeRows = BASE_CHROME_ROWS + scrollIndicatorRows + (hint ? 1 : 0);
    return countWindowLines(start, end) + chromeRows <= innerHeight;
  };

  let lo = 3;
  let hi = totalFields;
  let VISIBLE_FIELDS = Math.min(3, totalFields);
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (windowFits(mid)) {
      VISIBLE_FIELDS = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const windowStart = windowStartFor(VISIBLE_FIELDS);
  const windowEnd = Math.min(windowStart + VISIBLE_FIELDS, totalFields);
  const hasAbove = windowStart > 0;
  const hasBelow = windowEnd < totalFields;

  // Filter-mode window has no section headers. Use the most expensive
  // matching field as the per-result budget so broad queries cannot overflow,
  // while short rows are not all charged a stale worst-case width estimate.
  const maxFilteredFieldLines = Math.max(
    1,
    ...rankedResults.map((result) => fieldLineCount(result.chord.field)),
  );
  const FILTER_CHROME_ROWS = BASE_CHROME_ROWS + 2; // worst-case above + below indicators
  const FILTER_VISIBLE_FIELDS = Math.max(
    3,
    Math.floor((innerHeight - FILTER_CHROME_ROWS - (hint ? 1 : 0)) / maxFilteredFieldLines),
  );
  const filterMatchCount = rankedResults.length;
  const filterSelectedIdx = filterActive
    ? rankedResults.findIndex((r) => r.chord.field === field)
    : -1;
  const filterWindowStart =
    !filterActive || filterMatchCount <= FILTER_VISIBLE_FIELDS || filterSelectedIdx < 0
      ? 0
      : Math.max(
          0,
          Math.min(
            filterSelectedIdx - Math.floor(FILTER_VISIBLE_FIELDS / 2),
            filterMatchCount - FILTER_VISIBLE_FIELDS,
          ),
        );
  const filterWindowEnd = Math.min(filterWindowStart + FILTER_VISIBLE_FIELDS, filterMatchCount);
  const filterHasAbove = filterActive && filterWindowStart > 0;
  const filterHasBelow = filterActive && filterWindowEnd < filterMatchCount;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      height={pickerHeight}
      overflowY="hidden"
    >
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
      {filterActive && filterHasAbove ? (
        <Text
          dimColor
        >{`  ↑ ${filterWindowStart} match${filterWindowStart === 1 ? '' : 'es'} above`}</Text>
      ) : null}
      {!filterActive && hasAbove ? (
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
        filterWindowStart={filterWindowStart}
        filterWindowEnd={filterWindowEnd}
      />
      {filterActive && filterHasBelow ? (
        <Text
          dimColor
        >{`  ↓ ${filterMatchCount - filterWindowEnd} match${filterMatchCount - filterWindowEnd === 1 ? '' : 'es'} below`}</Text>
      ) : null}
      {!filterActive && hasBelow ? (
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
