import { beforeEach, describe, expect, it } from 'vitest';
import { useUIStore } from '../../src/stores/ui-store';

/**
 * The dock/inspector surface and the persist `migrate`/`merge` hooks. The
 * dock and the inspector are mutually exclusive — opening one has to close
 * the other — and the persist hooks have to survive a hand-edited
 * localStorage entry.
 */

const options = useUIStore.persist.getOptions();

function ui() {
  return useUIStore.getState();
}

beforeEach(() => {
  useUIStore.setState({
    dockSection: null,
    chromeSessionId: null,
    chromeBySession: {},
    hiddenChips: [],
    dockCustomizeOpen: false,
    inspectorOpen: false,
    inspectorTab: 'fleet',
    inspectorFocusedAgentId: null,
    fleetMonitorOpen: false,
    agentsMonitorOpen: false,
    terminalOpen: false,
    terminalCreateNonce: 0,
    scrollPositions: {},
    draftInput: '',
    promptLibraryOpen: false,
    promptInsertRequest: null,
    refineEnabled: false,
    fileExplorerWidth: 240,
  });
});

describe('dock sections', () => {
  it('opening a section closes the inspector', () => {
    ui().setInspectorOpen(true);
    ui().setDockSection('fleet');

    expect(ui()).toMatchObject({ dockSection: 'fleet', inspectorOpen: false });
  });

  it('closing the dock leaves the inspector alone', () => {
    useUIStore.setState({ inspectorOpen: true, dockSection: 'fleet' });
    ui().setDockSection(null);

    expect(ui()).toMatchObject({ dockSection: null, inspectorOpen: true });
  });

  it('toggling the open section closes it', () => {
    ui().setDockSection('fleet');
    ui().toggleDockSection('fleet');
    expect(ui().dockSection).toBeNull();
  });

  it('toggling a different section switches to it and closes the inspector', () => {
    useUIStore.setState({ dockSection: 'fleet', inspectorOpen: true });
    ui().toggleDockSection('work');

    expect(ui()).toMatchObject({ dockSection: 'work', inspectorOpen: false });
  });

  it('setWorkDashboardTab writes straight through', () => {
    ui().setWorkDashboardTab('tasks');
    expect(ui().workDashboardTab).toBe('tasks');
  });

  it('parks dock and work tabs per session when the foreground tab changes', () => {
    ui().bindSessionChrome('session-a');
    ui().setSidebarOpen(false);
    ui().selectActivity('agents');
    ui().setCurrentView('roster');
    ui().setAgentRosterActiveTab('officemap');
    ui().setChangesPanelTab('worktrees');
    ui().setDockSection('fleet');
    ui().setWorkDashboardTab('plan');
    ui().setDockCustomizeOpen(true);
    ui().setScrollPosition('roster', 111);

    ui().bindSessionChrome('session-b');
    expect(ui()).toMatchObject({
      chromeSessionId: 'session-b',
      sidebarOpen: true,
      activeActivity: 'chat',
      currentView: 'chat',
      dockSection: null,
      workDashboardTab: 'todos',
      dockCustomizeOpen: false,
      scrollPositions: {},
      agentRosterActiveTab: 'live',
      changesPanelTab: 'changes',
    });

    ui().setSidebarOpen(true);
    ui().selectActivity('changes');
    ui().setCurrentView('files');
    ui().setDockSection('work');
    ui().setWorkDashboardTab('tasks');
    ui().setScrollPosition('files', 222);
    ui().bindSessionChrome('session-a');
    expect(ui()).toMatchObject({
      chromeSessionId: 'session-a',
      sidebarOpen: false,
      activeActivity: 'agents',
      currentView: 'roster',
      dockSection: 'fleet',
      workDashboardTab: 'plan',
      dockCustomizeOpen: true,
      scrollPositions: { roster: 111 },
      agentRosterActiveTab: 'officemap',
      changesPanelTab: 'worktrees',
    });

    ui().bindSessionChrome('session-b');
    expect(ui()).toMatchObject({
      chromeSessionId: 'session-b',
      sidebarOpen: true,
      activeActivity: 'changes',
      currentView: 'files',
      dockSection: 'work',
      workDashboardTab: 'tasks',
      dockCustomizeOpen: false,
      scrollPositions: { files: 222 },
    });
  });

  it('parks inspector and session inspection per session', () => {
    ui().bindSessionChrome('session-a');
    ui().openInspectorTarget({ kind: 'agent', agentId: 'agent-a' });
    ui().setInspectSession('inspect-a');

    ui().bindSessionChrome('session-b');
    expect(ui()).toMatchObject({
      chromeSessionId: 'session-b',
      currentView: 'chat',
      inspectSessionId: null,
      inspectorOpen: false,
      inspectorTab: 'fleet',
      inspectorTarget: null,
      inspectorFocusedAgentId: null,
    });

    ui().bindSessionChrome('session-a');
    expect(ui()).toMatchObject({
      chromeSessionId: 'session-a',
      currentView: 'session-inspect',
      inspectSessionId: 'inspect-a',
      inspectorOpen: true,
      inspectorTab: 'agents',
      inspectorTarget: { kind: 'agent', agentId: 'agent-a' },
      inspectorFocusedAgentId: 'agent-a',
    });
  });

  it('parks transient visible panels and composer state per session', () => {
    ui().bindSessionChrome('session-a');
    ui().setSearchOpen(true);
    ui().setSearchQuery('from-a');
    ui().setModelSwitcherOpen(true);
    ui().setPromptLibraryOpen(true);
    ui().setProcessMonitorOpen(true);
    ui().setQueuePanelOpen(true);
    ui().setCronJobsOpen(true);
    ui().setSideContextBreakdownOpen(true);
    ui().setChatSwitcherOpen(true);
    ui().setChatCheckpointOpen(true);
    ui().setChatMemoryPanelOpen(true);
    ui().setChatContextBreakdownOpen(true);
    ui().setChatContextEditorOpen(true);
    ui().setChatInputCollapsed(true);
    ui().setTerminalOpen(true);
    ui().setDraftInput('draft-a');
    ui().setDraftImages([
      { id: 'img-a', dataUrl: 'data:image/png;base64,a', mediaType: 'image/png', bytes: 1 },
    ]);

    ui().bindSessionChrome('session-b');
    expect(ui()).toMatchObject({
      chromeSessionId: 'session-b',
      searchOpen: false,
      searchQuery: '',
      modelSwitcherOpen: false,
      promptLibraryOpen: false,
      processMonitorOpen: false,
      queuePanelOpen: false,
      cronJobsOpen: false,
      sideContextBreakdownOpen: false,
      chatSwitcherOpen: false,
      chatCheckpointOpen: false,
      chatMemoryPanelOpen: false,
      chatContextBreakdownOpen: false,
      chatContextEditorOpen: false,
      chatInputCollapsed: false,
      terminalOpen: false,
      draftInput: '',
      draftImages: [],
    });

    ui().setDraftInput('draft-b');
    ui().setQueuePanelOpen(true);
    ui().setChatMemoryPanelOpen(true);

    ui().bindSessionChrome('session-a');
    expect(ui()).toMatchObject({
      chromeSessionId: 'session-a',
      searchOpen: true,
      searchQuery: 'from-a',
      modelSwitcherOpen: true,
      promptLibraryOpen: true,
      processMonitorOpen: true,
      queuePanelOpen: true,
      cronJobsOpen: true,
      sideContextBreakdownOpen: true,
      chatSwitcherOpen: true,
      chatCheckpointOpen: true,
      chatMemoryPanelOpen: true,
      chatContextBreakdownOpen: true,
      chatContextEditorOpen: true,
      chatInputCollapsed: true,
      terminalOpen: true,
      draftInput: 'draft-a',
    });
    expect(ui().draftImages).toHaveLength(1);

    ui().bindSessionChrome('session-b');
    expect(ui()).toMatchObject({
      chromeSessionId: 'session-b',
      draftInput: 'draft-b',
      queuePanelOpen: true,
      chatMemoryPanelOpen: true,
      chatCheckpointOpen: false,
      searchOpen: false,
      promptLibraryOpen: false,
    });
  });

  it('parks subagent chat focus per session when callers omit the session id', () => {
    ui().bindSessionChrome('session-a');
    ui().setSubagentChatFocus('worker-a');
    expect(ui()).toMatchObject({
      subagentChatFocusId: 'worker-a',
      subagentChatFocusSessionId: 'session-a',
      subagentChatFocusBySession: { 'session-a': 'worker-a' },
    });

    ui().bindSessionChrome('session-b');
    expect(ui()).toMatchObject({
      subagentChatFocusId: null,
      subagentChatFocusSessionId: 'session-b',
    });

    ui().setSubagentChatFocus('worker-b');
    ui().bindSessionChrome('session-a');
    expect(ui()).toMatchObject({
      subagentChatFocusId: 'worker-a',
      subagentChatFocusSessionId: 'session-a',
    });

    ui().bindSessionChrome('session-b');
    expect(ui()).toMatchObject({
      subagentChatFocusId: 'worker-b',
      subagentChatFocusSessionId: 'session-b',
    });
  });

  it('parks mailbox detail and skills navigation per session', () => {
    ui().bindSessionChrome('session-a');
    ui().setSelectedMailMessage({ id: 'mail-a', subject: 'A' } as never);
    ui().setSkillsState({
      selectedSkill: {
        name: 'skill-a',
        description: 'A',
        version: '1',
        source: 'project',
        sourceUrl: '',
        ref: 'a',
        path: 'skills/a',
        trigger: 'a',
        scope: ['project'],
      },
      navHistory: [],
      historyIndex: 0,
      detailOpen: true,
      knownRefs: { 'skill-a': 'a' },
      updateAvailableCount: 1,
    });

    ui().bindSessionChrome('session-b');
    expect(ui().selectedMailMessage).toBeNull();
    expect(ui().skillsState).toMatchObject({
      selectedSkill: null,
      navHistory: [],
      historyIndex: -1,
      detailOpen: false,
      knownRefs: {},
      updateAvailableCount: 0,
    });

    ui().setSelectedMailMessage({ id: 'mail-b', subject: 'B' } as never);
    ui().setSkillsState({
      selectedSkill: null,
      navHistory: [
        {
          name: 'skill-b',
          description: 'B',
          version: '1',
          source: 'user',
          sourceUrl: '',
          ref: 'b',
          path: 'skills/b',
          trigger: 'b',
          scope: ['user'],
        },
      ],
      historyIndex: 0,
      detailOpen: false,
      knownRefs: { 'skill-b': 'b' },
      updateAvailableCount: 0,
    });

    ui().bindSessionChrome('session-a');
    expect(ui().selectedMailMessage).toMatchObject({ id: 'mail-a' });
    expect(ui().skillsState.selectedSkill).toMatchObject({ name: 'skill-a' });
    expect(ui().skillsState.knownRefs).toEqual({ 'skill-a': 'a' });

    ui().bindSessionChrome('session-b');
    expect(ui().selectedMailMessage).toMatchObject({ id: 'mail-b' });
    expect(ui().skillsState.selectedSkill).toBeNull();
    expect(ui().skillsState.navHistory[0]).toMatchObject({ name: 'skill-b' });
  });
});

