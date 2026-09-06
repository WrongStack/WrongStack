import type { StatuslineDensities, StatuslineLines } from '@wrongstack/core/statusline';
// State, Action, and supporting types extracted from app-reducer.ts.
// This file has NO React or Ink dependencies — pure type definitions.
import type {
  AutonomyStage,
  ContentBlock,
  DesignKitEntry,
  FleetChatVerbosity,
  SkillEntry,
  TokenSavingTier,
} from '@wrongstack/core/types';
import type { SddBoardSnapshot } from '@wrongstack/sdd';
import type {
  GoalSummary,
  QueueItem,
  ResumeSessionEntry,
  SlashCommandMatch,
} from './app-state-core-types.js';
import type { FleetEntry } from './app-state-fleet.js';
import type { AuthPanelState } from './auth-panel-model.js';
import type { BrainLogEntry, BrainRiskLevel } from './brain-contracts.js';
import type { BrainPanelSettings } from './brain-panel-model.js';
import type { HistoryEntry } from './history-entry.js';
import type { TuiHistoryBudget } from './history-retention.js';
import type { ResumeLoadState } from './resume-load.js';
import type {
  AuditLevel,
  CacheTtl,
  CompactorStrategy,
  ContextMode,
  LogLevel,
  ReasoningEffort,
  SettingsMode,
  StatuslineMode,
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
  RefineFailureDecision,
  RefineFailureModel,
  ResourceMenuAction,
  ResourceMenuSnapshot,
  SendMode,
  ShadowState,
  StatuslineItem,
  ToolPickerItem,
  WorktreeRow,
} from './ui-contracts.js';

export type { Settings } from './app-settings-type.js';
export type {
  DraftEntry,
  GoalSummary,
  QueueItem,
  ResumeSessionEntry,
  SlashCommandMatch,
} from './app-state-core-types.js';
export type { FleetEntry } from './app-state-fleet.js';

