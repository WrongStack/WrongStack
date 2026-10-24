// State, Action, and supporting types extracted from app-reducer.ts.
// This file has NO React or Ink dependencies — pure type definitions.
import type {
  ContentBlock,
  DesignKitEntry,
  FleetChatVerbosity,
  SkillEntry,
  TokenSavingTier,
} from '@wrongstack/contracts/types';
import type {
  StatuslineDensities,
  StatuslineLines,
  StatuslineOrder,
} from '@wrongstack/core/statusline';

import type { ResumeSessionEntry, SlashCommandMatch } from './app-state-core-types.js';
import type { AuthPanelState } from './auth-panel-model.js';
import type { BrainLogEntry, BrainRiskLevel } from './brain-contracts.js';
import type { BrainPanelSettings } from './brain-panel-model.js';
import type {
  AuditLevel,
  CacheTtl,
  CompactorStrategy,
  ContextMode,
  LogLevel,
  ReasoningEffort,
  SettingsMode,
  StatuslineMode,
  ToolResultViewMode,
} from './settings-contracts.js';
import type {
  AutonomyOption,
  ChipMeta,
  HelpEntry,
  LiveSessionEntry,
  McpPickerItem,
  ModeOption,
  PanelPositionMap,
  PluginPickerItem,
  ProjectPickerItem,
  PromptPickEntry,
  ProviderOption,
  SendMode,
  ShadowState,
  StatuslineItem,
  ToolPickerItem,
} from './ui-contracts.js';