describe('dock chips', () => {
  it('hiding a chip adds it to the hidden list', () => {
    ui().toggleChipHidden('fleet');
    expect(ui().hiddenChips).toContain('fleet');
  });

  it('hiding the open section also collapses the dock', () => {
    ui().setDockSection('fleet');
    ui().toggleChipHidden('fleet');
    expect(ui().dockSection).toBeNull();
  });

  it('hiding a different section leaves the dock open', () => {
    ui().setDockSection('work');
    ui().toggleChipHidden('fleet');
    expect(ui().dockSection).toBe('work');
  });

  it('toggling a hidden chip restores it without touching the dock', () => {
    useUIStore.setState({ hiddenChips: ['fleet'], dockSection: 'fleet' });
    ui().toggleChipHidden('fleet');

    expect(ui().hiddenChips).not.toContain('fleet');
    expect(ui().dockSection).toBe('fleet');
  });

  it('showDockChip un-hides without toggling', () => {
    useUIStore.setState({ hiddenChips: ['fleet', 'work'] });
    ui().showDockChip('fleet');
    expect(ui().hiddenChips).toEqual(['work']);
  });

  it('showDockChip is a no-op for a visible chip', () => {
    ui().showDockChip('fleet');
    expect(ui().hiddenChips).toEqual([]);
  });

  it('setDockCustomizeOpen writes straight through', () => {
    ui().setDockCustomizeOpen(true);
    expect(ui().dockCustomizeOpen).toBe(true);
  });
});

