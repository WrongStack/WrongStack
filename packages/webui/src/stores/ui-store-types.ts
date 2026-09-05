import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ImageAttachment } from '../components/ChatInput/image-attachments.js';
import { MAX_ATTACHED_IMAGES } from '../components/ChatInput/image-attachments.js';
import type { QueuedItem, QueueMode } from './chat-store';
import type { MailboxMessage } from './mailbox-store';

// ============================================
// UI Store
// ============================================

// Activity types shown in the ActivityBar (secondary panel content).
// One icon = one full panel. 'context' and 'sessions' were folded into
// 'chat' and 'history'; 'projects' was removed from WebUI because project
// switching is owned by the launcher/desktop shell.
export type Activity = 'chat' | 'agents' | 'files' | 'changes' | 'mailbox' | 'skills' | 'design';

export const ACTIVITIES: readonly Activity[] = [
  'chat',
  'agents',
  'files',
  'changes',
  'mailbox',
  'skills',
  'design',
];

/** Map any persisted (possibly legacy) activity value onto the current set.
 * 'worktrees' and 'officemap' were retired from the ActivityBar: worktree
 * lanes now live as a tab inside the Changes panel, the fleet map as a tab
 * inside the Agent Roster view. */
export function coerceActivity(value: unknown): Activity {
  if (ACTIVITIES.includes(value as Activity)) return value as Activity;
  if (value === 'context') return 'chat';
  if (value === 'history' || value === 'sessions') return 'chat';
  if (value === 'projects') return 'chat';
  if (value === 'worktrees') return 'changes';
  if (value === 'officemap') return 'chat';
  return 'chat';
}

/**
 * All valid `currentView` values — the SINGLE source of truth.
 *
 * `lib/view-navigation.ts` used to carry its own `AppView` union, assembled by
 * hand from three subsets. The two lists drifted: `deadcode` was in this array
 * and had a `ViewRouter` branch, a backend, and labels in all seven locales,
 * but was missing from `AppView`, so no navigation helper could reach it and
 * the whole panel was unreachable. `AppView` is now derived from this array and
 * an exhaustiveness assertion pins every entry to exactly one navigation
 * bucket, which makes that class of drift a compile error.
 * See docs/audit/webui-full-review-2026-09-03.md B-02.
 */
export const VIEWS = [
  'chat',
  'settings',
  'memory',
  'roster',
  'context',
  'goal',
  'kanban',
  'sddhub',
  'files',
  'changes',
  'sessions',
  'session-inspect',
  'setup',
  'skill',
  'mailbox',
  'debug',
  'design-gallery',
  'refresh-debug',
  'analytics',
  'codemap',
  'techstack',
  'chronicle',
  'intake',
  'deadcode',
  'prompts',
  'chimera',
] as const;
export type View = (typeof VIEWS)[number];

/** Coerce an arbitrary value onto the current view union. Used by migrate
 *  when reading from localStorage so a stale value (e.g. 'context', a view
 *  removed in v3) lands on 'chat' rather than crashing the router. */
export function coerceView(value: unknown): View {
  return (VIEWS as readonly string[]).includes(value as string) ? (value as View) : 'chat';
}

export const DOCK_SECTIONS = ['goal', 'goal-state', 'fleet', 'work', 'worktrees', 'collab'] as const;

export function coerceDockSection(value: unknown): DockSection | null {
  return value === null || value === undefined || !DOCK_SECTIONS.includes(value as DockSection)
    ? null
    : (value as DockSection);
}

export const SETTINGS_TABS = [
  'general',
  'provider',
  'connection',
  'agent',
  'execution',
  'fallbacks',
  'routing',
  'fleet',
  'integrations',
  'chimera',
  'context',
  'logs',
  'security',
  'display',
] as const;

export function coerceSettingsTab(value: unknown): string {
  return (SETTINGS_TABS as readonly string[]).includes(value as string)
    ? (value as string)
    : 'general';
}