export type PanelState = {
  /**
   * Context snapshot captured at Esc time, replayed into the STEERING
   * preamble so the model sees exactly what it was mid-doing when the
   * user pulled the cord. Cleared together with `steeringPending`.
   * Without this the model has to guess from chat scrollback which
   * tools were live — and it can't see subagent state at all.
   */
  steerSnapshot: {
    runningTools: string[];
    subagents: Array<{ label: string; status: string; tool?: string | undefined }>;
    subagentsTerminated: number;
    partialAssistantText: string;
  } | null;
  /**
   * Tool-result inspect overlay. Holds the clicked card's ids; the view
   * resolves the full (untruncated) payload from live history / stream.
   * Null when closed.
   */
  inspectOverlay: {
    entryId: number;
    entryIds?: readonly number[] | undefined;
    scroll: number;
  } | null;
  /**
   * Transcript search bar (Alt+F / `/chat-search`). `selectedEntryId` is the
   * current hit; `jumpSeq` increments whenever the view should scroll that
   * hit into view. Null when the bar is closed.
   */
  chatSearch: {
    query: string;
    selectedEntryId: number | null;
    jumpSeq: number;
  } | null;
  /**
   * Alt+↑ / Alt+↓ user-message navigation: the user entry last jumped to, and
   * a counter that bumps on every jump so the view scrolls it into view.
   */
  messageJump: { entryId: number | null; seq: number };
  picker: { open: boolean; query: string; matches: string[]; selected: number };
  /** Slash command picker — open while typing a / command. */
  slashPicker: { open: boolean; query: string; matches: SlashCommandMatch[]; selected: number };
  /** Two-step model picker (provider → model) — opened by `/model`. */
  modelPicker: {
    open: boolean;
    step: 'provider' | 'model';
    providerOptions: ProviderOption[];
    modelOptions: string[];
    /** Filtered list shown in step 2 (same as modelOptions when searchQuery is empty). */
    filteredOptions: string[];
    selected: number;
    pickedProviderId?: string | undefined;
    hint?: string | undefined;
    /** Live search filter in step 2. */
    searchQuery: string;
    /**
     * Reasoning effort chosen for the FOCUSED model with ←/→. `'default'`
     * (the sentinel every navigation resets to) means "leave the persisted
     * effort alone", which is what Enter did before the strip existed.
     */
    effort: string;
    /**
     * 'switch' — Enter switches the SESSION model (the /model command).
     * 'pick'   — generic reusable selection: Enter just RETURNS the choice
     *            to whoever called requestModelPick (Brain pool/voters/judge,
     *            future callers); other panels stay open underneath.
     */
    purpose: 'switch' | 'pick';
    /** Overlay title override for 'pick' invocations. */
    title?: string | undefined;
  };
  /** Single-step autonomy mode picker — opened by `/autonomy`. */
  autonomyPicker: {
    open: boolean;
    options: AutonomyOption[];
    selected: number;
    hint?: string | undefined;
  };
  /** Single-step theme picker — opened by `/theme`. Lists every preset and
   *  applies the chosen one instantly (in-place palette mutation + persist). */
  themePicker: {
    open: boolean;
    /** Index into the FILTERED option list (see `filter`). */
    selected: number;
    hint?: string | undefined;
    /** Type-to-filter query. Empty means "show every preset". */
    filter?: string | undefined;
    /**
     * Whether printable keys currently feed `filter`. Entered with `/` and
     * left when the query is emptied. While this is false, `u` means "undo"
     * and ordinary letters do nothing — without an explicit mode, every
     * letter typed into the filter (descriptions are full of them) would
     * shadow the undo key.
     */
    filtering?: boolean | undefined;
    /**
     * The preset that was active when the picker opened — the target of the
     * undo key. Undefined on the first ever open, where there is nothing to go
     * back to.
     */
    previous?: import('@wrongstack/contracts/types').ThemePresetId | undefined;
    /**
     * Live-preview mode: while true, moving the cursor applies each focused
     * preset immediately, and Esc restores `previous` before closing. Off by
     * default because it repaints the whole chat on every arrow key.
     */
    preview?: boolean | undefined;
  };
  /** Agent mode picker — opened by `/mode`. Selects teach/brief/code-reviewer/etc. */
  modePicker: {
    open: boolean;
    modes: ModeOption[];
    selected: number;
    hint?: string | undefined;
  };
  /** Skill picker — lists discoverable skills and details the focused row. */
  skillPicker: {
    mention?: import('@wrongstack/core/skill-mentions').SkillMention | undefined;
    open: boolean;
    entries: SkillEntry[];
    selected: number;
    hint?: string | undefined;
  };
  /** Design Studio kit picker — opened by `/design`. */
  designPicker: {
    open: boolean;
    kits: DesignKitEntry[];
    selected: number;
    /** Target stack applied on selection. */
    stack: string;
  };
  /** Prompt library picker — opened by a bare `/prompt`. Browse + category filter + insert. */
  promptPicker: {
    open: boolean;
    level?: 'simple' | 'detailed' | 'advanced';
    all: PromptPickEntry[];
    /** ['all', '🕘 recent'?, '★ favorites'?, ...distinct categories]. */
    categories: string[];
    /** Recently-used slugs (most-recent first) backing the "🕘 recent" view. */
    recentSlugs: string[];
    catIndex: number;
    selected: number;
  };
  /** Session resume picker — opened by `/resume`. Lists recent sessions with metadata. */
  resumePicker: {
    open: boolean;
    sessions: ResumeSessionEntry[];
    selected: number;
    /** True while the resume operation is in flight (fetching + replaying). */
    busy: boolean;
    hint?: string | undefined;
    /** Error message if the resume operation failed. */
    error?: string | undefined;
  };
  /** Settings editor — opened by `/settings` or Ctrl+S. */
  settingsPicker: {
    open: boolean;
    /** Focused row index. */
    field: number;
    /**
     * Mirror of the persisted `Settings.lastSettingsField` — kept in the
     * runtime slice so the reducer can read it during `settingsOpen`
     * without re-loading the full Settings shape, and so the auto-save
     * effect (see app.tsx) can write it back when the user navigates.
     */
    lastSettingsField: number;
    // Autonomy
    mode: SettingsMode;
    delayMs: number;
    // UX
    titleAnimation: boolean;
    yolo: boolean;
    fleetChat: FleetChatVerbosity;
    chime: boolean;
    confirmExit: boolean;
    nextPrediction: boolean;
    // Features
    featureMcp: boolean;
    featurePlugins: boolean;
    featureMemory: boolean;
    featureSkills: boolean;
    featureModelsRegistry: boolean;
    featureToolCoach: boolean;
    tokenSavingTier: TokenSavingTier;
    allowOutsideProjectRoot: boolean;
    // Context
    contextAutoCompact: boolean;
    contextStrategy: CompactorStrategy;
    contextMode: ContextMode;
    // Fleet
    maxConcurrent: number;
    // Logging
    logLevel: LogLevel;
    // Session
    auditLevel: AuditLevel;
    // Indexing
    indexOnStart: boolean;
    /** Multi-file diff summary footer cutoff. 0 = off; positive = min file count. */
    multiDiffSummaryThreshold: number;
    // Tools
    maxIterations: number;
    /** Maximum auto-proceed iterations (0 = unlimited). */
    autoProceedMaxIterations: number;
    /** Prompt refinement preview countdown (ms). */
    enhanceDelayMs: number;
    /** Pre-refine grace period (seconds). 0 = skip countdown entirely. */
    preRefineSeconds: number;
    /** Master toggle for the prompt refiner (mirrors Settings.enhanceEnabled). */
    enhanceEnabled: boolean;
    /** Refined-prompt language preference (mirrors Settings.enhanceLanguage). */
    enhanceLanguage: 'original' | 'english';
    /** Raw SSE stream debugging toggle. */
    debugStream: boolean;
    /** Statusline density mode. */
    statuslineMode: StatuslineMode;
    /** Reasoning mode: auto | on | off. */
    reasoningMode: 'auto' | 'on' | 'off';
    /** Reasoning effort level. */
    reasoningEffort: ReasoningEffort;
    /**
     * Effort levels the ACTIVE model documents (models.dev reasoningConfig),
     * injected by the host at /settings-open time. Absent = vocabulary
     * undocumented; the effort cycle then covers the full canonical set.
     */
    reasoningEffortLevels?: string[] | undefined;
    /** Preserve thinking across turns. */
    reasoningPreserve: boolean;
    /** Single word shown in the TUI rainbow working-state chip. */
    thinkingWord: string;
    /** True while free-text editing the thinking word (Enter on its row). */
    thinkingWordEditing: boolean;
    /** In-progress text buffer while `thinkingWordEditing`. */
    thinkingWordDraft: string;
    /**
     * Show the "Model Reasoning" collapsible blocks in chat history.
     * Separate from thinkingWord (status-bar chip) and reasoningMode
     * (API-level provisioning). Default: true.
     */
    showModelReasoning: boolean;
    /** Global default for all committed tool-result cards. */
    toolResultViewMode: ToolResultViewMode;
    selectionMode: 'block' | 'text';
    /** Agent swarm panel placement: 'bottom' (lower region), 'sidebar' (right sidebar), or 'off'. Default: 'bottom'. */
    showAgentSwarmPanel: import('./app-settings-type.js').AgentSwarmPanelMode;
    /** Right sidebar visibility (mirrors Settings.showSidebar). Default: true. */
    showSidebar: boolean;
    /**
     * Per-panel position map mirrored from the persisted Settings shape.
     * Each F-key panel can be set to 'bottom' (F-key behavior, the default)
     * or 'sidebar' (rendered in the right sidebar). When a panel is set to
     * 'sidebar' AND its F-key toggle is on, the bottom view hides and the
     * sidebar shows the panel twin instead. When the F-key is off, neither
     * surface shows the panel.
     */
    panelPositions: PanelPositionMap;
    /** Show SAGE Memory Inject blocks in tool results. Default: false (hidden). */
    showSageMemoryInject: boolean;
    /** Minimum relation strength for SAGE memory injection. Default: 0.85. */
    sageMemoryInjectThreshold: number;
    /** Register the leader's agent-callable `nextsteps` tool. Default: false. */
    nextStepsTool: boolean;
    /** Leader must end every finished turn with <nextsteps> or the completion marker (`autonomy.nextSteps: 'required'`). Default: true. */
    nextStepsRequired: boolean;
    /** Launch with the last model, system prompt and mode/YOLO/autonomy instead of asking (`launch.rememberStartupChoices`). Default: true. */
    rememberStartupChoices: boolean;
    /** System prompt the NEXT session starts with (`systemPrompt.variant` in the profile config); the running session keeps its own. */
    nextSystemPromptVariant: 'lite' | 'default' | 'pro' | 'scout';
    /** When true, read tool includes codebase-index symbols alongside file content. */
    readSymbols: boolean;
    /** Prompt cache TTL. */
    cacheTtl: CacheTtl;
    /** Where to persist settings: 'global' or 'project'. */
    configScope: 'global' | 'project';
    /**
     * Animation style for the working/thinking chip in the status bar. One
     * of the styles exported by `components/animation-style.tsx`, plus the
     * meta-mode `'cycle'` that rotates through the variant styles every
     * `CYCLE_INTERVAL_SECONDS`. Persisted on every ←/→ change in `/settings`.
     */
    animationStyle: 'rainbow' | 'wave' | 'pulse' | 'dots' | 'breathe' | 'static' | 'cycle';
    // ── Integrations ──
    /**
     * WrongProxy / WrongTrace: master switch. When true AND the daemon at
     * `wrongProxyUrl` is reachable, every provider's base URL is rewritten
     * through `${wrongProxyUrl}/proxy/<host><path>`. openai-codex is
     * excluded by spec. Mirrors `Settings.wrongProxyEnabled` and the
     * `tools.wrongProxy.enabled` config key. Picker field 59.
     */
    wrongProxyEnabled: boolean;
    /**
     * WrongProxy / WrongTrace URL. Default `http://localhost:3444`. The
     * CLI's periodic probe targets `<wrongProxyUrl>/api/health`; a 2xx
     * response flips the runtime's `active` flag. Picker field 60.
     */
    wrongProxyUrl: string;
    /** True while free-text editing the WrongProxy URL (Enter on its row). */
    wrongProxyUrlEditing: boolean;
    /** In-progress text buffer while `wrongProxyUrlEditing`. */
    wrongProxyUrlDraft: string;
    // Safety
    /** Whether the process circuit breaker gates bash/exec. */
    breakerEnabled: boolean;
    /** Auto kill/reset delay (ms) when the breaker trips. 0 = manual recovery. */
    breakerAutoKillResetMs: number;
    /**
     * Live filter for the row-search modal (entered via `/`). Empty
     * string means filter is inactive. Non-empty means the user is
     * typing a search query and only matching rows are visible.
     * Cleared on picker close and on Esc-out-of-filter.
     */
    filter: string;
    hint?: string | undefined;
  };
  /** Statusline editor — opened by `/statusline`. */
  statuslinePicker: {
    open: boolean;
    /** Focused field index. */
    field: number;
    /** Current hidden-items list (user-toggled off chips). */
    hiddenItems: StatuslineItem[];
    /**
     * Chips that are temporarily visible due to data/events, with expiration
     * metadata. When a chip expires it is removed from this list. User-toggled
     * chips stay visible via their data being truthy — they are NOT here.
     */
    visibleChips: ChipMeta[];
    /** Per-chip line assignment being edited (mirrors statusline.json v3). */
    lines: StatuslineLines;
    /** Per-chip density pin being edited. */
    densities: StatuslineDensities;
    /** Custom left-to-right chip order being edited. */
    order: StatuslineOrder;
    /** Text filter over chip names/descriptions. */
    filter: string;
    /** True while `/` is capturing filter keystrokes. */
    filtering: boolean;
    /**
     * True once the editor holds the live layout (seeded on open, or made
     * true by any layout edit). The app only mirrors the editor's layout
     * back into the live statusline while this is set, so a caller that
     * opens the picker WITHOUT seeding it can never publish an empty layout
     * over the user's saved one.
     */
    layoutSeeded: boolean;
    hint?: string | undefined;
  };
  /** Plugin toggle editor — opened by `/plugin menu` or `/settings plugins`. */
  pluginPicker: {
    open: boolean;
    items: PluginPickerItem[];
    selected: number;
    busy: boolean;
    hint?: string | undefined;
  };
  /** MCP server picker — opened by `/mcp`. */
  mcpPicker: {
    open: boolean;
    items: McpPickerItem[];
    selected: number;
    busy: boolean;
    hint?: string | undefined;
    editor?: import('./ui-contracts.js').McpPickerEditor | undefined;
  };
  /** Tool picker — opened by `/tools`. */
  toolsPicker: {
    open: boolean;
    items: ToolPickerItem[];
    selected: number;
    busy: boolean;
    hint?: string | undefined;
    filter?: string | undefined;
  };
  /** Brain panel — opened by `/brain`. */
  brainPanel: {
    open: boolean;
    riskLevel: BrainRiskLevel;
    log: BrainLogEntry[];
    selected: number;
    hint?: string | undefined;
    /** Settings-editor state (only meaningful when a BrainPanelHost is wired). */
    view: 'settings' | 'log';
    settings?: BrainPanelSettings | undefined;
    /** Settings-view row cursor. */
    row: number;
    busy: boolean;
  };
  /** Help panel — opened by `/help`. */
  helpPanel: {
    open: boolean;
    entries: HelpEntry[];
    selected: number;
    filter: string;
    hint?: string | undefined;
    detailScroll?: number | undefined;
  };
  /** Shadow Agent panel — opened by `/shadow`. */
  shadowPanel: {
    open: boolean;
    shadow: ShadowState;
    hint?: string | undefined;
  };
  /** Interactive API-key / OAuth manager — opened by `/auth`. */
  authPanel: AuthPanelState;
  /** Project switcher panel — opened by F1 or `/project`. */
  projectPicker: {
    open: boolean;
    /** Original unfiltered items. Never mutated after open. */
    allItems: ProjectPickerItem[];
    /** Currently displayed items (filtered from allItems). Navigation targets this list. */
    items: ProjectPickerItem[];
    selected: number;
    filter: string;
    hint?: string | undefined;
  };
  /** F-key panel picker — opened by `/f`. Keyboard-navigable list of F1–F12 panels. */
  fKeyPicker: {
    open: boolean;
    selected: number;
  };
  /** Pending tool confirmations — queue to handle multiple tools requesting confirmation. */
  confirmQueue: {
    toolUseId: string;
    toolName: string;
    input: unknown;
    suggestedPattern: string;
    resolve: (
      decision:
        | 'yes'
        | 'no'
        | 'always'
        | 'always-exact'
        | 'always-command'
        | 'always-tool'
        | 'deny',
    ) => void;
    /** True when the call was classified destructive. */
    destructive: boolean;
    boundaryReason?: string | undefined;
    /** Real write destinations from `Tool.writeTargets`, when declared (VULN-001 Phase 2). */
    writeTargets?: string[] | undefined;
  }[];
  /**
   * Active bare-"continue" confirmation panel. Set when the user typed a lone
   * "continue"/"devam"/"go on" and the runtime resolved it to a concrete next
   * step. Makes the resolution — and its drift risk — visible before it is
   * sent: a grounded resolution (todo / suggestion) auto-proceeds after a
   * short countdown; an `open` resolution (no queued task, model will pick the
   * step itself) requires an explicit keypress. Resolves to
   * proceed / edit / cancel and `submit()` continues. Null when none pending.
   */
  continueConfirm: {
    /** One-line summary shown in the panel header (e.g. "▶ Continue → todo: …"). */
    label: string;
    /** The full instruction that will be injected in place of "continue". */
    instruction: string;
    /** Where the resolution came from — drives copy + risk styling. */
    source: 'todo' | 'suggestion' | 'open';
    /** True for todo/suggestion (low drift); false for the `open` guess. */
    grounded: boolean;
    resolve: (decision: 'proceed' | 'edit' | 'cancel') => void;
  } | null;
  /**
   * Pending destructive `/clear` confirmation. Unlike ordinary yes/no
   * prompts this requires the user to type the full uppercase word `YES`.
   */
  clearConfirm: {
    leaderActive: boolean;
    subagentCount: number;
    value: string;
    resolve: (decision: boolean) => void;
  } | null;
  /**
   * Pending `/exit` confirmation. Mirrors the `/clear` invariant: while a
   * leader run or any subagent is in flight, `/exit` must not terminate the
   * TUI silently. The panel asks for an Enter/Esc acknowledgement so the
   * user can decide to abort the in-flight work first. When nothing is
   * running, `/exit` resolves true without ever opening this panel.
   */
  exitConfirm: {
    leaderActive: boolean;
    subagentCount: number;
    backgroundCount?: number | undefined;
    resolve: (decision: boolean) => void;
  } | null;
  /** Generic slash-command confirmation rendered inside the TUI. */
  slashConfirm: {
    question: string;
    defaultYes: boolean;
    resolve: (decision: boolean | null) => void;
  } | null;
  /**
   * Pending ESC-interrupt confirmation. Null when none is pending.
   * When `confirmExit` is enabled and Esc is pressed mid-iteration, the
   * snapshot is captured and `escConfirm` opens instead of immediately
   * aborting. The prompt shows "Abort work and redirect?"
   * (or similar) and waits for y/n/Esc.
   */
  escConfirm: {
    snapshot: NonNullable<PanelState['steerSnapshot']>;
  } | null;
  /**
   * Fallback model overlay — shown when `provider.fallback_pending` fires.
   * The overlay displays a countdown and the candidate model list, letting
   * the user manually pick a model or wait for auto-switch. Null when no
   * fallback gate is pending.
   */
  fallbackOverlay: {
    requestId: string;
    from: { providerId: string; model: string };
    status: number;
    candidates: Array<{ providerId: string; model: string }>;
    autoSwitchSeconds: number;
    selected: number;
  } | null;
  /**
   * Mid-run send-mode picker. Set when the user submits a plain message while
   * the agent is busy and `midRunSendPicker` is enabled — the picker asks how
   * to deliver the text (queue / by-the-way / steer). The `resolve` callback
   * is awaited inside `submit()` (same Promise pattern as `enhance`); on
   * `'cancel'` (Esc) the caller restores the draft to the composer instead
   * of sending — nothing is queued. Null when no picker is pending.
   */
  sendModePicker: {
    selected: number;
    text: string;
    displayText: string;
    blocks: ContentBlock[];
    pasteContent?: string | undefined;
    resolve: (decision: SendMode | 'cancel') => void;
  } | null;
  /** When true, the queue panel is shown (F7). */
  queuePanelOpen: boolean;
  /** When true, the audit (side effects) overlay is shown (/audit). */
  auditPanelOpen: boolean;
  /** When true, the plan panel is shown (F5). */
  planPanelOpen: boolean;
  /** When true, the project kanban panel is shown. */
  kanbanPanelOpen: boolean;
  /** When true, the goal panel is shown (F9). */
  goalPanelOpen: boolean;
  goalKanbanPanelOpen: boolean;
  /** When true, the interactive context monitor is shown (`/context`). */
  contextPanelOpen: boolean;
  /** When true, the interactive service connections health panel is shown (`/connections`). */
  connectionsPanelOpen: boolean;
  /** When true, the sessions panel is shown (F10). */
  sessionsPanelOpen: boolean;
  /** Live session data for the sessions panel (F10). */
  sessionsPanel: {
    sessions: LiveSessionEntry[];
    busy: boolean;
    /** Selected index for arrow-key navigation. -1 when nothing selected. */
    selected: number;
  };
  /**
   * Pending session resume confirmation. When set, the F10 panel shows a
   * "Press Enter to confirm resume, Esc to cancel" prompt. Set by the first
   * Enter on a same-project session; the second Enter triggers the actual
   * onResumeSession call.
   */
  sessionResumeConfirm: {
    sessionId: string;
    sessionName: string;
  } | null;
  /**
   * A fork from the checkpoint timeline, waiting for the resume machinery
   * (use-app-picker-keys) to branch the session there and switch to it.
   */
  forkRequest?: { promptIndex: number } | null | undefined;
  /** Checkpoint timeline overlay — null when closed. */
  rewindOverlay: {
    checkpoints: Array<{
      promptIndex: number;
      promptPreview: string;
      ts: string;
      fileCount: number;
    }>;
    selected: number;
  } | null;
};
