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
export type Activity =
  | 'chat'
  | 'agents'
  | 'files'
  | 'changes'
  | 'mailbox'
  | 'skills'
  | 'design'
  | 'worktrees'
  | 'officemap';

const ACTIVITIES: readonly Activity[] = [
  'chat',
  'agents',
  'files',
  'changes',
  'mailbox',
  'skills',
  'design',
  'worktrees',
  'officemap',
];

/** Map any persisted (possibly legacy) activity value onto the current set. */
export function coerceActivity(value: unknown): Activity {
  if (ACTIVITIES.includes(value as Activity)) return value as Activity;
  if (value === 'context') return 'chat';
  if (value === 'history' || value === 'sessions') return 'chat';
  if (value === 'projects') return 'chat';
  if (value === 'officemap') return 'officemap';
  return 'chat';
}

/** All valid currentView values. Kept in sync with the union on UIState. */
const VIEWS = [
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
  'officemap',
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
] as const;
type View = (typeof VIEWS)[number];

/** Coerce an arbitrary value onto the current view union. Used by migrate
 *  when reading from localStorage so a stale value (e.g. 'context', a view
 *  removed in v3) lands on 'chat' rather than crashing the router. */
export function coerceView(value: unknown): View {
  return (VIEWS as readonly string[]).includes(value as string) ? (value as View) : 'chat';
}

const DOCK_SECTIONS = ['goal', 'goal-state', 'fleet', 'work', 'worktrees', 'collab'] as const;

function coerceDockSection(value: unknown): DockSection | null {
  return value === null || value === undefined || !DOCK_SECTIONS.includes(value as DockSection)
    ? null
    : (value as DockSection);
}

const SETTINGS_TABS = [
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

function coerceSettingsTab(value: unknown): string {
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

interface UIState {
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
  /** Per-tab subagent focus, so switching tabs restores what each was showing. */
  subagentChatFocusBySession: Record<string, string | null>;
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
  toggleInspector: () => void;
}

function isDesktopShellStorageContext(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as unknown as { wrongstackDesktopHost?: unknown }).wrongstackDesktopHost) {
    return true;
  }
  try {
    return new URLSearchParams(window.location.search).get('shell') === 'desktop';
  } catch {
    return false;
  }
}