/** Single source of truth for the secondary panel width bounds. */
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 560;
export const SIDEBAR_DEFAULT_WIDTH = 304;

/** Sections of the WorkspaceDock strip above the chat transcript. */
export type DockSection = 'goal' | 'goal-state' | 'fleet' | 'work' | 'worktrees' | 'collab';
export type WorkDashboardTab = 'todos' | 'tasks' | 'plan';
/**
 * Tabs of the global right inspector drawer.
 *
 * `council` is the live Brain council panel log — the most expensive Brain
 * tier (one provider call per seat) and, until it got a tab, the only one with
 * no observable surface at all.
 */
export type InspectorTab = 'fleet' | 'agents' | 'sideEffects' | 'council';

export type InspectorTarget =
  | { kind: 'fleet'; tab?: InspectorTab | undefined }
  | { kind: 'agent'; agentId: string }
  | { kind: 'sideEffects' }
  | { kind: 'council' }
  | { kind: 'task'; taskId: string; boardId?: string | undefined; title?: string | undefined };

export interface SessionChromeState {
  sidebarOpen: boolean;
  activeActivity: Activity;
  currentView: View;
  inspectSessionId: string | null;
  searchOpen: boolean;
  searchQuery: string;
  searchActiveMessageId: string | null;
  scrollTarget: UIState['scrollTarget'];
  modelSwitcherOpen: boolean;
  promptLibraryOpen: boolean;
  promptInsertRequest: string | null;
  refinePanel: UIState['refinePanel'];
  draftInput: string;
  draftImages: ImageAttachment[];
  processMonitorOpen: boolean;
  queuePanelOpen: boolean;
  cronJobsOpen: boolean;
  sideContextBreakdownOpen: boolean;
  terminalOpen: boolean;
  dockSection: DockSection | null;
  workDashboardTab: WorkDashboardTab;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  inspectorTarget: InspectorTarget | null;
  inspectorFocusedAgentId: string | null;
  agentRosterActiveTab: 'live' | 'officemap' | 'catalog' | 'learning' | 'memory' | 'customize';
  changesPanelTab: 'changes' | 'worktrees';
  dockCustomizeOpen: boolean;
  skillsState: UIState['skillsState'];
  selectedMailMessage: MailboxMessage | null;
  scrollPositions: Record<string, number>;
  chatSwitcherOpen: boolean;
  chatCheckpointOpen: boolean;
  chatMemoryPanelOpen: boolean;
  chatContextBreakdownOpen: boolean;
  chatContextEditorOpen: boolean;
  chatToolStatsOpen: boolean;
  chatInputCollapsed: boolean;
}

