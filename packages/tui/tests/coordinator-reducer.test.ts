import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app.js';
import type { State } from '../src/app-state.js';

function minimalCoordinatorState(over: Partial<State['coordinator']> = {}): State['coordinator'] {
  return {
    goals: [],
    timeline: [],
    knowledgeCount: 0,
    monitorOpen: false,
    healthy: false,
    ...over,
  };
}

function minimalState(coordinator: State['coordinator'] = minimalCoordinatorState()): State {
  return {
    viewportRows: 0,
    historyScrolled: false,
    lines: [],
    input: { value: '', cursor: 0 },
    toolbar: { active: 'chat', draft: null },
    mode: 'chat',
    leftSidebarOpen: false,
    fileExplorerWidth: 30,
    rightSidebarOpen: false,
    settingsPicker: {
      open: false,
      field: 0,
      mode: 'off' as const,
      delayMs: 0,
      titleAnimation: false,
      yolo: false,
      fleetChat: 'off',
      chime: false,
      confirmExit: false,
      nextPrediction: false,
      featureMcp: false,
      featurePlugins: false,
      featureMemory: false,
      featureSkills: false,
      featureModelsRegistry: false,
      tokenSavingTier: 'off' as const,
      allowOutsideProjectRoot: true,
      contextAutoCompact: true,
      contextStrategy: 'hybrid' as const,
      contextMode: 'balanced' as const,
      maxConcurrent: 4,
      logLevel: 'info' as const,
      auditLevel: 'standard' as const,
      indexOnStart: false,
      multiDiffSummaryThreshold: 0,
      maxIterations: 100,
      autoProceedMaxIterations: 0,
      enhanceDelayMs: 4000,
      enhanceEnabled: true,
      enhanceLanguage: 'original' as const,
      debugStream: false,
      statuslineMode: 'detailed' as const,
      reasoningMode: 'auto' as const,
      reasoningEffort: 'medium' as const,
      reasoningPreserve: false,
      thinkingWord: 'Thinking',
      thinkingWordEditing: false,
      thinkingWordDraft: '',
      cacheTtl: 'default' as const,
      configScope: 'global' as const,
      filter: '',
      lastSettingsField: 0,
    },
    paletteOpen: false,
    shortcutsOpen: false,
    searchOpen: false,
    searchQuery: '',
    currentView: 'chat' as const,
    themeName: 'dark' as const,
    currentSessionId: null,
    sessions: [],
    sessionMeta: {},
    messages: [],
    transpose: null,
    context: { agency: null, task: null, toolCallId: null, run: null },
    showConfirm: null,
    abortedToolCallIds: new Set(),
    approvals: new Map(),
    approvalsVersion: 0,
    scrollToMessage: null,
    pendingUploads: new Map(),
    modelSwitcherOpen: false,
    modelSwitcherData: null,
    assistantThinking: null,
    toolLoading: null,
    visibleAgents: new Set(['leader']),
    favoriteSessions: new Set(),
    sessionNicknames: {},
    fileExplorer: { 船上的人员: null },
    fileTree: { 船上的人员: null },
    terminalIdCounter: 0,
    terminals: {},
    compactMode: false,
    pinnedItems: { 船上的人员: null },
    fleetChat: 'off',
    monitorOpen: false,
    agentsMonitorOpen: false,
    helpOpen: false,
    todosMonitorOpen: false,
    queuePanelOpen: false,
    processListOpen: false,
    goalPanelOpen: false,
    sessionsPanelOpen: false,
    sessionsPanel: { sessions: [], busy: false, selected: -1 },
    sessionResumeConfirm: null,
    collabSession: null,
    checkpoints: [],
    rewindOverlay: null,
    eternalStage: null,
    goalSummary: null,
    goalRun: null,
    worktrees: {},
    worktreeMonitorOpen: false,
    coordinator,
    skipInterrupt: false,
    countdown: null,
    interruptMenu: null,
    run: null,
    trace: null,
  } as unknown as State;
}