describe('inspector compatibility shims', () => {
  it('setFleetMonitorOpen opens the inspector on the fleet tab', () => {
    ui().setDockSection('fleet');
    ui().setFleetMonitorOpen(true);

    expect(ui()).toMatchObject({
      // The legacy boolean stays false so no second overlay can mount.
      fleetMonitorOpen: false,
      inspectorOpen: true,
      inspectorTab: 'fleet',
      dockSection: null,
    });
  });

  it('setFleetMonitorOpen(false) closes the inspector only when fleet is showing', () => {
    useUIStore.setState({ inspectorOpen: true, inspectorTab: 'fleet' });
    ui().setFleetMonitorOpen(false);
    expect(ui().inspectorOpen).toBe(false);
  });

  it('setFleetMonitorOpen(false) leaves another tab open', () => {
    useUIStore.setState({ inspectorOpen: true, inspectorTab: 'agents' });
    ui().setFleetMonitorOpen(false);
    expect(ui().inspectorOpen).toBe(true);
  });

  it('setAgentsMonitorOpen opens the inspector on the agents tab', () => {
    ui().setDockSection('fleet');
    ui().setAgentsMonitorOpen(true);

    expect(ui()).toMatchObject({
      agentsMonitorOpen: false,
      inspectorOpen: true,
      inspectorTab: 'agents',
      dockSection: null,
    });
  });

  it('setAgentsMonitorOpen(false) closes the inspector only when agents is showing', () => {
    useUIStore.setState({ inspectorOpen: true, inspectorTab: 'agents' });
    ui().setAgentsMonitorOpen(false);
    expect(ui().inspectorOpen).toBe(false);
  });

  it('setAgentsMonitorOpen(false) leaves another tab open', () => {
    useUIStore.setState({ inspectorOpen: true, inspectorTab: 'fleet' });
    ui().setAgentsMonitorOpen(false);
    expect(ui().inspectorOpen).toBe(true);
  });
});