export interface UIState {
  sidebarOpen: boolean;
  /** Which activity icon is selected in the ActivityBar — controls secondary panel content. */
  activeActivity: Activity;
  settingsOpen: boolean;
  currentView: View;
  showConfirmDialog: boolean;
  confirmInfo: {
    id: string;
    toolName: string;
    input: unknown;
    suggestedPattern: string;
    decisionSource?: string | undefined;
    riskTier?: 'safe' | 'standard' | 'destructive' | undefined;
    boundaryReason?: string | undefined;
  } | null;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  searchOpen: boolean;
  searchQuery: string;
  searchActiveMessageId: string | null;
  /** Imperative "scroll the virtualized chat list to this message" request.
   *  The chat list is virtualized, so an off-screen message has no DOM node to
   *  scrollIntoView — SearchOverlay sets this and ChatView consumes it by
   *  mapping the id to a VList row index and calling scrollToIndex. The nonce
   *  lets the same id be re-requested (e.g. Enter on the same hit). */
  scrollTarget: { id: string; nonce: number } | null;
  promptHistory: string[];
  sidebarWidth: number;
  pinnedIds: string[];
  compactMode: boolean;
  modelSwitcherOpen: boolean;
  favoriteSessionIds: string[];
  sessionNicknames: Record<string, string>;
  fileExplorerWidth: number;
  /** When true, free-text prompts are run through the prompt refiner before sending. */
  refineEnabled: boolean;
  /** WorkspaceDock section shown in the right inspector. Null = no dock detail open. */
  dockSection: DockSection | null;
  /** Active tab in the Work dock section. Mirrors TUI F5/F6 panel jumps. */
  workDashboardTab: WorkDashboardTab;
  /** Which session the global dock/work projection currently describes. */
  chromeSessionId: string | null;
  /** Per-session screen projection, parked when switching tabs. */
  chromeBySession: Record<string, SessionChromeState>;
  /** Dock chips the user has explicitly hidden via the customization menu.
   *  Empty = all chips visible (subject to each chip's own data condition).
   *  Mirrors the TUI's F12 status-line chip picker. */
  hiddenChips: DockSection[];
  /** Controlled open state for the dock chip customization menu. */
  dockCustomizeOpen: boolean;
  /** @deprecated Compatibility field; Fleet now opens in the global inspector. */
  fleetMonitorOpen: boolean;
  /** @deprecated Compatibility field; Agents now opens in the global inspector. */
  agentsMonitorOpen: boolean;
  /** Global right inspector drawer open (non-modal overlay on desktop). */
  inspectorOpen: boolean;
  /** Active tab inside the global right inspector drawer. */
  inspectorTab: InspectorTab;
  /** Target routing descriptor for the universal inspector drawer. */
  inspectorTarget: InspectorTarget | null;
  /** Agent ID to focus when opening the inspector on the agents tab. Cleared on read. */
  inspectorFocusedAgentId: string | null;
  /** Subagent whose full transcript currently replaces the main chat pane
   *  (agent tabs above the transcript). Null = leader chat. Transient — never
   *  persisted; ChatView auto-clears it when the focused agent leaves the
   *  fleet roster (removed, cleared, session stop). */
  subagentChatFocusId: string | null;
  /** Which session the flat `subagentChatFocusId` describes. */
  subagentChatFocusSessionId: string | null;
  /** Process Monitor overlay — triggered by /kill slash command. */
  processMonitorOpen: boolean;
  /** Queue Panel overlay — triggered by /queue slash command. */
  queuePanelOpen: boolean;
  /** Cron Jobs overlay — triggered by /cron slash command. */
  cronJobsOpen: boolean;
  /** Session ID currently being inspected (session-inspect view). */
  inspectSessionId: string | null;
  /** Integrated terminal bottom-dock — toggled by Ctrl+` or /terminal. */
  terminalOpen: boolean;
  /** Monotonic signal consumed by TerminalPanel to create another PTY tab. */
  terminalCreateNonce: number;
  agentRosterActiveTab: 'live' | 'officemap' | 'catalog' | 'learning' | 'memory' | 'customize';
  setAgentRosterActiveTab: (
    tab: 'live' | 'officemap' | 'catalog' | 'learning' | 'memory' | 'customize',
  ) => void;
  /** Active tab inside the Changes side panel. Worktree lanes moved from the
   *  ActivityBar into this panel (kept in the store so shortcuts, slash
   *  commands and the desktop bridge can deep-link to the Worktrees tab). */
  changesPanelTab: 'changes' | 'worktrees';
  setChangesPanelTab: (tab: 'changes' | 'worktrees') => void;
  /** Persisted Settings panel scroll position and active category tab so the user
   *  returns to the exact location after navigating away and back. */
  settingsActiveTab: string;
  /** Generic per-view scroll positions — keyed by view name, restored on remount. */
  scrollPositions: Record<string, number>;
  /** In-memory chat input draft — survives view navigation (e.g. Settings → Chat) but
   *  is intentionally NOT persisted to localStorage, so it does not reappear on a
   *  fresh page load or when starting a new session. */
  draftInput: string;
  /** Pending image attachments mirroring the input draft (see draftInput):
   *  survives view navigation into a subagent transcript, never persisted,
   *  cleared on submit via clearPendingImages → setDraftImages([]). */
  draftImages: ImageAttachment[];
  setDraftInput: (text: string) => void;
  setDraftImages: (images: ImageAttachment[]) => void;
  setProcessMonitorOpen: (open: boolean) => void;
  setQueuePanelOpen: (open: boolean) => void;
  setCronJobsOpen: (open: boolean) => void;
  setInspectSession: (id: string) => void;
  clearInspectSession: () => void;
  setTerminalOpen: (open: boolean) => void;
  toggleTerminal: () => void;
  requestTerminalCreate: () => void;
  setSettingsActiveTab: (tab: string) => void;
  setScrollPosition: (view: string, scrollTop: number) => void;