function homeNavigationStatePatch(
  options: { sidebarOpen?: boolean | undefined } = {},
): Partial<UIState> {
  return {
    currentView: 'chat',
    activeActivity: 'chat',
    sidebarOpen: options.sidebarOpen ?? false,
    dockSection: null,
    dockCustomizeOpen: false,
    fleetMonitorOpen: false,
    agentsMonitorOpen: false,
    processMonitorOpen: false,
    queuePanelOpen: false,
    cronJobsOpen: false,
    sideContextBreakdownOpen: false,
    inspectorOpen: false,
    inspectorTab: 'fleet',
    inspectorTarget: null,
    inspectorFocusedAgentId: null,
    subagentChatFocusId: null,
    subagentChatFocusSessionId: null,
    subagentChatFocusBySession: {},
    terminalOpen: false,
    paletteOpen: false,
    shortcutsOpen: false,
    searchOpen: false,
    searchQuery: '',
    searchActiveMessageId: null,
    modelSwitcherOpen: false,
    promptLibraryOpen: false,
    selectedMailMessage: null,
    refinePanel: null,
  };
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      activeActivity: 'chat',
      settingsOpen: false,
      currentView: 'chat',
      showConfirmDialog: false,
      confirmInfo: null,
      paletteOpen: false,
      shortcutsOpen: false,
      searchOpen: false,
      searchQuery: '',
      searchActiveMessageId: null,
      scrollTarget: null,
      promptHistory: [],
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      pinnedIds: [],
      compactMode: false,
      modelSwitcherOpen: false,
      favoriteSessionIds: [],
      sessionNicknames: {},
      fileExplorerWidth: 220,
      refineEnabled: true,
      refinePanel: null,
      promptLibraryOpen: false,
      promptInsertRequest: null,
      dockSection: null,
      workDashboardTab: 'todos',
      hiddenChips: [],
      dockCustomizeOpen: false,
      fleetMonitorOpen: false,
      agentsMonitorOpen: false,
      inspectorOpen: false,
      inspectorTab: 'fleet',
      inspectorTarget: null,
      inspectorFocusedAgentId: null,
      subagentChatFocusId: null,
      subagentChatFocusSessionId: null,
      subagentChatFocusBySession: {},
      processMonitorOpen: false,
      queuePanelOpen: false,
      cronJobsOpen: false,
      inspectSessionId: null,
      terminalOpen: false,
      terminalCreateNonce: 0,
      agentRosterActiveTab: 'live',
      settingsActiveTab: 'general',
      scrollPositions: {},
      draftInput: '',
      draftImages: [],
      sideContextBreakdownOpen: false,
      selectedMailMessage: null,
      skillsState: {
        selectedSkill: null,
        navHistory: [],
        historyIndex: -1,
        detailOpen: false,
        knownRefs: {},
        updateAvailableCount: 0,
      },

      selectActivity: (activity) => set({ activeActivity: activity }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      setCurrentView: (view) => set({ currentView: coerceView(view) }),
      showConfirm: (info) => set({ showConfirmDialog: true, confirmInfo: info }),
      hideConfirm: () => set({ showConfirmDialog: false, confirmInfo: null }),
      setPaletteOpen: (open) => set({ paletteOpen: open }),
      setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
      setSearchOpen: (open) =>
        set({ searchOpen: open, searchQuery: '', searchActiveMessageId: null }),
      setSearchQuery: (q) => set({ searchQuery: q }),
      setSearchActiveMessageId: (id) => set({ searchActiveMessageId: id }),
      requestScrollToMessage: (id) =>
        set((s) => ({ scrollTarget: { id, nonce: (s.scrollTarget?.nonce ?? 0) + 1 } })),
      pushPrompt: (text) =>
        set((state) => {
          const trimmed = text.trim();
          if (!trimmed) return state;
          const filtered = state.promptHistory.filter((p) => p !== trimmed);
          return { promptHistory: [trimmed, ...filtered].slice(0, 50) };
        }),
      setSidebarWidth: (px) =>
        set({
          sidebarWidth: Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(px))),
        }),
      togglePin: (id) =>
        set((state) => {
          const has = state.pinnedIds.includes(id);
          return {
            pinnedIds: has ? state.pinnedIds.filter((p) => p !== id) : [...state.pinnedIds, id],
          };
        }),
      unpinAll: () => set({ pinnedIds: [] }),
      toggleCompactMode: () => set((s) => ({ compactMode: !s.compactMode })),
      setModelSwitcherOpen: (open) => set({ modelSwitcherOpen: open }),
      toggleFavoriteSession: (id) =>
        set((state) => {
          const has = state.favoriteSessionIds.includes(id);
          return {
            favoriteSessionIds: has
              ? state.favoriteSessionIds.filter((s) => s !== id)
              : [...state.favoriteSessionIds, id],
          };
        }),
      setSessionNickname: (id, nickname) =>
        set((state) => {
          const trimmed = nickname.trim();
          const next = { ...state.sessionNicknames };
          if (trimmed) next[id] = trimmed;
          else delete next[id];
          return { sessionNicknames: next };
        }),
      setFileExplorerWidth: (px) =>
        set({ fileExplorerWidth: Math.max(160, Math.min(400, Math.round(px))) }),
      toggleRefineEnabled: () => set((s) => ({ refineEnabled: !s.refineEnabled })),
      setRefinePanel: (panel) => set({ refinePanel: panel }),
      setPromptLibraryOpen: (open) => set({ promptLibraryOpen: open }),
      requestPromptInsert: (text) => set({ promptInsertRequest: text, promptLibraryOpen: false }),
      clearPromptInsert: () => set({ promptInsertRequest: null }),
      setDockSection: (section) =>
        set({ dockSection: section, ...(section ? { inspectorOpen: false } : {}) }),
      setWorkDashboardTab: (tab) => set({ workDashboardTab: tab }),
      toggleDockSection: (section) =>
        set((s) => {
          const dockSection = s.dockSection === section ? null : section;
          return { dockSection, ...(dockSection ? { inspectorOpen: false } : {}) };
        }),
      toggleChipHidden: (section) =>
        set((s) => {
          const hidden = s.hiddenChips.includes(section);
          return {
            hiddenChips: hidden
              ? s.hiddenChips.filter((c) => c !== section)
              : [...s.hiddenChips, section],
            // Collapse the dock if we're hiding the currently-open section.
            dockSection: !hidden && s.dockSection === section ? null : s.dockSection,
          };
        }),
      showDockChip: (section) =>
        set((s) => ({
          hiddenChips: s.hiddenChips.filter((candidate) => candidate !== section),
        })),
      setDockCustomizeOpen: (open) => set({ dockCustomizeOpen: open }),
      setAgentRosterActiveTab: (tab) => set({ agentRosterActiveTab: tab }),
      // Compatibility entry points used by slash routes and Desktop commands.
      // The legacy booleans remain false so no second overlay can be mounted.
      setFleetMonitorOpen: (open: boolean) =>
        set((s) => ({
          fleetMonitorOpen: false,
          inspectorOpen: open ? true : s.inspectorTab === 'fleet' ? false : s.inspectorOpen,
          inspectorTab: open ? 'fleet' : s.inspectorTab,
          ...(open ? { dockSection: null } : {}),
        })),
      setAgentsMonitorOpen: (open: boolean) =>
        set((s) => ({
          agentsMonitorOpen: false,
          inspectorOpen: open ? true : s.inspectorTab === 'agents' ? false : s.inspectorOpen,
          inspectorTab: open ? 'agents' : s.inspectorTab,
          ...(open ? { dockSection: null } : {}),
        })),
      setInspectorOpen: (open: boolean) =>
        set({ inspectorOpen: open, ...(open ? { dockSection: null } : { inspectorTarget: null }) }),
      setInspectorTab: (tab: InspectorTab) => set({ inspectorTab: tab }),
      openInspectorTarget: (target: InspectorTarget) =>
        set((s) => {
          let tab: InspectorTab = s.inspectorTab;
          let focusedAgentId: string | null = s.inspectorFocusedAgentId;
          if (target.kind === 'fleet') {
            tab = target.tab ?? 'fleet';
          } else if (target.kind === 'agent') {
            tab = 'agents';
            focusedAgentId = target.agentId;
          } else if (target.kind === 'sideEffects') {
            tab = 'sideEffects';
          } else if (target.kind === 'council') {
            tab = 'council';
          }
          return {
            inspectorOpen: true,
            inspectorTarget: target,
            inspectorTab: tab,
            inspectorFocusedAgentId: focusedAgentId,
            dockSection: null,
          };
        }),
      closeInspector: () => set({ inspectorOpen: false, inspectorTarget: null }),
      setInspectorFocusedAgentId: (id: string | null) => set({ inspectorFocusedAgentId: id }),
      // Which subagent transcript is open is a property of the TAB, not of the
      // app: focusing one in tab 2 must not swap tab 1's chat out from under
      // the user. The map is keyed by session; the flat field stays as the
      // foreground projection so existing readers keep working.
      setSubagentChatFocus: (id: string | null, sessionId?: string | null) =>
        set((state) => {
          const key = sessionId ?? state.subagentChatFocusSessionId;
          return {
            subagentChatFocusId: id,
            subagentChatFocusSessionId: key ?? null,
            subagentChatFocusBySession: key
              ? { ...state.subagentChatFocusBySession, [key]: id }
              : state.subagentChatFocusBySession,
          };
        }),
      toggleInspector: () =>
        set((s) => ({
          inspectorOpen: !s.inspectorOpen,
          ...(!s.inspectorOpen ? { dockSection: null } : {}),
        })),
      setProcessMonitorOpen: (open: boolean) => set({ processMonitorOpen: open }),
      setQueuePanelOpen: (open: boolean) => set({ queuePanelOpen: open }),
      setCronJobsOpen: (open: boolean) => set({ cronJobsOpen: open }),
      setInspectSession: (id: string) =>
        set({ inspectSessionId: id, currentView: 'session-inspect' as View }),
      clearInspectSession: () => set({ inspectSessionId: null, currentView: 'chat' }),
      setTerminalOpen: (open: boolean) => set({ terminalOpen: open }),
      toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
      requestTerminalCreate: () => set((s) => ({ terminalCreateNonce: s.terminalCreateNonce + 1 })),
      setSettingsActiveTab: (tab: string) => set({ settingsActiveTab: coerceSettingsTab(tab) }),
      setScrollPosition: (view: string, scrollTop: number) =>
        set((s) => ({ scrollPositions: { ...s.scrollPositions, [view]: scrollTop } })),
      setDraftInput: (text: string) => set({ draftInput: text }),
      setDraftImages: (images) =>
        // Trust boundary: data URLs are heavy — enforce the same per-message
        // cap the composer enforces so no caller can bloat memory.
        set({ draftImages: images.slice(-MAX_ATTACHED_IMAGES) }),
      setSideContextBreakdownOpen: (open: boolean) => set({ sideContextBreakdownOpen: open }),
      setSkillsState: (state) => set({ skillsState: state }),
      setSelectedMailMessage: (msg) => set({ selectedMailMessage: msg }),
    }),
    {
      name: 'wrongstack-ui',
      version: 6,
      // v0 → v1: 'context'/'sessions' activities were removed and the
      // sidebar width bounds changed — coerce persisted values so a stale
      // localStorage entry can't select a panel that no longer exists.
      // v1 → v2: the modal FleetDrawer/AgentsDrawer were replaced by a
      // single docked InspectorPanel; drop the stale drawer booleans so
      // they can't force the (removed) fields back into state.
      // v2 → v3: added skillsState for Skills panel breadcrumb persistence.
      // v3 → v4: added knownRefs and updateAvailableCount to skillsState.
      // v4 → v5: added `currentView` and `dockSection` to partialize
      // (F5-resilience). No shape change to existing fields — the coerce
      // for the new fields is defensive in case a user with a hand-
      // edited localStorage entry lands here first.
      // v5 → v6: removed `draftInput` from partialize. The chat input draft
      // is now in-memory only (survives Settings→Chat view navigation but
      // NOT page reload or new sessions). Stale draftInput values from v5
      // localStorage are dropped here so they don't bleed into a new session.
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        p.activeActivity = coerceActivity(p.activeActivity);
        if (typeof p.sidebarWidth === 'number') {
          p.sidebarWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, p.sidebarWidth));
        }
        if (version < 2) {
          delete p.fleetDrawerOpen;
          delete p.agentsDrawerOpen;
        }
        // v5: defensive coerce of the newly-persisted fields.
        if ('currentView' in p) {
          p.currentView = coerceView(p.currentView);
        }
        if ('dockSection' in p) {
          p.dockSection = coerceDockSection(p.dockSection);
        }
        if ('settingsActiveTab' in p) {
          p.settingsActiveTab = coerceSettingsTab(p.settingsActiveTab);
        }
        if (version < 6) {
          // v6: draftInput is no longer persisted — drop any stale value
          // so it doesn't bleed into a new session on next load.
          delete p.draftInput;
        }
        return p as never as UIState;
      },
      merge: (persisted, current) => {
        const merged = {
          ...current,
          ...((persisted ?? {}) as Partial<UIState>),
        } as UIState;
        merged.activeActivity = coerceActivity(merged.activeActivity);
        merged.currentView = coerceView(merged.currentView);
        merged.dockSection = coerceDockSection(merged.dockSection);
        merged.settingsActiveTab = coerceSettingsTab(merged.settingsActiveTab);
        merged.sidebarWidth = Math.max(
          SIDEBAR_MIN_WIDTH,
          Math.min(SIDEBAR_MAX_WIDTH, merged.sidebarWidth),
        );
        return isDesktopShellStorageContext()
          ? { ...merged, ...homeNavigationStatePatch({ sidebarOpen: false }) }
          : merged;
      },
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        activeActivity: s.activeActivity,
        sidebarWidth: s.sidebarWidth,
        promptHistory: s.promptHistory,
        pinnedIds: s.pinnedIds,
        compactMode: s.compactMode,
        favoriteSessionIds: s.favoriteSessionIds,
        sessionNicknames: s.sessionNicknames,
        fileExplorerWidth: s.fileExplorerWidth,
        refineEnabled: s.refineEnabled,
        hiddenChips: s.hiddenChips,
        workDashboardTab: s.workDashboardTab,
        inspectorOpen: s.inspectorOpen,
        inspectorTab: s.inspectorTab,
        skillsState: s.skillsState,
        // ── F5 resilience additions ──
        // currentView + dockSection pair: after F5 we land the user
        // back on whichever main view + dock section they were on. This
        // is the *last-known-good* view; if the active session switches
        // (e.g. resume of a different session), the connection layer is
        // expected to navigate back to chat defensively because
        // non-chat views are session-agnostic and can confuse the user
        // when the session doesn't actually own them. Navigation callers
        // should go through `view-navigation` helpers so the side-panel and
        // main view stay paired.
        //
        // We intentionally do NOT persist overlay open states
        // (processMonitorOpen, queuePanelOpen, terminalOpen, etc.):
        // those should land closed after F5. The dock, sidebar, and main
        // view *are* the user's persistent workspace, so they survive.
        currentView: s.currentView,
        dockSection: s.dockSection,
        settingsActiveTab: s.settingsActiveTab,
        scrollPositions: s.scrollPositions,
        // draftInput intentionally NOT persisted — it is in-memory only so
        // a stale draft from a previous session does not reappear on a
        // fresh WebUI load or after starting a new session. View navigation
        // (Settings → Chat) reads it from the live store, not localStorage.
      }),
    },
  ),
);

export function resetUiNavigationToHome(options: { sidebarOpen?: boolean | undefined } = {}): void {
  useUIStore.setState(homeNavigationStatePatch(options));
}