describe('inspector', () => {
  it('opening it collapses the dock', () => {
    ui().setDockSection('fleet');
    ui().setInspectorOpen(true);
    expect(ui()).toMatchObject({ inspectorOpen: true, dockSection: null });
  });

  it('closing it leaves the dock alone', () => {
    useUIStore.setState({ dockSection: 'fleet', inspectorOpen: true });
    ui().setInspectorOpen(false);
    expect(ui().dockSection).toBe('fleet');
  });

  it('toggling it open collapses the dock', () => {
    useUIStore.setState({ dockSection: 'fleet' });
    ui().toggleInspector();
    expect(ui()).toMatchObject({ inspectorOpen: true, dockSection: null });
  });

  it('toggling it closed leaves the dock alone', () => {
    useUIStore.setState({ inspectorOpen: true, dockSection: 'fleet' });
    ui().toggleInspector();
    expect(ui()).toMatchObject({ inspectorOpen: false, dockSection: 'fleet' });
  });

  it('setInspectorTab and setInspectorFocusedAgentId write straight through', () => {
    ui().setInspectorTab('sideEffects');
    ui().setInspectorFocusedAgentId('sa1');
    expect(ui()).toMatchObject({ inspectorTab: 'sideEffects', inspectorFocusedAgentId: 'sa1' });
  });
});

