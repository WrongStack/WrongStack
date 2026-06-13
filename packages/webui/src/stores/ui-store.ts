import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ============================================
// UI Store
// ============================================

// Activity types shown in the ActivityBar (secondary panel content).
// One icon = one full panel. 'context' and 'sessions' were folded into
// 'chat' and 'history' — coerceActivity maps persisted legacy values.
export type Activity = 'chat' | 'agents' | 'history' | 'files' | 'projects' | 'mailbox';

const ACTIVITIES: readonly Activity[] = ['chat', 'agents', 'history', 'files', 'projects', 'mailbox'];

/** Map any persisted (possibly legacy) activity value onto the current set. */
export function coerceActivity(value: unknown): Activity {
  if (ACTIVITIES.includes(value as Activity)) return value as Activity;
  if (value === 'context') return 'chat';
  if (value === 'sessions') return 'history';
  return 'chat';
}

/** Single source of truth for the secondary panel width bounds. */
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 560;
export const SIDEBAR_DEFAULT_WIDTH = 304;

/** Sections of the WorkspaceDock strip above the chat transcript. */
export type DockSection = 'autophase' | 'goal' | 'fleet' | 'work' | 'worktrees' | 'collab';

interface UIState {
  sidebarOpen: boolean;
  /** Which activity icon is selected in the ActivityBar — controls secondary panel content. */
  activeActivity: Activity;
  settingsOpen: boolean;
  currentView: 'chat' | 'settings' | 'autophase' | 'agents' | 'files' | 'sessions' | 'setup' | 'agentflow' | 'fleet';
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
  /** Full-screen Fleet Monitor overlay. */
  fleetMonitorOpen: boolean;
  /** Full-screen Agents Monitor overlay. */
  agentsMonitorOpen: boolean;

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
  /** Click-a-chip semantics: same section again collapses the dock. */
  toggleDockSection: (section: DockSection) => void;
  setFleetMonitorOpen: (open: boolean) => void;
  setAgentsMonitorOpen: (open: boolean) => void;
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
      fleetMonitorOpen: false,
      agentsMonitorOpen: false,

      selectActivity: (activity) => set({ activeActivity: activity }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      setCurrentView: (view) => set({ currentView: view }),
      showConfirm: (info) => set({ showConfirmDialog: true, confirmInfo: info }),
      hideConfirm: () => set({ showConfirmDialog: false, confirmInfo: null }),
      setPaletteOpen: (open) => set({ paletteOpen: open }),
      setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
      setSearchOpen: (open) => set({ searchOpen: open, searchQuery: open ? '' : '' }),
      setSearchQuery: (q) => set({ searchQuery: q }),
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
      toggleDockSection: (section) =>
        set((s) => ({ dockSection: s.dockSection === section ? null : section })),
      setFleetMonitorOpen: (open) => set({ fleetMonitorOpen: open }),
      setAgentsMonitorOpen: (open) => set({ agentsMonitorOpen: open }),
    }),
    {
      name: 'wrongstack-ui',
      version: 1,
      // v0 → v1: 'context'/'sessions' activities were removed and the
      // sidebar width bounds changed — coerce persisted values so a stale
      // localStorage entry can't select a panel that no longer exists.
      migrate: (persisted) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        p.activeActivity = coerceActivity(p.activeActivity);
        if (typeof p.sidebarWidth === 'number') {
          p.sidebarWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, p.sidebarWidth));
        }
        return p as unknown as UIState;
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
      }),
    },
  ),
);