export type State = {
  entries: HistoryEntry[];
  /**
   * True while the history archive is loading older entries from disk.
   * The UI may show a loading indicator for the scrollback area.
   */
  archiveLoading: boolean;
  /**
   * Monotonic generation counter retained for wholesale history replacement
   * compatibility and the legacy standalone History renderer.
   */
  historyGen: number;
  /**
   * Retention budget applied to `entries` on every history mutation.
   *
   * `undefined` = the live defaults. A session resume widens it (see
   * `TUI_RESUME_HISTORY_BUDGET`) and the widened budget must PERSIST: the very
   * next `addEntry` — the "Resumed session …" line itself — re-runs retention,
   * so a budget that only applied to the `replaceHistory` dispatch would trim
   * the transcript back one tick later and look like the resume never loaded.
   */
  historyBudget: TuiHistoryBudget | undefined;
  /**
   * Auto-proceed is armed only after the user has sent something.
   *
   * A resume restores the session's todo board, and the auto-proceed selector
   * treats any open todo as grounded work — so resuming a session with an
   * unfinished board silently started a turn on a countdown, without the user
   * ever pressing anything. A resume must land in a waiting state: show the
   * conversation, then stop.
   *
   * This holds only the ARMING. Autonomy itself is the user's setting and is
   * never touched here — the hold clears on the next manual submit, exactly
   * like the consecutive-turn cap does.
   */
  autoProceedHold: boolean;
  /**
   * Live `/resume` progress, or null when no resume is in flight.
   *
   * Set for the whole operation: the seconds spent reading the journal (during
   * which the transcript is empty and this is the only thing on screen) and the
   * streaming replay that follows. The block itself is rendered as a normal
   * history entry — this is the model behind it, kept in state so the spinner
   * ticker and the chunk pump have one authority to read.
   */
  resumeLoad: ResumeLoadState | null;
  buffer: string;
  cursor: number;
  streamingText: string;
  /**
   * Live tail of the currently streaming tool's stdout/progress text. Mirrors
   * the assistant `streamingText` pattern but is keyed by tool_use id so the
   * tail is cleared automatically when that tool finishes. Only one tool's
   * stream is shown at a time — multi-tool streaming is rare and stacking
   * tails fights for the same screen space.
   */
  toolStream: { toolUseId: string; name: string; text: string; startedAt: number } | null;
  status: 'idle' | 'running' | 'streaming' | 'aborting';
  interrupts: number;
  /**
   * Set when the user pressed Esc mid-iteration to interrupt the agent.
   * The NEXT submitted user message gets a STEERING prefix block prepended
   * so the model sees "I interrupted you on purpose — focus on this
   * instead of resuming the prior task". Cleared once that message
   * lands. Distinct from `interrupts` (which is the Ctrl+C exit ladder).
   */
  steeringPending: boolean;
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
  hint: string;
  /**
   * Transient "Copied" confirmation shown when a chat card's copy icon is
   * clicked and its content lands on the clipboard. Separate from `hint` so it
   * takes precedence over the running-tools indicator (copying tool output
   * mid-run is a prime use case) and never races another hint producer. Empty
   * string = no notice. Auto-cleared by a host timer.
   */
  copiedNotice: string;
  /**
   * Entry id of the card whose copy icon was just clicked, so ScrollableHistory
   * can flash that specific icon in the success color while the "Copied" notice
   * is active. `null` = no card highlighted. Set and cleared in lockstep with
   * `copiedNotice`.
   */
  copiedEntryId: number | null;
  brain: {
    state: 'idle' | 'deciding' | 'answered' | 'ask_human' | 'denied';
    source?: string | undefined;
    risk?: 'low' | 'medium' | 'high' | 'critical' | undefined;
    summary?: string | undefined;
    updatedAt?: number | undefined;
  };
  brainPrompt: {
    requestId: string;
    source: string;
    risk: 'low' | 'medium' | 'high' | 'critical';
    question: string;
    context?: string | undefined;
    options?:
      | Array<{
          id: string;
          label: string;
          risk?: string | undefined;
          consequence?: string | undefined;
          recommended?: boolean | undefined;
        }>
      | undefined;
  } | null;
  nextId: number;
  picker: { open: boolean; query: string; matches: string[]; selected: number };
  /** Slash command picker — open while typing a / command. */
  slashPicker: { open: boolean; query: string; matches: SlashCommandMatch[]; selected: number };
  /** Tool calls currently in-flight, by tool_use id. Surface in the status bar. */
  runningTools: Map<string, { name: string; startedAt: number }>;
  /** FIFO of user messages typed while the agent was running. Drained when idle. */
  queue: QueueItem[];
  nextQueueId: number;
  /** Previous input strings for up/down navigation. */
  inputHistory: string[];
  /** 0 = current buffer (not in history), 1 = most recent, n = nth most recent. */
  historyIndex: number;
  /**
   * Snapshot of the in-progress draft captured the first time the user
   * presses Up to enter history navigation. Restored when they navigate
   * back down to index 0, so peeking at history no longer discards a
   * half-typed prompt. Empty when not navigating. See historyUp/Down in
   * app-reducer.ts.
   */
  historyDraft: string;
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
    selected: number;
    hint?: string | undefined;
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
    open: boolean;
    entries: SkillEntry[];
    selected: number;
    hint?: string | undefined;
  };
  /** Shared two-pane browser for operational resources such as profiles and memory. */
  resourceMenu: {
    open: boolean;
    snapshot: ResourceMenuSnapshot | null;
    selected: number;
    filter: string;
    filtering: boolean;
    hint?: string | undefined;
    pendingAction?: ResourceMenuAction | undefined;
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
    resolve: (decision: 'yes' | 'no' | 'always' | 'deny') => void;
    /** True when the call was classified destructive. */
    destructive: boolean;
    boundaryReason?: string | undefined;
    /** Real write destinations from `Tool.writeTargets`, when declared (VULN-001 Phase 2). */
    writeTargets?: string[] | undefined;
  }[];
  /**
   * Active warning for the `!<command>` shell shortcut. It resolves before
   * dispatching to `/dev`, so the existing /dev runner stays the single shell
   * execution path.
   */
  shellCommandWarning: {
    command: string;
    resolve: (decision: 'yes' | 'no' | 'dont-show-again') => void;
  } | null;
  /**
   * Active prompt-refinement ("did you mean this?") panel. Set while the
   * EnhancePanel is shown after the refiner rewrites a user message; the
   * panel resolves to one of refined/original/edit and `submit()` continues.
   * Null when no refinement is pending.
   */
  enhance: {
    original: string;
    /** Refined in the user's original language. */
    refined: string;
    /** Refined in English. */
    english: string;
    resolve: (decision: 'refined' | 'english' | 'original' | 'edit' | 'retry' | 'cancel') => void;
  } | null;
  /** When true, free-text submits are run through the prompt refiner first. Toggled by `/enhance`. */
  enhanceEnabled: boolean;
  /** True while the refiner LLM call is in flight (before the panel appears). Drives a "refining…" indicator. */
  enhanceBusy: boolean;
  /** True only while the long-history topic advisor performs a remote ambiguity check. */
  topicCheckBusy: boolean;
  /**
   * Active pre-refine grace countdown. Set after the user submits a prompt
   * that passes the refiner gate but BEFORE the refiner LLM call starts.
   * The user sees a "refining in Ns…" panel and can send as-is (any key),
   * cancel back to the composer (Esc), or let the timer expire to proceed
   * into normal refinement. Resolves to proceed / skip / cancel. Null when
   * no countdown is active.
   */
  refineCountdown: {
    /** The user's just-submitted message (shown as preview). */
    original: string;
    /** Grace period in seconds before the refiner call starts. */
    seconds: number;
    resolve: (decision: 'proceed' | 'skip' | 'cancel') => void;
  } | null;
  /**
   * Monotonic id of the active countdown, bumped on every open. The panel is
   * keyed on it so a second countdown mounts a FRESH component instead of
   * inheriting the previous one's expired timer — which wedged the panel at
   * "refining in 0s…" with an orphaned resolve. Mirrors `historyGen`.
   */
  refineCountdownGen: number;
  /**
   * Active refinement-failure recovery panel. Set when a refine attempt (and
   * its automatic timeout retry) failed and the user must choose how to
   * recover: retry with more time, retry on the fallback/another model, send
   * the message as-is, or edit it. Resolves back into `submit()`. Null when no
   * failure is pending.
   */
  refineFailure: {
    original: string;
    error?: string | undefined;
    elapsedMs: number;
    fallbackRef?: string | undefined;
    models: RefineFailureModel[];
    resolve: (decision: RefineFailureDecision) => void;
  } | null;
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
  /** TUI-only follow-up gate shown after each completed `/bughunt` round. */
  bugHuntContinue: {
    completedRounds: number;
    totalRounds?: number | undefined;
    resolve: (decision: 'yes' | 'stop') => void;
  } | null;
  /** Visible, non-blocking progress card for the currently running bug-hunt round. */
  bugHuntRunning: {
    currentRound: number;
    totalRounds?: number | undefined;
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
    snapshot: NonNullable<State['steerSnapshot']>;
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
  /** Incremented on /clear so the context chip re-reads from agent.ctx tokens. */
  contextChipVersion: number;
  /** Live fleet state: per-subagent entries from FleetBus events. Keyed by subagentId. */
  fleet: Record<string, FleetEntry>;
  /**
   * Leader-loop activity, synthesized for the AgentsMonitor overlay so the
   * user can see leader iteration / tool counts alongside subagent rows.
   * Driven by EventBus `iteration.started`/`iteration.completed`/`tool.started`/`tool.executed`.
   * Always present; renders as AGENT#0 LEADER in the monitor regardless of
   * whether any subagents exist.
   */
  leader: {
    iterations: number;
    toolCalls: number;
    recentTools: Array<{
      name: string;
      ok?: boolean | undefined;
      durationMs?: number | undefined;
      at: number;
    }>;
    currentTool?: { name: string; startedAt: number } | undefined;
    startedAt: number;
    lastEventAt: number;
    /** True while inside an iteration (between iteration.started and iteration.completed). */
    iterating: boolean;
    /** Latest displayed context window fill fraction (from ctx.pct event, capped at 1). */
    ctxPct?: number | undefined;
    /** Estimated total tokens in context window. */
    ctxTokens?: number | undefined;
    /** Provider max context in tokens. */
    ctxMaxTokens?: number | undefined;
  };
  /** Fleet-wide accumulated cost. */
  fleetCost: number;
  /** Fleet-wide token totals from the usage aggregator, for the monitor gauge. */
  fleetTokens: { input: number; output: number };
  /** Live concurrency ceiling — updated by /fleet concurrency and concurrency.changed event. */
  fleetConcurrency: number;
  /**
   * How much subagent activity is streamed into the main history with an
   * `AGENT#N` prefix. `full` = every tool call and interim message;
   * `compact` = spawn / one summary per agent turn / completion;
   * `off` = nothing but failures. Toggled with `/agents chat` and
   * `/fleet stream on|off`. The live fleet surfaces (F2/F3) stay
   * fully live in every mode.
   */
  fleetChat: FleetChatVerbosity;
  /** When true, the full graphical fleet monitor overlay is shown (Ctrl+F). */
  monitorOpen: boolean;
  /** When true, the agents monitor overlay is shown (Ctrl+G). */
  agentsMonitorOpen: boolean;
  /** When true, the keys-&-commands help overlay is shown (`?` on an empty prompt). */
  helpOpen: boolean;
  /** When true, the todos monitor overlay is shown (F6). */
  todosMonitorOpen: boolean;
  /** When true, the queue panel is shown (F7). */
  queuePanelOpen: boolean;
  /** When true, the process list overlay is shown (F8). */
  processListOpen: boolean;
  /** When true, the cron jobs monitor is shown. */
  cronMonitorOpen: boolean;
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
  /** When true, keyboard focus is on the right sidebar (↑↓ scrolls sidebar content). */
  sidebarFocused: boolean;
  /** Vertical scroll offset for the sidebar content (in rows). */
  sidebarScrollOffset: number;
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
   * Active or completed collaborative debugging session state.
   * Null when no collab session has run. Tracks counts + the event timeline
   * so FleetMonitor can render a live "COLLAB SESSION" banner and per-event
   * entries (bug.found / refactor.plan / critic.evaluation) as they arrive.
   */
  collabSession: {
    /** Null until the first collab subagent spawns; set on first bug.found. */
    sessionId: string | null;
    bugCount: number;
    planCount: number;
    evalCount: number;
    /** Most recent overall verdict when the session completes. */
    overallVerdict: 'approve' | 'needs_revision' | 'reject' | null;
    /** Timeline of collab events for the FleetMonitor overlay. */
    timeline: Array<{ at: number; icon: string; color: string; text: string }>;
    startedAt: number | null;
  } | null;
  /** Session checkpoints recorded by SessionWriter.writeCheckpoint() events. */
  checkpoints: Array<{
    promptIndex: number;
    promptPreview: string;
    ts: string;
    fileCount: number;
  }>;
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
  /** Live iteration-stage of the active autonomy engine. */
  eternalStage: AutonomyStage | null;
  /** Loaded from .wrongstack/goal.json on mount for startup banner. */
  goalSummary: GoalSummary;
  /** Goal orchestrator state — rendered by PhaseMonitor. */
  goalRun: {
    /** Goal graph title. */
    title: string;
    /** Per-phase task summary, keyed by phaseId. */
    phases: Record<
      string,
      {
        name: string;
        status: string;
        completedTasks: number;
        totalTasks: number;
        startedAt?: number | undefined;
        /** Tasks currently executing in this phase, with the agent on each. */
        activeTasks?:
          | Array<{ taskId: string; title: string; agent?: string | undefined }>
          | undefined;
      }
    >;
    /** Active phase IDs (running phases). */
    runningPhaseIds: string[];
    /** Elapsed ms since graph start — drives the elapsed counter. */
    elapsedMs: number;
    /** True while the monitor overlay is open (Ctrl+P). */
    monitorOpen: boolean;
  } | null;
  /** Live multi-agent SDD board — latest snapshot + overlay open state (Ctrl+B). */
  sddBoard: {
    snapshot: SddBoardSnapshot;
    monitorOpen: boolean;
    /** Focused topological column index, or undefined for the all-columns view. */
    focusColumn?: number | undefined;
  } | null;
  /** Git-worktree isolation state — rendered by WorktreePanel/WorktreeMonitor. */
  worktrees: Record<string, WorktreeRow & { baseBranch?: string | undefined }>;
  /** Base branch worktrees fork from (for the monitor header). */
  worktreeBase?: string | undefined;
  /** True while the worktree monitor overlay is open (Ctrl+T). */
  worktreeMonitorOpen: boolean;
  /**
   * AutonomousCoordinator state — live from `subscribeCoordinatorEvents`.
   * Tracks project-level multi-session coordination: goals, tasks, consensus, and knowledge.
   */
  coordinator: {
    /** Active coordination goals. */
    goals: Array<{
      id: string;
      title: string;
      status: 'active' | 'paused' | 'completed' | 'failed';
      progress?: number | undefined;
      /** DEPRECATED — use tasks instead */
      steps?: string[] | undefined;
      tasks: Array<{
        id: string;
        title: string;
        status: 'pending' | 'running' | 'done' | 'failed';
        assignedTo?: string | undefined;
      }>;
      /** Agents/sessions participating in this goal's coordination. */
      participants: string[];
    }>;
    /** Live pending events for the coordinator panel timeline. */
    timeline: Array<{
      at: number;
      kind: 'goal' | 'task' | 'knowledge' | 'consensus' | 'deadlock';
      icon: string;
      text: string;
    }>;
    /** Count of shared knowledge facts across all sessions. */
    knowledgeCount: number;
    /** True while the coordinator monitor overlay is open. */
    monitorOpen: boolean;
    /** Coordinator health: true when connected and processing events. */
    healthy: boolean;
  };
  /**
   * In-app chat scroll state for the scrollable viewport.
   *   viewportRows    — last computed viewport height (rows); drives mouse
   *                     hit-testing and the ScrollableHistory clip box.
   *   historyScrolled — true while the managed viewport is scrolled away from
   *                     the newest output (reported by ScrollableHistory).
   * The scroll POSITION itself lives inside ScrollableHistory as an anchor
   * (entry id + clipped rows); the app drives it through the imperative
   * HistoryScrollController instead of reducer actions.
   */
  viewportRows: number;
  historyScrolled: boolean;
  /**
   * Live debug-stream telemetry rendered in StatusBar line 3 when
   * stream debugging is active. Updated every ~200 ms by the throttled
   * callback from stream-debug-state.ts. Null when disabled or idle.
   */
  debugStreamStats: {
    chunkCount: number;
    lastChunkSize: number;
    lastDeltaMs: number;
    totalBytes: number;
    lastChunkAt: string;
  } | null;
  /**
   * Auto-proceed countdown state, driven by `countdown.tick` events from
   * the host. null when no countdown is active. A tick of 0 clears it.
   */
  countdown: {
    /** Remaining seconds until auto-proceed fires. */
    remainingSeconds: number;
  } | null;
};
