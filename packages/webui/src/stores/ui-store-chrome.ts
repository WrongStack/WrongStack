import type { UIState, SessionChromeState } from "./ui-store-types.js";

export function isDesktopShellStorageContext(): boolean {
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

export function homeNavigationStatePatch(
  options: { sidebarOpen?: boolean | undefined } = {},
): Partial<UIState> {
  return {
    currentView: 'chat',
    activeActivity: 'chat',
    sidebarOpen: options.sidebarOpen ?? false,
    dockSection: null,
    chromeSessionId: null,
    chromeBySession: {},
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
    skillsState: defaultSkillsState(),
    chatSwitcherOpen: false,
    chatCheckpointOpen: false,
    chatMemoryPanelOpen: false,
    chatContextBreakdownOpen: false,
    chatContextEditorOpen: false,
    chatToolStatsOpen: false,
    chatInputCollapsed: false,
  };
}

export function defaultSkillsState(): UIState['skillsState'] {
  return {
    selectedSkill: null,
    navHistory: [],
    historyIndex: -1,
    detailOpen: false,
    knownRefs: {},
    updateAvailableCount: 0,
  };
}

export function defaultSessionChrome(): SessionChromeState {
  return {
    sidebarOpen: true,
    activeActivity: 'chat',
    currentView: 'chat',
    inspectSessionId: null,
    searchOpen: false,
    searchQuery: '',
    searchActiveMessageId: null,
    scrollTarget: null,
    modelSwitcherOpen: false,
    promptLibraryOpen: false,
    promptInsertRequest: null,
    refinePanel: null,
    draftInput: '',
    draftImages: [],
    processMonitorOpen: false,
    queuePanelOpen: false,
    cronJobsOpen: false,
    sideContextBreakdownOpen: false,
    terminalOpen: false,
    dockSection: null,
    workDashboardTab: 'todos',
    inspectorOpen: false,
    inspectorTab: 'fleet',
    inspectorTarget: null,
    inspectorFocusedAgentId: null,
    agentRosterActiveTab: 'live',
    changesPanelTab: 'changes',
    dockCustomizeOpen: false,
    skillsState: defaultSkillsState(),
    selectedMailMessage: null,
    scrollPositions: {},
    chatSwitcherOpen: false,
    chatCheckpointOpen: false,
    chatMemoryPanelOpen: false,
    chatContextBreakdownOpen: false,
    chatContextEditorOpen: false,
    chatToolStatsOpen: false,
    chatInputCollapsed: false,
  };
}

export function readSessionChrome(state: UIState): SessionChromeState {
  return {
    sidebarOpen: state.sidebarOpen,
    activeActivity: state.activeActivity,
    currentView: state.currentView,
    inspectSessionId: state.inspectSessionId,
    searchOpen: state.searchOpen,
    searchQuery: state.searchQuery,
    searchActiveMessageId: state.searchActiveMessageId,
    scrollTarget: state.scrollTarget,
    modelSwitcherOpen: state.modelSwitcherOpen,
    promptLibraryOpen: state.promptLibraryOpen,
    promptInsertRequest: state.promptInsertRequest,
    refinePanel: state.refinePanel,
    draftInput: state.draftInput,
    draftImages: state.draftImages,
    processMonitorOpen: state.processMonitorOpen,
    queuePanelOpen: state.queuePanelOpen,
    cronJobsOpen: state.cronJobsOpen,
    sideContextBreakdownOpen: state.sideContextBreakdownOpen,
    terminalOpen: state.terminalOpen,
    dockSection: state.dockSection,
    workDashboardTab: state.workDashboardTab,
    inspectorOpen: state.inspectorOpen,
    inspectorTab: state.inspectorTab,
    inspectorTarget: state.inspectorTarget,
    inspectorFocusedAgentId: state.inspectorFocusedAgentId,
    agentRosterActiveTab: state.agentRosterActiveTab,
    changesPanelTab: state.changesPanelTab,
    dockCustomizeOpen: state.dockCustomizeOpen,
    skillsState: state.skillsState,
    selectedMailMessage: state.selectedMailMessage,
    scrollPositions: state.scrollPositions,
    chatSwitcherOpen: state.chatSwitcherOpen,
    chatCheckpointOpen: state.chatCheckpointOpen,
    chatMemoryPanelOpen: state.chatMemoryPanelOpen,
    chatContextBreakdownOpen: state.chatContextBreakdownOpen,
    chatContextEditorOpen: state.chatContextEditorOpen,
    chatToolStatsOpen: state.chatToolStatsOpen,
    chatInputCollapsed: state.chatInputCollapsed,
  };
}

export function parkChrome(
  state: UIState,
  patch: Partial<SessionChromeState>,
): { chromeBySession?: UIState['chromeBySession'] } {
  if (!state.chromeSessionId) return {};
  return {
    chromeBySession: {
      ...state.chromeBySession,
      [state.chromeSessionId]: { ...readSessionChrome(state), ...patch },
    },
  };
}