describe('panel toggles', () => {
  it.each([
    ['setProcessMonitorOpen', 'processMonitorOpen'],
    ['setQueuePanelOpen', 'queuePanelOpen'],
    ['setCronJobsOpen', 'cronJobsOpen'],
    ['setTerminalOpen', 'terminalOpen'],
    ['setSideContextBreakdownOpen', 'sideContextBreakdownOpen'],
    ['setChatSwitcherOpen', 'chatSwitcherOpen'],
    ['setChatCheckpointOpen', 'chatCheckpointOpen'],
    ['setChatMemoryPanelOpen', 'chatMemoryPanelOpen'],
    ['setChatContextBreakdownOpen', 'chatContextBreakdownOpen'],
    ['setChatContextEditorOpen', 'chatContextEditorOpen'],
    ['setChatInputCollapsed', 'chatInputCollapsed'],
  ] as const)('%s writes %s', (setter, key) => {
    (ui()[setter] as (open: boolean) => void)(true);
    expect(ui()[key]).toBe(true);
  });

  it('toggleTerminal flips the flag', () => {
    ui().toggleTerminal();
    expect(ui().terminalOpen).toBe(true);
    ui().toggleTerminal();
    expect(ui().terminalOpen).toBe(false);
  });

  it('requestTerminalCreate bumps a nonce rather than a boolean', () => {
    ui().requestTerminalCreate();
    ui().requestTerminalCreate();
    // A boolean would coalesce two rapid requests into one terminal.
    expect(ui().terminalCreateNonce).toBe(2);
  });
});

describe('prompt library', () => {
  it('requesting an insert closes the library', () => {
    ui().setPromptLibraryOpen(true);
    ui().requestPromptInsert('/review');

    expect(ui()).toMatchObject({ promptInsertRequest: '/review', promptLibraryOpen: false });
  });

  it('clearing the request leaves the library closed', () => {
    ui().requestPromptInsert('/review');
    ui().clearPromptInsert();
    expect(ui().promptInsertRequest).toBeNull();
  });
});

describe('misc setters', () => {
  it('clamps the file explorer width to its bounds', () => {
    ui().setFileExplorerWidth(10);
    expect(ui().fileExplorerWidth).toBe(160);
    ui().setFileExplorerWidth(9_999);
    expect(ui().fileExplorerWidth).toBe(400);
    ui().setFileExplorerWidth(250.6);
    expect(ui().fileExplorerWidth).toBe(251);
  });

  it('toggleRefineEnabled flips the flag', () => {
    ui().toggleRefineEnabled();
    expect(ui().refineEnabled).toBe(true);
  });

  it('setRefinePanel writes straight through', () => {
    ui().setRefinePanel({ original: '', refined: '', english: '', resolve: () => {} });
    expect(ui().refinePanel).not.toBeNull();
  });

  it('setScrollPosition keeps a position per view', () => {
    ui().setScrollPosition('chat', 120);
    ui().setScrollPosition('skills', 40);
    expect(ui().scrollPositions).toEqual({ chat: 120, skills: 40 });
  });

  it('setDraftInput, setSkillsState and setSelectedMailMessage write through', () => {
    ui().setDraftInput('hello');
    ui().setSkillsState({ view: 'list' } as never);
    ui().setSelectedMailMessage({ id: 'm1' } as never);

    expect(ui().draftInput).toBe('hello');
    expect(ui().skillsState).toMatchObject({ view: 'list' });
    expect(ui().selectedMailMessage).toMatchObject({ id: 'm1' });
  });

  it('coerces an unknown settings tab to a valid one', () => {
    ui().setSettingsActiveTab('not-a-tab');
    expect(typeof ui().settingsActiveTab).toBe('string');
    expect(ui().settingsActiveTab).not.toBe('not-a-tab');
  });
});

