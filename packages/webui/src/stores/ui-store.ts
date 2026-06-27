import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { MailboxMessage } from './mailbox-store';

// ============================================
// UI Store
// ============================================

// Activity types shown in the ActivityBar (secondary panel content).
// One icon = one full panel. 'context' and 'sessions' were folded into
// 'chat' and 'history' — coerceActivity maps persisted legacy values.
export type Activity = 'chat' | 'agents' | 'history' | 'files' | 'changes' | 'projects' | 'mailbox' | 'skills' | 'design' | 'officemap';

const ACTIVITIES: readonly Activity[] = ['chat', 'agents', 'history', 'files', 'changes', 'projects', 'mailbox', 'skills', 'officemap'];

/** Map any persisted (possibly legacy) activity value onto the current set. */
export function coerceActivity(value: unknown): Activity {
  if (ACTIVITIES.includes(value as Activity)) return value as Activity;
  if (value === 'context') return 'chat';
  if (value === 'sessions') return 'history';
  if (value === 'officemap') return 'officemap';
  return 'chat';
}

/** Single source of truth for the secondary panel width bounds. */
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 560;
export const SIDEBAR_DEFAULT_WIDTH = 304;

/** Sections of the WorkspaceDock strip above the chat transcript. */
export type DockSection = 'autophase' | 'goal' | 'fleet' | 'work' | 'worktrees' | 'collab';
export type WorkDashboardTab = 'todos' | 'tasks' | 'plan';

interface UIState {
  sidebarOpen: boolean;
  /** Which activity icon is selected in the ActivityBar — controls secondary panel content. */
  activeActivity: Activity;
  settingsOpen: boolean;
  currentView: 'chat' | 'settings' | 'autophase' | 'specs' | 'sddboard' | 'sddwizard' | 'files' | 'changes' | 'sessions' | 'setup' | 'skill' | 'officemap' | 'mailbox' | 'debug' | 'design-gallery';
  showConfirmDialog: boolean;
  confirmInfo: {
    id: string;
    toolName: string;
    input: unknown;
    suggestedPattern: string;
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
  /** Which WorkspaceDock section is expanded above the chat. Null = all collapsed. */
  dockSection: DockSection | null;
  /** Active tab in the Work dock section. Mirrors TUI F5/F6 panel jumps. */
  workDashboardTab: WorkDashboardTab;
  /** Dock chips the user has explicitly hidden via the customization menu.
   *  Empty = all chips visible (subject to each chip's own data condition).
   *  Mirrors the TUI's F12 status-line chip picker. */
  hiddenChips: DockSection[];
  /** Controlled open state for the dock chip customization menu. */
  dockCustomizeOpen: boolean;
  /** Full-screen Fleet Monitor overlay. */
  fleetMonitorOpen: boolean;
  /** Full-screen Agents Monitor overlay. */
  agentsMonitorOpen: boolean;
  /** Bottom inspector panel open (DevTools-style docked panel). */
  inspectorOpen: boolean;
  /** Active tab inside the bottom inspector panel. */
  inspectorTab: 'fleet' | 'agents';
  /** Process Monitor overlay — triggered by /kill slash command. */
  processMonitorOpen: boolean;
  /** Queue Panel overlay — triggered by /queue slash command. */
  queuePanelOpen: boolean;
  /** Integrated terminal bottom-dock — toggled by Ctrl+` or /terminal. */
  terminalOpen: boolean;
  setProcessMonitorOpen: (open: boolean) => void;
  setQueuePanelOpen: (open: boolean) => void;
  setTerminalOpen: (open: boolean) => void;
  toggleTerminal: () => void;

  /** Skills panel breadcrumb state — persisted so history survives panel switches. */
  skillsState: {
    /** The skill currently shown in the detail pane. */
    selectedSkill: { name: string; description: string; version: string; source: string; sourceUrl: string; ref: string; path: string; trigger: string; scope: string[] } | null;
    /** Ordered history of skills navigated to via related links. */
    navHistory: { name: string; description: string; version: string; source: string; sourceUrl: string; ref: string; path: string; trigger: string; scope: string[] }[];
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
  } | null;

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
  setDockCustomizeOpen: (open: boolean) => void;
  setFleetMonitorOpen: (open: boolean) => void;
  setAgentsMonitorOpen: (open: boolean) => void;
  setInspectorOpen: (open: boolean) => void;
  setInspectorTab: (tab: 'fleet' | 'agents') => void;
  toggleInspector: () => void;
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
      dockSection: null,
      workDashboardTab: 'todos',
      hiddenChips: [],
      dockCustomizeOpen: false,
      fleetMonitorOpen: false,
      agentsMonitorOpen: false,
      inspectorOpen: false,
      inspectorTab: 'fleet',
      processMonitorOpen: false,
      queuePanelOpen: false,
      terminalOpen: false,
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
      setCurrentView: (view) => set({ currentView: view }),
      showConfirm: (info) => set({ showConfirmDialog: true, confirmInfo: info }),
      hideConfirm: () => set({ showConfirmDialog: false, confirmInfo: null }),
      setPaletteOpen: (open) => set({ paletteOpen: open }),
      setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
      setSearchOpen: (open) => set({ searchOpen: open, searchQuery: '', searchActiveMessageId: null }),
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
        set({ sidebarWidth: Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(px))) }),
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
      setDockSection: (section) => set({ dockSection: section }),
      setWorkDashboardTab: (tab) => set({ workDashboardTab: tab }),
      toggleDockSection: (section) =>
        set((s) => ({ dockSection: s.dockSection === section ? null : section })),
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
      setDockCustomizeOpen: (open) => set({ dockCustomizeOpen: open }),
      setFleetMonitorOpen: (open: boolean) => set({ fleetMonitorOpen: open }),
      setAgentsMonitorOpen: (open: boolean) => set({ agentsMonitorOpen: open }),
      setInspectorOpen: (open: boolean) => set({ inspectorOpen: open }),
      setInspectorTab: (tab: 'fleet' | 'agents') => set({ inspectorTab: tab }),
      toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
      setProcessMonitorOpen: (open: boolean) => set({ processMonitorOpen: open }),
      setQueuePanelOpen: (open: boolean) => set({ queuePanelOpen: open }),
      setTerminalOpen: (open: boolean) => set({ terminalOpen: open }),
      toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
      setSkillsState: (state) => set({ skillsState: state }),
      setSelectedMailMessage: (msg) => set({ selectedMailMessage: msg }),
    }),
    {
      name: 'wrongstack-ui',
      version: 4,
      // v0 → v1: 'context'/'sessions' activities were removed and the
      // sidebar width bounds changed — coerce persisted values so a stale
      // localStorage entry can't select a panel that no longer exists.
      // v1 → v2: the modal FleetDrawer/AgentsDrawer were replaced by a
      // single docked InspectorPanel; drop the stale drawer booleans so
      // they can't force the (removed) fields back into state.
      // v2 → v3: added skillsState for Skills panel breadcrumb persistence.
      // v3 → v4: added knownRefs and updateAvailableCount to skillsState.
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
        return p as never as UIState;
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
      }),
    },
  ),
);
