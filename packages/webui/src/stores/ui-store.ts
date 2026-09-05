export type {
  Activity,
  View,
  DockSection,
  WorkDashboardTab,
  InspectorTab,
  InspectorTarget,
  SessionChromeState,
  UIState,
} from "./ui-store-types.js";
export {
  ACTIVITIES,
  coerceActivity,
  VIEWS,
  coerceView,
  DOCK_SECTIONS,
  coerceDockSection,
  SETTINGS_TABS,
  coerceSettingsTab,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
} from "./ui-store-types.js";

// Re-export chrome helpers
export {
  isDesktopShellStorageContext,
  homeNavigationStatePatch,
  defaultSkillsState,
  defaultSessionChrome,
  readSessionChrome,
  parkChrome,
} from "./ui-store-chrome.js";

export { uiPersistOptions } from "./ui-store-persist.js";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { MAX_ATTACHED_IMAGES } from "../components/ChatInput/image-attachments.js";
import type { UIState, View, InspectorTab, InspectorTarget } from "./ui-store-types.js";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, coerceView, coerceSettingsTab } from "./ui-store-types.js";
import {
  homeNavigationStatePatch,
  defaultSkillsState,
  defaultSessionChrome,
  readSessionChrome,
  parkChrome,
} from "./ui-store-chrome.js";
import { uiPersistOptions } from "./ui-store-persist.js";

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
      chromeSessionId: null,
      chromeBySession: {},
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
      processMonitorOpen: false,
      queuePanelOpen: false,
      cronJobsOpen: false,
      inspectSessionId: null,
      terminalOpen: false,
      terminalCreateNonce: 0,
      agentRosterActiveTab: 'live',
      changesPanelTab: 'changes',
      settingsActiveTab: 'general',
      scrollPositions: {},
      draftInput: '',
      draftImages: [],
      sideContextBreakdownOpen: false,
      chatSwitcherOpen: false,
      chatCheckpointOpen: false,
      chatMemoryPanelOpen: false,
      chatContextBreakdownOpen: false,
      chatContextEditorOpen: false,
      chatToolStatsOpen: false,
      chatInputCollapsed: false,
      selectedMailMessage: null,
      skillsState: defaultSkillsState(),

      selectActivity: (activity) =>
        set((state) => ({
          activeActivity: activity,
          ...parkChrome(state, { activeActivity: activity }),
        })),
      toggleSidebar: () =>
        set((state) => {
          const sidebarOpen = !state.sidebarOpen;
          return {
            sidebarOpen,
            ...parkChrome(state, { sidebarOpen }),
          };
        }),
      setSidebarOpen: (open) =>
        set((state) => ({
          sidebarOpen: open,
          ...parkChrome(state, { sidebarOpen: open }),
        })),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      setCurrentView: (view) =>
        set((state) => {
          const currentView = coerceView(view);
          return { currentView, ...parkChrome(state, { currentView }) };
        }),
      showConfirm: (info) => set({ showConfirmDialog: true, confirmInfo: info }),
      hideConfirm: () => set({ showConfirmDialog: false, confirmInfo: null }),
      setPaletteOpen: (open) => set({ paletteOpen: open }),
      setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
      setSearchOpen: (open) =>
        set((state) => ({
          searchOpen: open,
          searchQuery: '',
          searchActiveMessageId: null,
          ...parkChrome(state, {
            searchOpen: open,
            searchQuery: '',
            searchActiveMessageId: null,
          }),
        })),
      setSearchQuery: (q) =>
        set((state) => ({
          searchQuery: q,
          ...parkChrome(state, { searchQuery: q }),
        })),
      setSearchActiveMessageId: (id) =>
        set((state) => ({
          searchActiveMessageId: id,
          ...parkChrome(state, { searchActiveMessageId: id }),
        })),
      requestScrollToMessage: (id) =>
        set((s) => {
          const scrollTarget = { id, nonce: (s.scrollTarget?.nonce ?? 0) + 1 };
          return { scrollTarget, ...parkChrome(s, { scrollTarget }) };
        }),
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
      setModelSwitcherOpen: (open) =>
        set((state) => ({
          modelSwitcherOpen: open,
          ...parkChrome(state, { modelSwitcherOpen: open }),
        })),
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
      setRefinePanel: (panel) =>
        set((state) => ({
          refinePanel: panel,
          ...parkChrome(state, { refinePanel: panel }),
        })),
      setPromptLibraryOpen: (open) =>
        set((state) => ({
          promptLibraryOpen: open,
          ...parkChrome(state, { promptLibraryOpen: open }),
        })),
      requestPromptInsert: (text) =>
        set((state) => ({
          promptInsertRequest: text,
          promptLibraryOpen: false,
          ...parkChrome(state, { promptInsertRequest: text, promptLibraryOpen: false }),
        })),
      clearPromptInsert: () =>
        set((state) => ({
          promptInsertRequest: null,
          ...parkChrome(state, { promptInsertRequest: null }),
        })),
      setDockSection: (section) =>
        set((state) => ({
          dockSection: section,
          ...parkChrome(state, {
            dockSection: section,
            inspectorOpen: section ? false : state.inspectorOpen,
          }),
          ...(section ? { inspectorOpen: false } : {}),
        })),
      setWorkDashboardTab: (tab) =>
        set((state) => ({
          workDashboardTab: tab,
          ...parkChrome(state, { workDashboardTab: tab }),
        })),
      bindSessionChrome: (sessionId) =>
        set((state) => {
          if (state.chromeSessionId === sessionId) return {};
          const chromeBySession = { ...state.chromeBySession };
          if (state.chromeSessionId) {
            const previousChrome = readSessionChrome(state);
            chromeBySession[state.chromeSessionId] = previousChrome.refinePanel
              ? {
                  ...previousChrome,
                  refinePanel: null,
                  draftInput: previousChrome.refinePanel.original,
                }
              : previousChrome;
          }
          const parked = sessionId ? chromeBySession[sessionId] : undefined;
          const chrome = parked ?? defaultSessionChrome();
          // Arriving at a session always lands on the Leader chat: subagent
          // focus is foreground-only and never follows the user across tabs.
          return {
            chromeSessionId: sessionId,
            chromeBySession,
            subagentChatFocusId: null,
            subagentChatFocusSessionId: sessionId,
            sidebarOpen: chrome.sidebarOpen ?? defaultSessionChrome().sidebarOpen,
            activeActivity: chrome.activeActivity,
            currentView: chrome.currentView,
            inspectSessionId: chrome.inspectSessionId,
            searchOpen: chrome.searchOpen,
            searchQuery: chrome.searchQuery,
            searchActiveMessageId: chrome.searchActiveMessageId,
            scrollTarget: chrome.scrollTarget,
            modelSwitcherOpen: chrome.modelSwitcherOpen,
            promptLibraryOpen: chrome.promptLibraryOpen,
            promptInsertRequest: chrome.promptInsertRequest,
            refinePanel: chrome.refinePanel,
            draftInput: chrome.draftInput,
            draftImages: chrome.draftImages,
            processMonitorOpen: chrome.processMonitorOpen,
            queuePanelOpen: chrome.queuePanelOpen,
            cronJobsOpen: chrome.cronJobsOpen,
            sideContextBreakdownOpen: chrome.sideContextBreakdownOpen,
            terminalOpen: chrome.terminalOpen,
            dockSection: chrome.dockSection,
            workDashboardTab: chrome.workDashboardTab,
            inspectorOpen: chrome.inspectorOpen,
            inspectorTab: chrome.inspectorTab,
            inspectorTarget: chrome.inspectorTarget,
            inspectorFocusedAgentId: chrome.inspectorFocusedAgentId,
            agentRosterActiveTab: chrome.agentRosterActiveTab,
            changesPanelTab: chrome.changesPanelTab,
            dockCustomizeOpen: chrome.dockCustomizeOpen ?? false,
            skillsState: chrome.skillsState ?? defaultSkillsState(),
            selectedMailMessage: chrome.selectedMailMessage ?? null,
            scrollPositions: chrome.scrollPositions ?? {},
            chatSwitcherOpen: chrome.chatSwitcherOpen ?? false,
            chatCheckpointOpen: chrome.chatCheckpointOpen ?? false,
            chatMemoryPanelOpen: chrome.chatMemoryPanelOpen ?? false,
            chatContextBreakdownOpen: chrome.chatContextBreakdownOpen ?? false,
            chatContextEditorOpen: chrome.chatContextEditorOpen ?? false,
            chatInputCollapsed: chrome.chatInputCollapsed ?? false,
          };
        }),
      toggleDockSection: (section) =>
        set((s) => {
          const dockSection = s.dockSection === section ? null : section;
          return {
            dockSection,
            ...parkChrome(s, {
              dockSection,
              inspectorOpen: dockSection ? false : s.inspectorOpen,
            }),
            ...(dockSection ? { inspectorOpen: false } : {}),
          };
        }),
      toggleChipHidden: (section) =>
        set((s) => {
          const hidden = s.hiddenChips.includes(section);
          const dockSection = !hidden && s.dockSection === section ? null : s.dockSection;
          return {
            hiddenChips: hidden
              ? s.hiddenChips.filter((c) => c !== section)
              : [...s.hiddenChips, section],
            // Collapse the dock if we're hiding the currently-open section.
            dockSection,
            ...parkChrome(s, { dockSection }),
          };
        }),
      showDockChip: (section) =>
        set((s) => ({
          hiddenChips: s.hiddenChips.filter((candidate) => candidate !== section),
        })),
      setDockCustomizeOpen: (open) =>
        set((state) => ({
          dockCustomizeOpen: open,
          ...parkChrome(state, { dockCustomizeOpen: open }),
        })),
      setAgentRosterActiveTab: (tab) =>
        set((state) => ({
          agentRosterActiveTab: tab,
          ...parkChrome(state, { agentRosterActiveTab: tab }),
        })),
      setChangesPanelTab: (tab) =>
        set((state) => ({ changesPanelTab: tab, ...parkChrome(state, { changesPanelTab: tab }) })),
      // Compatibility entry points used by slash routes and Desktop commands.
      // The legacy booleans remain false so no second overlay can be mounted.
      setFleetMonitorOpen: (open: boolean) =>
        set((s) => ({
          fleetMonitorOpen: false,
          inspectorOpen: open ? true : s.inspectorTab === 'fleet' ? false : s.inspectorOpen,
          inspectorTab: open ? 'fleet' : s.inspectorTab,
          ...parkChrome(s, {
            inspectorOpen: open ? true : s.inspectorTab === 'fleet' ? false : s.inspectorOpen,
            inspectorTab: open ? 'fleet' : s.inspectorTab,
            dockSection: open ? null : s.dockSection,
          }),
          ...(open ? { dockSection: null } : {}),
        })),
      setAgentsMonitorOpen: (open: boolean) =>
        set((s) => ({
          agentsMonitorOpen: false,
          inspectorOpen: open ? true : s.inspectorTab === 'agents' ? false : s.inspectorOpen,
          inspectorTab: open ? 'agents' : s.inspectorTab,
          ...parkChrome(s, {
            inspectorOpen: open ? true : s.inspectorTab === 'agents' ? false : s.inspectorOpen,
            inspectorTab: open ? 'agents' : s.inspectorTab,
            dockSection: open ? null : s.dockSection,
          }),
          ...(open ? { dockSection: null } : {}),
        })),
      setInspectorOpen: (open: boolean) =>
        set((state) => ({
          inspectorOpen: open,
          ...(open ? { dockSection: null } : { inspectorTarget: null }),
          ...parkChrome(state, {
            inspectorOpen: open,
            dockSection: open ? null : state.dockSection,
            inspectorTarget: open ? state.inspectorTarget : null,
          }),
        })),
      setInspectorTab: (tab: InspectorTab) =>
        set((state) => ({ inspectorTab: tab, ...parkChrome(state, { inspectorTab: tab }) })),
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
            ...parkChrome(s, {
              inspectorOpen: true,
              inspectorTarget: target,
              inspectorTab: tab,
              inspectorFocusedAgentId: focusedAgentId,
              dockSection: null,
            }),
          };
        }),
      closeInspector: () =>
        set((state) => ({
          inspectorOpen: false,
          inspectorTarget: null,
          ...parkChrome(state, { inspectorOpen: false, inspectorTarget: null }),
        })),
      setInspectorFocusedAgentId: (id: string | null) =>
        set((state) => ({
          inspectorFocusedAgentId: id,
          ...parkChrome(state, { inspectorFocusedAgentId: id }),
        })),
      // Which subagent transcript is open is stamped with the session it
      // belongs to, so ChatView can auto-clear a focus that arrives from (or
      // names) another tab. Focus itself is foreground-only: switching tabs
      // always lands on the Leader chat.
      setSubagentChatFocus: (id: string | null, sessionId?: string | null) =>
        set((state) => {
          // '' is "no session" — an empty stamp must never become a map key
          // (it would silently degrade a tab-scoped clear to the unscoped
          // fallback and stamp null onto whatever the flat pointer names).
          const requested = sessionId === '' ? null : sessionId;
          const key = requested ?? state.chromeSessionId ?? state.subagentChatFocusSessionId;
          return {
            subagentChatFocusId: id,
            subagentChatFocusSessionId: key ?? null,
          };
        }),
      forgetSession: (sessionId) =>
        set((state) => {
          const hasSubagentFocus = state.subagentChatFocusSessionId === sessionId;
          const hasChrome =
            sessionId in state.chromeBySession || state.chromeSessionId === sessionId;
          if (!hasSubagentFocus && !hasChrome) {
            return state;
          }
          const nextChrome = { ...state.chromeBySession };
          delete nextChrome[sessionId];
          const droppingFront = state.subagentChatFocusSessionId === sessionId;
          const droppingChrome = state.chromeSessionId === sessionId;
          return {
            chromeBySession: nextChrome,
            ...(droppingFront
              ? { subagentChatFocusId: null, subagentChatFocusSessionId: null }
              : {}),
            ...(droppingChrome ? { chromeSessionId: null, ...defaultSessionChrome() } : {}),
          };
        }),
      toggleInspector: () =>
        set((s) => {
          const inspectorOpen = !s.inspectorOpen;
          const dockSection = inspectorOpen ? null : s.dockSection;
          return {
            inspectorOpen,
            dockSection,
            ...parkChrome(s, { inspectorOpen, dockSection }),
          };
        }),
      setProcessMonitorOpen: (open: boolean) =>
        set((state) => ({
          processMonitorOpen: open,
          ...parkChrome(state, { processMonitorOpen: open }),
        })),
      setQueuePanelOpen: (open: boolean) =>
        set((state) => ({
          queuePanelOpen: open,
          ...parkChrome(state, { queuePanelOpen: open }),
        })),
      setCronJobsOpen: (open: boolean) =>
        set((state) => ({
          cronJobsOpen: open,
          ...parkChrome(state, { cronJobsOpen: open }),
        })),
      setInspectSession: (id: string) =>
        set((state) => ({
          inspectSessionId: id,
          currentView: 'session-inspect' as View,
          ...parkChrome(state, { inspectSessionId: id, currentView: 'session-inspect' as View }),
        })),
      clearInspectSession: () =>
        set((state) => ({
          inspectSessionId: null,
          currentView: 'chat',
          ...parkChrome(state, { inspectSessionId: null, currentView: 'chat' }),
        })),
      setTerminalOpen: (open: boolean) =>
        set((state) => ({
          terminalOpen: open,
          ...parkChrome(state, { terminalOpen: open }),
        })),
      toggleTerminal: () =>
        set((s) => {
          const terminalOpen = !s.terminalOpen;
          return { terminalOpen, ...parkChrome(s, { terminalOpen }) };
        }),
      requestTerminalCreate: () => set((s) => ({ terminalCreateNonce: s.terminalCreateNonce + 1 })),
      setSettingsActiveTab: (tab: string) => set({ settingsActiveTab: coerceSettingsTab(tab) }),
      setScrollPosition: (view: string, scrollTop: number) =>
        set((state) => {
          const scrollPositions = { ...state.scrollPositions, [view]: scrollTop };
          return { scrollPositions, ...parkChrome(state, { scrollPositions }) };
        }),
      setDraftInput: (text: string) =>
        set((state) => ({
          draftInput: text,
          ...parkChrome(state, { draftInput: text }),
        })),
      setDraftImages: (images) =>
        // Trust boundary: data URLs are heavy — enforce the same per-message
        // cap the composer enforces so no caller can bloat memory.
        set((state) => {
          const draftImages = images.slice(-MAX_ATTACHED_IMAGES);
          return { draftImages, ...parkChrome(state, { draftImages }) };
        }),
      setSideContextBreakdownOpen: (open: boolean) =>
        set((state) => ({
          sideContextBreakdownOpen: open,
          ...parkChrome(state, { sideContextBreakdownOpen: open }),
        })),
      setChatSwitcherOpen: (chatSwitcherOpen) =>
        set((state) => ({
          chatSwitcherOpen,
          ...parkChrome(state, { chatSwitcherOpen }),
        })),
      setChatCheckpointOpen: (chatCheckpointOpen) =>
        set((state) => ({
          chatCheckpointOpen,
          ...parkChrome(state, { chatCheckpointOpen }),
        })),
      setChatMemoryPanelOpen: (chatMemoryPanelOpen) =>
        set((state) => ({
          chatMemoryPanelOpen,
          ...parkChrome(state, { chatMemoryPanelOpen }),
        })),
      setChatContextBreakdownOpen: (chatContextBreakdownOpen) =>
        set((state) => ({
          chatContextBreakdownOpen,
          ...parkChrome(state, { chatContextBreakdownOpen }),
        })),
      setChatToolStatsOpen: (chatToolStatsOpen) =>
        set((state) => ({
          chatToolStatsOpen,
          ...parkChrome(state, { chatToolStatsOpen }),
        })),
      setChatContextEditorOpen: (chatContextEditorOpen) =>
        set((state) => ({
          chatContextEditorOpen,
          ...parkChrome(state, { chatContextEditorOpen }),
        })),
      setChatInputCollapsed: (chatInputCollapsed) =>
        set((state) => ({
          chatInputCollapsed,
          ...parkChrome(state, { chatInputCollapsed }),
        })),
      setSkillsState: (skillsState) =>
        set((state) => ({
          skillsState,
          ...parkChrome(state, { skillsState }),
        })),
      setSelectedMailMessage: (selectedMailMessage) =>
        set((state) => ({
          selectedMailMessage,
          ...parkChrome(state, { selectedMailMessage }),
        })),
    }),
    uiPersistOptions as never,
  ),
);

export function resetUiNavigationToHome(options: { sidebarOpen?: boolean | undefined } = {}): void {
  useUIStore.setState(homeNavigationStatePatch(options));
}