describe('persist migrate', () => {
  const migrate = options.migrate as unknown as (p: unknown, v: number) => Record<string, unknown>;

  it('survives a null persisted blob', () => {
    expect(() => migrate(null, 5)).not.toThrow();
  });

  it('coerces a removed activity onto chat', () => {
    expect(migrate({ activeActivity: 'sessions' }, 5).activeActivity).toBe('chat');
  });

  it('clamps a hand-edited sidebar width', () => {
    expect(migrate({ sidebarWidth: 5 }, 5).sidebarWidth).toBeGreaterThan(5);
    expect(migrate({ sidebarWidth: 99_999 }, 5).sidebarWidth).toBeLessThan(99_999);
  });

  it('leaves a non-numeric sidebar width for merge to handle', () => {
    expect(migrate({ sidebarWidth: 'wide' }, 5).sidebarWidth).toBe('wide');
  });

  it('drops the pre-v2 drawer booleans', () => {
    const out = migrate({ fleetDrawerOpen: true, agentsDrawerOpen: true }, 1);
    expect(out).not.toHaveProperty('fleetDrawerOpen');
    expect(out).not.toHaveProperty('agentsDrawerOpen');
  });

  it('keeps the drawer booleans out of a v2+ blob untouched', () => {
    // They can't be present at v2+, but the guard must not run regardless.
    const out = migrate({ fleetDrawerOpen: true }, 3);
    expect(out).toHaveProperty('fleetDrawerOpen');
  });

  it('coerces the v5 fields only when they are present', () => {
    const out = migrate({ currentView: 'nope', dockSection: 'nope', settingsActiveTab: 'nope' }, 4);
    expect(out.currentView).not.toBe('nope');
    expect(out.dockSection).not.toBe('nope');
    expect(out.settingsActiveTab).not.toBe('nope');
  });

  it('does not invent the v5 fields when they are absent', () => {
    const out = migrate({}, 4);
    expect(out).not.toHaveProperty('currentView');
    expect(out).not.toHaveProperty('dockSection');
  });

  it('drops persisted session chrome from v6 blobs', () => {
    const out = migrate(
      {
        chromeSessionId: 'old-session',
        chromeBySession: {
          'old-session': {
            currentView: 'roster',
            dockSection: 'work',
          },
        },
      },
      6,
    );

    expect(out).not.toHaveProperty('chromeSessionId');
    expect(out).not.toHaveProperty('chromeBySession');
  });
});

describe('persist merge', () => {
  const merge = options.merge as unknown as (p: unknown, c: unknown) => Record<string, unknown>;

  function current() {
    return { ...useUIStore.getState() };
  }

  it('coerces every persisted enum field', () => {
    const out = merge(
      {
        activeActivity: 'projects',
        currentView: 'nope',
        dockSection: 'nope',
        settingsActiveTab: 'nope',
        sidebarWidth: 10_000,
      },
      current(),
    );

    expect(out.activeActivity).toBe('chat');
    expect(out.currentView).not.toBe('nope');
    expect(out.dockSection).not.toBe('nope');
    expect(out.sidebarWidth).toBeLessThan(10_000);
  });

  it('survives a null persisted blob', () => {
    expect(() => merge(null, current())).not.toThrow();
  });

  it('forces the desktop shell back to home on rehydrate', () => {
    (window as unknown as { wrongstackDesktopHost?: unknown }).wrongstackDesktopHost = {};
    try {
      const out = merge({ currentView: 'settings', sidebarOpen: true }, current());
      expect(out).toMatchObject({ currentView: 'chat', activeActivity: 'chat' });
    } finally {
      delete (window as unknown as { wrongstackDesktopHost?: unknown }).wrongstackDesktopHost;
    }
  });

  it('detects the desktop shell from the query string too', () => {
    history.pushState(null, '', '/?shell=desktop');
    try {
      const out = merge({ currentView: 'settings' }, current());
      expect(out.currentView).toBe('chat');
    } finally {
      history.pushState(null, '', '/');
    }
  });

  it('leaves a browser session on the persisted view', () => {
    history.pushState(null, '', '/');
    const out = merge({ currentView: 'settings' }, current());
    expect(out.currentView).toBe('settings');
  });
});