  /** Context breakdown modal (triggered from side-panel session panel). */
  sideContextBreakdownOpen: boolean;
  setSideContextBreakdownOpen: (open: boolean) => void;
  chatSwitcherOpen: boolean;
  chatCheckpointOpen: boolean;
  chatMemoryPanelOpen: boolean;
  chatContextBreakdownOpen: boolean;
  chatContextEditorOpen: boolean;
  chatToolStatsOpen: boolean;
  chatInputCollapsed: boolean;
  setChatSwitcherOpen: (open: boolean) => void;
  setChatCheckpointOpen: (open: boolean) => void;
  setChatMemoryPanelOpen: (open: boolean) => void;
  setChatContextBreakdownOpen: (open: boolean) => void;
  setChatContextEditorOpen: (open: boolean) => void;
  setChatToolStatsOpen: (open: boolean) => void;
  setChatInputCollapsed: (collapsed: boolean) => void;

  /** Skills panel breadcrumb state — persisted so history survives panel switches. */
  skillsState: {
    /** The skill currently shown in the detail pane. */
    selectedSkill: {
      name: string;
      description: string;
      version: string;
      source: string;
      sourceUrl: string;
      ref: string;
      path: string;
      trigger: string;
      scope: string[];
    } | null;
    /** Ordered history of skills navigated to via related links. */
    navHistory: {
      name: string;
      description: string;
      version: string;
      source: string;
      sourceUrl: string;
      ref: string;
      path: string;
      trigger: string;
      scope: string[];
    }[];
    /** Current position in navHistory. */
    historyIndex: number;
    /** Whether the detail pane is open (controls list highlight vs. detail view). */
    detailOpen: boolean;
    /** Last known commit refs per skill name — compared against live refs to detect updates. */
    knownRefs: Record<string, string>;
    /** Number of installed skills with a newer ref available than knownRefs. */
    updateAvailableCount: number;
  };
  setSkillsState: (state: UIState['skillsState']) => void;

  /** The mailbox message currently shown in the main-area detail view. */
  selectedMailMessage: MailboxMessage | null;
  setSelectedMailMessage: (msg: MailboxMessage | null) => void;