describe('TUI reducer — coordinatorEvent', () => {
  it('adds goal:added event to timeline with 🎯 icon', () => {
    const state = minimalState();
    const out = reducer(state, {
      type: 'coordinatorEvent',
      event: { type: 'goal:added', text: 'Test goal' },
    });
    expect(out.coordinator.timeline).toHaveLength(1);
    expect(out.coordinator.timeline[0]!.icon).toBe('🎯');
    expect(out.coordinator.timeline[0]!.text).toBe('Test goal');
    expect(out.coordinator.timeline[0]!.kind).toBe('goal');
    expect(out.coordinator.healthy).toBe(true);
  });

  it('adds goal:completed event to timeline with ✅ icon', () => {
    const state = minimalState();
    const out = reducer(state, {
      type: 'coordinatorEvent',
      event: { type: 'goal:completed', text: 'Goal done' },
    });
    expect(out.coordinator.timeline[0]!.icon).toBe('✅');
    expect(out.coordinator.timeline[0]!.kind).toBe('goal');
  });

  it('adds goal:failed event to timeline with ❌ icon', () => {
    const state = minimalState();
    const out = reducer(state, {
      type: 'coordinatorEvent',
      event: { type: 'goal:failed', text: 'Goal failed' },
    });
    expect(out.coordinator.timeline[0]!.icon).toBe('❌');
    expect(out.coordinator.timeline[0]!.kind).toBe('goal');
  });

  it('adds task:ready event to timeline with ⚡ icon', () => {
    const state = minimalState();
    const out = reducer(state, {
      type: 'coordinatorEvent',
      event: { type: 'task:ready', text: 'Task ready' },
    });
    expect(out.coordinator.timeline[0]!.icon).toBe('⚡');
    expect(out.coordinator.timeline[0]!.kind).toBe('task');
  });

  it('adds task:completed event to timeline with ✓ icon', () => {
    const state = minimalState();
    const out = reducer(state, {
      type: 'coordinatorEvent',
      event: { type: 'task:completed', text: 'Task done' },
    });
    expect(out.coordinator.timeline[0]!.icon).toBe('✓');
    expect(out.coordinator.timeline[0]!.kind).toBe('task');
  });

  it('adds knowledge:added event with 💡 icon and increments knowledgeCount', () => {
    const state = minimalState(minimalCoordinatorState({ knowledgeCount: 5 }));
    const out = reducer(state, {
      type: 'coordinatorEvent',
      event: { type: 'knowledge:added', text: 'New fact' },
    });
    expect(out.coordinator.timeline[0]!.icon).toBe('💡');
    expect(out.coordinator.timeline[0]!.kind).toBe('knowledge');
    expect(out.coordinator.knowledgeCount).toBe(6);
  });

  it('adds consensus:reached event with 🤝 icon', () => {
    const state = minimalState();
    const out = reducer(state, {
      type: 'coordinatorEvent',
      event: { type: 'consensus:reached', text: 'Approved' },
    });
    expect(out.coordinator.timeline[0]!.icon).toBe('🤝');
    expect(out.coordinator.timeline[0]!.kind).toBe('consensus');
  });

  it('adds deadlock:detected event with ⚠️ icon', () => {
    const state = minimalState();
    const out = reducer(state, {
      type: 'coordinatorEvent',
      event: { type: 'deadlock:detected', text: 'Deadlock' },
    });
    expect(out.coordinator.timeline[0]!.icon).toBe('⚠️');
    expect(out.coordinator.timeline[0]!.kind).toBe('deadlock');
  });

  it('prepends new events (newest first)', () => {
    const state = minimalState(
      minimalCoordinatorState({
        timeline: [{ at: Date.now() - 1000, icon: '🎯', kind: 'goal', text: 'First' }],
      }),
    );
    const out = reducer(state, {
      type: 'coordinatorEvent',
      event: { type: 'goal:added', text: 'Second' },
    });
    expect(out.coordinator.timeline).toHaveLength(2);
    expect(out.coordinator.timeline[0]!.text).toBe('Second');
    expect(out.coordinator.timeline[1]!.text).toBe('First');
  });

  it('caps timeline at 50 entries', () => {
    // Pre-fill 50 entries
    const timeline = Array.from({ length: 50 }, (_, i) => ({
      at: Date.now() - i * 100,
      icon: '•',
      kind: 'goal' as const,
      text: `Entry ${i}`,
    }));
    const state = minimalState(minimalCoordinatorState({ timeline }));
    const out = reducer(state, {
      type: 'coordinatorEvent',
      event: { type: 'goal:added', text: 'New entry' },
    });
    expect(out.coordinator.timeline).toHaveLength(50);
    expect(out.coordinator.timeline[0]!.text).toBe('New entry');
    expect(out.coordinator.timeline[49]!.text).toBe('Entry 48'); // Entry 49 was pushed out
  });

  it('falls back to event.type as text when text is missing', () => {
    const state = minimalState();
    const out = reducer(state, {
      type: 'coordinatorEvent',
      event: { type: 'goal:added' } as Parameters<typeof reducer>[1] extends { event: infer Event }
        ? Event
        : never,
    });
    expect(out.coordinator.timeline[0]!.text).toBe('goal:added');
  });
});
