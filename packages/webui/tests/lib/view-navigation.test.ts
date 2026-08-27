/**
 * Tests for src/lib/view-navigation.ts — view/panel navigation functions.
 * Depends on useUIStore for state management.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  pairedViewForActivity,
  shortcutLabelForActivity,
  showPanel,
  openPanel,
  openMainView,
  navigateToView,
  PANEL_VIEW_BY_ACTIVITY,
  VIEW_ACTIVITY,
  ACTIVITY_SHORTCUT_BY_KEY,
  ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY,
} from '../../src/lib/view-navigation';
import { useUIStore, SIDEBAR_DEFAULT_WIDTH } from '../../src/stores/ui-store';

// ── helpers ──────────────────────────────────────────────────────────

function resetStore() {
  useUIStore.setState({
    activeActivity: 'chat',
    sidebarOpen: false,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
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
    pinnedIds: [],
    compactMode: false,
    modelSwitcherOpen: false,
    favoriteSessionIds: [],
    sessionNicknames: {},
    fileExplorerWidth: 260,
    refineEnabled: false,
    dockSection: null,
    workDashboardTab: 'todos',
    dockCustomizeOpen: false,
    fleetMonitorOpen: false,
    agentsMonitorOpen: false,
    inspectorOpen: false,
    inspectorTab: 'fleet',
    processMonitorOpen: false,
    queuePanelOpen: false,
    terminalOpen: false,
    terminalCreateNonce: 0,
    selectedMailMessage: null,
    skillsState: {
      skills: [],
      installed: [],
      editingId: null,
      editCode: '',
      createOpen: false,
      detailSkill: null,
      detailTab: 'readme',
    },
  });
}

describe('constants', () => {
  it('PANEL_VIEW_BY_ACTIVITY maps all activities', () => {
    expect(Object.keys(PANEL_VIEW_BY_ACTIVITY)).toHaveLength(7);
    expect(PANEL_VIEW_BY_ACTIVITY.chat).toBe('chat');
    expect(PANEL_VIEW_BY_ACTIVITY.agents).toBe('chat');
    expect(PANEL_VIEW_BY_ACTIVITY.files).toBe('files');
    expect(PANEL_VIEW_BY_ACTIVITY.changes).toBe('changes');
    expect(PANEL_VIEW_BY_ACTIVITY.mailbox).toBe('mailbox');
    expect(PANEL_VIEW_BY_ACTIVITY.skills).toBe('skill');
    expect(PANEL_VIEW_BY_ACTIVITY.design).toBe('design-gallery');
  });

  it('VIEW_ACTIVITY maps views to activities', () => {
    expect(VIEW_ACTIVITY.chat).toBe('chat');
    expect(VIEW_ACTIVITY.files).toBe('files');
    expect(VIEW_ACTIVITY.changes).toBe('changes');
    expect(VIEW_ACTIVITY.mailbox).toBe('mailbox');
    expect(VIEW_ACTIVITY.skill).toBe('skills');
    expect(VIEW_ACTIVITY['design-gallery']).toBe('design');
  });

  it('ACTIVITY_SHORTCUT_BY_KEY has all key bindings', () => {
    expect(ACTIVITY_SHORTCUT_BY_KEY['1']).toBe('chat');
    expect(ACTIVITY_SHORTCUT_BY_KEY['2']).toBe('files');
    expect(ACTIVITY_SHORTCUT_BY_KEY['0']).toBe('design');
    expect(Object.keys(ACTIVITY_SHORTCUT_BY_KEY)).toHaveLength(6);
  });

  it('ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY has all labels', () => {
    expect(ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY.chat).toBe('Ctrl+1');
    expect(ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY.design).toBe('Ctrl+0');
    expect(Object.keys(ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY)).toHaveLength(7);
  });
});

describe('pairedViewForActivity', () => {
  it('returns the paired view for a known activity', () => {
    expect(pairedViewForActivity('mailbox')).toBe('mailbox');
  });

  it('returns chat as default for unknown activity', () => {
    expect(pairedViewForActivity('unknown' as any)).toBe('chat');
  });
});

describe('shortcutLabelForActivity', () => {
  it('returns the shortcut label for a known activity', () => {
    expect(shortcutLabelForActivity('chat')).toBe('Ctrl+1');
  });

  it('returns empty string for unknown activity', () => {
    expect(shortcutLabelForActivity('unknown' as any)).toBe('');
  });
});

describe('showPanel', () => {
  beforeEach(() => {
    resetStore();
  });

  it('opens sidebar and selects activity, sets view', () => {
    showPanel('files');
    const state = useUIStore.getState();
    expect(state.sidebarOpen).toBe(true);
    expect(state.activeActivity).toBe('files');
    expect(state.currentView).toBe('files');
  });

  it('navigates to chat for agents activity', () => {
    showPanel('agents');
    const state = useUIStore.getState();
    // agents activity → paired view is chat
    expect(state.currentView).toBe('chat');
  });
});

describe('openPanel', () => {
  beforeEach(() => {
    resetStore();
  });

  it('opens sidebar when closed and selects activity', () => {
    openPanel('files');
    const state = useUIStore.getState();
    expect(state.sidebarOpen).toBe(true);
    expect(state.activeActivity).toBe('files');
    expect(state.currentView).toBe('files');
  });

  it('closes sidebar when same activity is already active', () => {
    // Set sidebar open with a known activity
    useUIStore.setState({ sidebarOpen: true, activeActivity: 'files', currentView: 'files' });
    openPanel('files');
    expect(useUIStore.getState().sidebarOpen).toBe(false);
  });

  it('switches activity when sidebar is open with different activity', () => {
    useUIStore.setState({ sidebarOpen: true, activeActivity: 'files', currentView: 'files' });
    openPanel('mailbox');
    const state = useUIStore.getState();
    expect(state.sidebarOpen).toBe(true);
    expect(state.activeActivity).toBe('mailbox');
    expect(state.currentView).toBe('mailbox');
  });
});

describe('openMainView', () => {
  beforeEach(() => {
    resetStore();
  });

  it('switches to the requested main view', () => {
    openMainView('settings');
    const state = useUIStore.getState();
    expect(state.currentView).toBe('settings');
    expect(state.sidebarOpen).toBe(false);
  });

  it('shows chat panel when already on the requested view', () => {
    useUIStore.setState({ currentView: 'goal', sidebarOpen: false });
    openMainView('goal');
    const state = useUIStore.getState();
    // Toggle: already on this view → show chat panel
    expect(state.sidebarOpen).toBe(true);
    expect(state.activeActivity).toBe('chat');
    expect(state.currentView).toBe('chat');
  });
});

describe('navigateToView', () => {
  beforeEach(() => {
    resetStore();
  });

  it('shows panel with paired activity for a panel view', () => {
    navigateToView('changes');
    const state = useUIStore.getState();
    expect(state.sidebarOpen).toBe(true);
    expect(state.activeActivity).toBe('changes');
    expect(state.currentView).toBe('changes');
  });

  it('sets sidebarClosed view for non-panel views', () => {
    navigateToView('setup');
    const state = useUIStore.getState();
    expect(state.sidebarOpen).toBe(false);
    expect(state.currentView).toBe('setup');
  });

  it('handles analytics view (no activity mapping)', () => {
    navigateToView('analytics');
    const state = useUIStore.getState();
    expect(state.sidebarOpen).toBe(false);
    expect(state.currentView).toBe('analytics');
  });
});