  /** Active prompt-refinement panel. Set while RefinePanel is shown. Null when no refinement is pending. */
  refinePanel: {
    original: string;
    refined: string;
    english: string;
    resolve: (decision: 'refined' | 'english' | 'original' | 'edit') => void;
    /**
     * Lifecycle of the refine round-trip:
     *  - 'countdown': 3-2-1 grace period before refining starts; user can
     *    send the original as-is to skip refinement entirely.
     *  - 'refining': request in flight (first attempt or an extended retry);
     *  - 'ready': a usable refinement arrived (comparison UI shown);
     *  - 'failed': the attempt failed and the recovery UI is shown.
     * Absent → treated as 'refining' (back-compat with the placeholder check).
     */
    status?: 'countdown' | 'refining' | 'ready' | 'failed' | undefined;
    /** Human-readable failure reason (status === 'failed'). */
    error?: string | undefined;
    /** Machine-readable failure class driving the recovery options. */
    errorKind?: 'timeout' | 'empty' | 'provider_error' | undefined;
    /** One-key "retry with another model" offer (provider/model), if the server resolved one. */
    fallbackRef?: string | undefined;
    /** True once the automatic timeout retry has been spent (so we don't loop). */
    retried?: boolean | undefined;
    /** Apply a model-context boundary atomically when the approved prompt is sent. */
    freshContext?: boolean | undefined;
    /** Provider id of the model running the refinement (e.g. "openai"). */
    provider?: string | undefined;
    /** Model name running the refinement (e.g. "gpt-4o"). */
    model?: string | undefined;
    /** Submit behavior to preserve across the refinement approval round-trip. */
    mode?: QueueMode | undefined;
    /** Image attachments from the original submit, preserved so the approval
     *  enqueue path can forward them (mirrors the error/no-op paths in
     *  misc-handlers that pass refImages to enqueue). */
    images?: QueuedItem['images'];
    /**
     * The tab this refinement belongs to.
     *
     * The panel is a single global surface sitting above one shared composer,
     * but the text in it was typed in ONE tab. Approving it — or letting the
     * countdown expire — sends through the foreground facade, so with four
     * tabs open an unstamped panel could deliver tab 1's prompt into tab 2's
     * session, without the user touching anything. ChatInput takes the panel
     * down when the foreground leaves the tab that opened it.
     */
    sessionId?: string | undefined;
  } | null;

  /** Prompt library modal (browse/search/insert prompts) open state. */
  promptLibraryOpen: boolean;
  setPromptLibraryOpen: (open: boolean) => void;
  /** Text the prompt library wants pushed into the chat input. ChatInput consumes + clears it. */
  promptInsertRequest: string | null;
  requestPromptInsert: (text: string) => void;
  clearPromptInsert: () => void;

  /** Select an activity. If clicking the already-active icon, closes the sidebar. */
  selectActivity: (activity: Activity) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setCurrentView: (view: UIState['currentView']) => void;
  showConfirm: (info: UIState['confirmInfo']) => void;
  hideConfirm: () => void;
  setPaletteOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  setSearchQuery: (q: string) => void;
  setSearchActiveMessageId: (id: string | null) => void;
  requestScrollToMessage: (id: string) => void;
  pushPrompt: (text: string) => void;
  setSidebarWidth: (px: number) => void;
  togglePin: (id: string) => void;
  unpinAll: () => void;
  toggleCompactMode: () => void;
  setModelSwitcherOpen: (open: boolean) => void;
  toggleFavoriteSession: (id: string) => void;
  setSessionNickname: (id: string, nickname: string) => void;
  setFileExplorerWidth: (px: number) => void;
  toggleRefineEnabled: () => void;
  setRefinePanel: (panel: UIState['refinePanel']) => void;
  setDockSection: (section: DockSection | null) => void;
  setWorkDashboardTab: (tab: WorkDashboardTab) => void;
  bindSessionChrome: (sessionId: string | null) => void;
  /** Click-a-chip semantics: same section again collapses the dock. */
  toggleDockSection: (section: DockSection) => void;
  /** Show/hide a dock chip from the customization menu. */
  toggleChipHidden: (section: DockSection) => void;
  /** Make a dock chip visible without toggling it off when it is already visible. */
  showDockChip: (section: DockSection) => void;
  setDockCustomizeOpen: (open: boolean) => void;
  setFleetMonitorOpen: (open: boolean) => void;
  setAgentsMonitorOpen: (open: boolean) => void;
  setInspectorOpen: (open: boolean) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  openInspectorTarget: (target: InspectorTarget) => void;
  closeInspector: () => void;
  setInspectorFocusedAgentId: (id: string | null) => void;
  setSubagentChatFocus: (id: string | null, sessionId?: string | null) => void;
  /** Forget a closed tab's subagent focus so a reused id cannot inherit it. */
  forgetSession: (sessionId: string) => void;
  toggleInspector: () => void;
}
