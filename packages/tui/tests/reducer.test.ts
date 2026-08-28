import { describe, expect, it } from 'vitest';
import {
  nextInputWordStart,
  previousInputWordStart,
  reducer,
  selectedSlashCommandLine,
} from '../src/app.js';
import type { State } from '../src/app-state.js';
import { SETTINGS_FIELD_COUNT } from '../src/components/settings-picker.js';
import { TUI_HISTORY_MAX_ENTRIES } from '../src/history-retention.js';

export function initial(over: Partial<State> = {}): State {
  const state = {
    entries: [],
    buffer: '',
    cursor: 0,
    streamingText: '',
    toolStream: null,
    status: 'idle' as const,
    interrupts: 0,
    steeringPending: false,
    steerSnapshot: null,
    hint: '',
    copiedNotice: '',
    copiedEntryId: null,
    brain: { state: 'idle' as const },
    brainPrompt: null,
    nextId: 1,
    historyGen: 0,
    picker: { open: false, query: '', matches: [], selected: 0 },
    slashPicker: { open: false, query: '', matches: [], selected: 0 },
    runningTools: new Map<string, { name: string; startedAt: number }>(),
    queue: [],
    nextQueueId: 1,
    inputHistory: [],
    historyIndex: 0,
    modelPicker: {
      open: false,
      step: 'provider' as const,
      providerOptions: [],
      modelOptions: [],
      filteredOptions: [],
      selected: 0,
      searchQuery: '',
    },
    confirm: null,
    enhance: null,
    enhanceEnabled: true,
    enhanceBusy: false,
    continueConfirm: null,
    sendModePicker: null,
    contextChipVersion: 0,
    fleet: {},
    fleetCost: 0,
    fleetTokens: { input: 0, output: 0 },
    fleetChat: 'off',
    monitorOpen: false,
    agentsMonitorOpen: false,
    helpOpen: false,
    todosMonitorOpen: false,
    queuePanelOpen: false,
    processListOpen: false,
    planPanelOpen: false,
    goalPanelOpen: false,
    sessionsPanelOpen: false,
    sessionsPanel: { sessions: [], busy: false, selected: -1 },
    sessionResumeConfirm: null,
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
      thinkingWord: 'thinking',
      thinkingWordEditing: false,
      thinkingWordDraft: '',
      cacheTtl: 'default' as const,
      configScope: 'global' as const,
      filter: '',
      lastSettingsField: 0,
    },
    statuslinePicker: { open: false, field: 0, hiddenItems: [], visibleChips: [] },
    projectPicker: { open: false, allItems: [], items: [], selected: 0, filter: '' },
    fKeyPicker: { open: false, selected: 0 },
    confirmQueue: [],
    shellCommandWarning: null,
    goalRun: null,
    sddBoard: null,
    worktreeMonitorOpen: false,
    coordinator: { goals: [], timeline: [], knowledgeCount: 0, monitorOpen: false, healthy: false },
    pluginPicker: { open: false, items: [], selected: 0, busy: false, hint: undefined },
    mcpPicker: { open: false, items: [], selected: 0, busy: false, hint: undefined },
    toolsPicker: {
      open: false,
      items: [],
      selected: 0,
      busy: false,
      hint: undefined,
      filter: undefined,
    },
    resumePicker: {
      open: false,
      sessions: [],
      selected: 0,
      busy: false,
      hint: undefined,
      error: undefined,
    },
    brainPanel: {
      open: false,
      log: [],
      settings: null,
      selected: 0,
      view: undefined,
      busy: false,
      hint: undefined,
    },
    authPanel: {
      open: false,
      view: 'list' as const,
      providers: [],
      presets: [],
      catalog: [],
      selected: 0,
      filter: '',
      busy: false,
      hint: '',
    },
    shadowPanel: {
      open: false,
      running: false,
      model: '',
      intervalMs: 5000,
      activeId: null,
      hint: undefined,
    },
    helpPanel: { open: false, entries: [], filter: '', selected: 0, hint: undefined },
    collabSession: null,
    exitConfirm: null,
    slashConfirm: null,
    escConfirm: null,
    clearConfirm: null,
    goalKanbanPanelOpen: false,
    goalKanbanBoard: null,
    sddBoardMonitorOpen: false,
    viewportRows: 24,
    historyScrolled: false,
    ...over,
  };
  return state as unknown as State;
}

function sampleSnapshot(over: Record<string, unknown> = {}) {
  return {
    runId: 'r1',
    graphId: 'g1',
    title: 'Build feature',
    status: 'running' as const,
    startedAt: 0,
    updatedAt: 0,
    progress: {
      total: 2,
      pending: 1,
      inProgress: 1,
      blocked: 0,
      failed: 0,
      review: 0,
      completed: 0,
      percentComplete: 0,
      estimatedHours: 0,
      actualHours: 0,
    },
    wave: 0,
    tasks: [],
    columns: [],
    ...over,
  };
}

describe('TUI reducer', () => {
  it('opening the F5 plan panel closes other F-key panels', () => {
    const s = {
      ...initial(),
      monitorOpen: true,
      agentsMonitorOpen: true,
      helpOpen: true,
      todosMonitorOpen: true,
      queuePanelOpen: true,
      processListOpen: true,
      goalPanelOpen: true,
      sessionsPanelOpen: true,
      settingsPicker: { ...initial().settingsPicker, open: true },
      statuslinePicker: { ...initial().statuslinePicker, open: true },
      projectPicker: { ...initial().projectPicker, open: true },
      fKeyPicker: { open: true, selected: 4 },
      goalRun: {
        title: 'Plan',
        phases: {},
        runningPhaseIds: [],
        elapsedMs: 0,
        monitorOpen: true,
      },
      worktreeMonitorOpen: true,
      coordinator: { ...initial().coordinator, monitorOpen: true },
    };

    const out = reducer(s, { type: 'togglePlanPanel' });

    expect(out.planPanelOpen).toBe(true);
    expect(out.monitorOpen).toBe(false);
    expect(out.agentsMonitorOpen).toBe(false);
    expect(out.helpOpen).toBe(false);
    expect(out.todosMonitorOpen).toBe(false);
    expect(out.queuePanelOpen).toBe(false);
    expect(out.processListOpen).toBe(false);
    expect(out.goalPanelOpen).toBe(false);
    expect(out.sessionsPanelOpen).toBe(false);
    expect(out.settingsPicker.open).toBe(false);
    expect(out.statuslinePicker.open).toBe(false);
    expect(out.projectPicker.open).toBe(false);
    expect(out.fKeyPicker.open).toBe(false);
    expect(out.goalRun?.monitorOpen).toBe(false);
    expect(out.worktreeMonitorOpen).toBe(false);
    expect(out.coordinator.monitorOpen).toBe(false);
  });

  it('closeAllPanels closes every panel in a single dispatch', () => {
    const s = {
      ...initial(),
      monitorOpen: true,
      agentsMonitorOpen: true,
      helpOpen: true,
      todosMonitorOpen: true,
      queuePanelOpen: true,
      processListOpen: true,
      planPanelOpen: true,
      kanbanPanelOpen: true,
      goalPanelOpen: true,
      sessionsPanelOpen: true,
      settingsPicker: { ...initial().settingsPicker, open: true },
      statuslinePicker: { ...initial().statuslinePicker, open: true },
      pluginPicker: { ...initial().pluginPicker, open: true, items: [], selected: 0 },
      mcpPicker: { ...initial().mcpPicker, open: true, items: [], selected: 0 },
      toolsPicker: { ...initial().toolsPicker, open: true, items: [], selected: 0 },
      brainPanel: { ...initial().brainPanel, open: true },
      helpPanel: { ...initial().helpPanel, open: true, entries: [], selected: 0 },
      shadowPanel: {
        ...initial().shadowPanel,
        open: true,
        shadow: { activeId: null, running: false, model: '', intervalMs: 30000 },
      },
      authPanel: { ...initial().authPanel, open: true },
      projectPicker: {
        ...initial().projectPicker,
        open: true,
        allItems: [],
        items: [],
        filter: '',
      },
      fKeyPicker: { open: true, selected: 0 },
      goalRun: {
        title: 'Plan',
        phases: {},
        runningPhaseIds: [],
        elapsedMs: 0,
        monitorOpen: true,
      },
      sddBoard: { monitorOpen: true, snapshot: null as never, focusColumn: undefined },
      worktreeMonitorOpen: true,
      coordinator: { ...initial().coordinator, monitorOpen: true },
    };

    const out = reducer(s, { type: 'closeAllPanels' });

    // Every panel/monitor/overlay is closed
    expect(out.monitorOpen).toBe(false);
    expect(out.agentsMonitorOpen).toBe(false);
    expect(out.helpOpen).toBe(false);
    expect(out.todosMonitorOpen).toBe(false);
    expect(out.queuePanelOpen).toBe(false);
    expect(out.processListOpen).toBe(false);
    expect(out.planPanelOpen).toBe(false);
    expect(out.kanbanPanelOpen).toBe(false);
    expect(out.goalPanelOpen).toBe(false);
    expect(out.sessionsPanelOpen).toBe(false);
    expect(out.settingsPicker.open).toBe(false);
    expect(out.statuslinePicker.open).toBe(false);
    expect(out.pluginPicker.open).toBe(false);
    expect(out.mcpPicker.open).toBe(false);
    expect(out.toolsPicker.open).toBe(false);
    expect(out.brainPanel.open).toBe(false);
    expect(out.helpPanel.open).toBe(false);
    expect(out.shadowPanel.open).toBe(false);
    expect(out.projectPicker.open).toBe(false);
    expect(out.fKeyPicker.open).toBe(false);
    expect(out.goalRun?.monitorOpen).toBe(false);
    expect(out.sddBoard?.monitorOpen).toBe(false);
    expect(out.worktreeMonitorOpen).toBe(false);
    expect(out.coordinator.monitorOpen).toBe(false);
    // No new panel was opened
    expect(out.planPanelOpen).toBe(false);
  });

  it('closeAllPanels is a no-op when all panels are already closed', () => {
    const base = initial();
    const out = reducer(base, { type: 'closeAllPanels' });
    // State is unchanged — no panels were toggled open
    expect(out.monitorOpen).toBe(false);
    expect(out.agentsMonitorOpen).toBe(false);
    expect(out.planPanelOpen).toBe(false);
    expect(out.settingsPicker.open).toBe(false);
    // Core fields preserved
    expect(out.buffer).toBe(base.buffer);
    expect(out.entries).toBe(base.entries);
    expect(out.status).toBe(base.status);
  });

  it('sddBoardSnapshot stores the snapshot and stays closed on first arrival', () => {
    const out = reducer(initial(), {
      type: 'sddBoardSnapshot',
      snapshot: sampleSnapshot() as never,
    });
    expect(out.sddBoard?.snapshot.runId).toBe('r1');
    expect(out.sddBoard?.monitorOpen).toBe(false);
  });

  it('sddBoardSnapshot preserves the overlay open state across snapshots', () => {
    let s = reducer(initial(), { type: 'sddBoardSnapshot', snapshot: sampleSnapshot() as never });
    s = reducer(s, { type: 'toggleSddBoardMonitor' });
    expect(s.sddBoard?.monitorOpen).toBe(true);
    // A fresh snapshot must not slam the overlay shut while the user watches.
    s = reducer(s, {
      type: 'sddBoardSnapshot',
      snapshot: sampleSnapshot({ wave: 1 }) as never,
    });
    expect(s.sddBoard?.monitorOpen).toBe(true);
    expect(s.sddBoard?.snapshot.wave).toBe(1);
  });

  it('toggleSddBoardMonitor is a no-op until the first snapshot arrives', () => {
    const out = reducer(initial(), { type: 'toggleSddBoardMonitor' });
    expect(out.sddBoard).toBeNull();
  });

  it('opening the SDD board closes other panels; opening another closes it', () => {
    let s = reducer(initial(), { type: 'sddBoardSnapshot', snapshot: sampleSnapshot() as never });
    s = { ...s, monitorOpen: true, worktreeMonitorOpen: true };
    s = reducer(s, { type: 'toggleSddBoardMonitor' });
    expect(s.sddBoard?.monitorOpen).toBe(true);
    expect(s.monitorOpen).toBe(false);
    expect(s.worktreeMonitorOpen).toBe(false);
    // Opening the worktree monitor must close the SDD board (ternary exclusivity).
    s = reducer(s, { type: 'toggleWorktreeMonitor' });
    expect(s.worktreeMonitorOpen).toBe(true);
    expect(s.sddBoard?.monitorOpen).toBe(false);
  });

  // ── SDD board per-phase drill-down ──────────────────────────────────────
  const cols = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ label: i === 0 ? 'Start' : `Phase ${i}`, taskIds: [] }));
  const openBoard = (n: number) => {
    let s = reducer(initial(), {
      type: 'sddBoardSnapshot',
      snapshot: sampleSnapshot({ columns: cols(n) }) as never,
    });
    s = reducer(s, { type: 'toggleSddBoardMonitor' });
    return s;
  };

  it('sddBoardFocusNext enters at column 0 then advances, clamped to the last', () => {
    let s = openBoard(3);
    expect(s.sddBoard?.focusColumn ?? null).toBeNull();
    s = reducer(s, { type: 'sddBoardFocusNext' });
    expect(s.sddBoard?.focusColumn).toBe(0);
    s = reducer(s, { type: 'sddBoardFocusNext' });
    expect(s.sddBoard?.focusColumn).toBe(1);
    s = reducer(s, { type: 'sddBoardFocusNext' });
    expect(s.sddBoard?.focusColumn).toBe(2);
    s = reducer(s, { type: 'sddBoardFocusNext' });
    expect(s.sddBoard?.focusColumn).toBe(2); // clamped
  });

  it('sddBoardFocusPrev steps back and exits the drill-down at column 0', () => {
    let s = openBoard(3);
    s = reducer(s, { type: 'sddBoardFocusNext' });
    s = reducer(s, { type: 'sddBoardFocusNext' }); // focus = 1
    s = reducer(s, { type: 'sddBoardFocusPrev' });
    expect(s.sddBoard?.focusColumn).toBe(0);
    s = reducer(s, { type: 'sddBoardFocusPrev' });
    expect(s.sddBoard?.focusColumn ?? null).toBeNull(); // exited to all-phases
    s = reducer(s, { type: 'sddBoardFocusPrev' });
    expect(s.sddBoard?.focusColumn ?? null).toBeNull(); // no-op
  });

  it('focus actions are no-ops while the board overlay is closed', () => {
    const s = reducer(initial(), {
      type: 'sddBoardSnapshot',
      snapshot: sampleSnapshot({ columns: cols(3) }) as never,
    });
    const out = reducer(s, { type: 'sddBoardFocusNext' });
    expect(out.sddBoard?.focusColumn ?? null).toBeNull();
  });

  it('closing the board resets the phase drill-down', () => {
    let s = openBoard(3);
    s = reducer(s, { type: 'sddBoardFocusNext' });
    expect(s.sddBoard?.focusColumn).toBe(0);
    s = reducer(s, { type: 'toggleSddBoardMonitor' }); // close
    expect(s.sddBoard?.focusColumn ?? null).toBeNull();
  });

  it('a snapshot with fewer columns clamps an out-of-range focus to all-phases', () => {
    let s = openBoard(3);
    s = reducer(s, { type: 'sddBoardFocusNext' });
    s = reducer(s, { type: 'sddBoardFocusNext' });
    s = reducer(s, { type: 'sddBoardFocusNext' }); // focus = 2
    s = reducer(s, {
      type: 'sddBoardSnapshot',
      snapshot: sampleSnapshot({ columns: cols(2) }) as never,
    });
    expect(s.sddBoard?.focusColumn ?? null).toBeNull();
  });

  it('opening another panel closes the F5 plan panel', () => {
    let s = reducer(initial(), { type: 'togglePlanPanel' });
    expect(s.planPanelOpen).toBe(true);

    s = reducer(s, { type: 'toggleAgentsMonitor' });

    expect(s.agentsMonitorOpen).toBe(true);
    expect(s.planPanelOpen).toBe(false);
  });

  it('fleetBatch folds actions in order into one new state', () => {
    let s = initial();
    // A batch of three appends behaves identically to dispatching them one by
    // one — same ids, same order — but in a single reducer pass (one render).
    s = reducer(s, {
      type: 'fleetBatch',
      actions: [
        { type: 'addEntry', entry: { kind: 'info', text: 'a' } },
        { type: 'addEntry', entry: { kind: 'info', text: 'b' } },
        { type: 'addEntry', entry: { kind: 'info', text: 'c' } },
      ],
    });
    expect(s.entries.map((e) => (e as { text: string }).text)).toEqual(['a', 'b', 'c']);
    expect(s.entries.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(s.nextId).toBe(4);
  });

  it('fleetBatch with no actions returns an equivalent state', () => {
    const s = initial();
    const out = reducer(s, { type: 'fleetBatch', actions: [] });
    expect(out.entries).toEqual(s.entries);
    expect(out.nextId).toBe(s.nextId);
  });

  it('addEntry assigns sequential ids', () => {
    let s = initial();
    s = reducer(s, { type: 'addEntry', entry: { kind: 'user', text: 'hi' } });
    s = reducer(s, { type: 'addEntry', entry: { kind: 'assistant', text: 'hello' } });
    expect(s.entries.map((e) => e.id)).toEqual([1, 2]);
    expect(s.nextId).toBe(3);
  });

  it('addEntry supports Brain decision entries as first-class history items', () => {
    const s = reducer(initial(), {
      type: 'addEntry',
      entry: {
        kind: 'brain',
        status: 'answered',
        source: 'director',
        risk: 'medium',
        question: 'Extend budget?',
        decision: 'extend',
        rationale: 'Still making progress.',
      },
    });

    expect(s.entries[0]).toMatchObject({
      id: 1,
      kind: 'brain',
      source: 'director',
      decision: 'extend',
    });
  });

  it('brainStatus updates the live Brain status chip state', () => {
    const s = reducer(initial(), {
      type: 'brainStatus',
      state: 'deciding',
      source: 'goal',
      risk: 'high',
      summary: 'goal: conflict',
    });

    expect(s.brain).toMatchObject({
      state: 'deciding',
      source: 'goal',
      risk: 'high',
      summary: 'goal: conflict',
    });
    expect(typeof s.brain.updatedAt).toBe('number');
  });

  it('brainPromptSet and brainPromptClear manage the visible Brain prompt', () => {
    const withPrompt = reducer(initial(), {
      type: 'brainPromptSet',
      prompt: {
        requestId: 'decision-1',
        source: 'goal',
        risk: 'high',
        question: 'Resolve conflict?',
        options: [{ id: 'review', label: 'Keep for review', recommended: true }],
      },
    });
    expect(withPrompt.brainPrompt?.question).toBe('Resolve conflict?');

    const cleared = reducer(withPrompt, { type: 'brainPromptClear' });
    expect(cleared.brainPrompt).toBeNull();
  });

  it('addEntry retains only the newest bounded display history', () => {
    let s = initial();
    for (let i = 0; i < 600; i++) {
      s = reducer(s, {
        type: 'addEntry',
        entry: { kind: 'info', text: `entry-${i}` },
      });
    }
    expect(s.entries.length).toBe(TUI_HISTORY_MAX_ENTRIES + 1);
    expect((s.entries[0] as { text: string }).text).toBe(
      '… 200 earlier TUI entries omitted (full session remains on disk).',
    );
    expect((s.entries.at(-1) as { text: string }).text).toBe('entry-599');
  });

  // ── /clear regression: bump historyGen so <Static> remounts ─────────────
  // The visible chat history is rendered by <Static> in
  // components/history/index.tsx, which is keyed on `historyGen`. <Static>
  // writes each item to the terminal exactly once and never re-renders it —
  // the `key` is the only way to force a remount that drops the previously
  // committed entries. Without this bump, /clear wiped state.entries but
  // every committed entry stayed on screen, so users saw "history not
  // cleared" even though the React state was empty. replaceHistory already
  // bumps historyGen for the resume-replay case; clearHistory must do the
  // same or /clear is a silent no-op against the rendered transcript.

  it('clearHistory bumps historyGen so <Static> remounts (mid-session)', () => {
    // Simulate a session that has already gone through one /clear (gen=7).
    const before = { ...initial(), historyGen: 7 };
    const out = reducer(before, { type: 'clearHistory' });
    expect(out.historyGen).toBe(8);
  });

  it('clearHistory bumps historyGen from 0 (first-ever /clear)', () => {
    const out = reducer(initial(), { type: 'clearHistory' });
    expect(out.historyGen).toBe(1);
  });

  // ── /clear regression: re-pin the managed virtual-scroll viewport ────────
  // The managed history viewport (components/scrollable-history.tsx) keeps its
  // scroll position, height-cache buffer, and measured-group set in
  // component-local refs/state the reducer cannot reach. If the user had
  // scrolled up (historyScrolled:true) and then ran /clear, the reducer must
  // (a) report historyScrolled:false and (b) bump historyGen — app-view.tsx
  // keys <ScrollableHistory> on historyGen, so the bump remounts the component
  // and resets its internal state back to the pinned/follow position. Without
  // both signals the viewport would stay in "scrolled-away" mode after a clear
  // and new output would no longer auto-follow the newest line.
  it('clearHistory re-pins the managed viewport (historyScrolled reset + historyGen bump)', () => {
    const before = { ...initial(), historyScrolled: true, historyGen: 2 };
    const out = reducer(before, { type: 'clearHistory' });
    expect(out.historyScrolled).toBe(false);
    expect(out.historyGen).toBe(3);
  });

  it('clearHistory resets active run, queue, stream, tool, confirm, and steering state', () => {
    const out = reducer(
      initial({
        status: 'running',
        interrupts: 2,
        steeringPending: true,
        steerSnapshot: {
          runningTools: ['bash'],
          subagents: [],
          subagentsTerminated: 0,
          partialAssistantText: 'stale',
        },
        streamingText: 'partial reply',
        toolStream: { toolUseId: 'tool-1', name: 'bash', text: 'output', startedAt: 1 },
        runningTools: new Map([['tool-1', { name: 'bash', startedAt: 1 }]]),
        queue: [{ id: 1, displayText: 'later', blocks: [{ type: 'text', text: 'later' }] }],
        confirmQueue: [
          {
            toolUseId: 'tool-1',
            toolName: 'bash',
            input: {},
            resolve: () => {},
            destructive: false,
            suggestedPattern: 'test-pattern',
          },
        ],
        debugStreamStats: {
          chunkCount: 1,
          lastChunkSize: 4,
          lastDeltaMs: 10,
          totalBytes: 4,
          lastChunkAt: new Date().toISOString(),
        },
      }),
      { type: 'clearHistory' },
    );

    expect(out.status).toBe('idle');
    expect(out.interrupts).toBe(0);
    expect(out.steeringPending).toBe(false);
    expect(out.steerSnapshot).toBeNull();
    expect(out.streamingText).toBe('');
    expect(out.toolStream).toBeNull();
    expect(out.runningTools.size).toBe(0);
    expect(out.queue).toEqual([]);
    expect(out.confirmQueue).toEqual([]);
    expect(out.debugStreamStats).toBeNull();
  });

  it('clearHistory drops any transient copy highlight', () => {
    const out = reducer(initial({ copiedNotice: '✓ Copied', copiedEntryId: 42 }), {
      type: 'clearHistory',
    });
    expect(out.copiedNotice).toBe('');
    expect(out.copiedEntryId).toBeNull();
  });

  it('setBuffer + clearInput reset cursor and history index', () => {
    let s = initial();
    s = reducer(s, { type: 'historyPush', text: 'older message' });
    s = reducer(s, { type: 'historyUp' });
    s = reducer(s, { type: 'setBuffer', buffer: 'hello', cursor: 5 });
    expect(s.buffer).toBe('hello');
    expect(s.historyIndex).toBe(1);
    s = reducer(s, { type: 'clearInput' });
    expect(s.buffer).toBe('');
    expect(s.cursor).toBe(0);
    expect(s.historyIndex).toBe(0);
    expect(s.picker.open).toBe(false);
  });

  it('streamDelta concatenates; streamReset clears', () => {
    let s = initial();
    s = reducer(s, { type: 'streamDelta', delta: 'Hel' });
    s = reducer(s, { type: 'streamDelta', delta: 'lo!' });
    expect(s.streamingText).toBe('Hello!');
    s = reducer(s, { type: 'streamReset' });
    expect(s.streamingText).toBe('');
  });

  it('streamDelta retains only a bounded live tail', () => {
    let s = initial();
    s = reducer(s, { type: 'streamDelta', delta: `head-${'x'.repeat(20_000)}` });
    expect(s.streamingText.length).toBe(16_384);
    expect(s.streamingText).not.toContain('head-');
    expect(s.streamingText).toBe('x'.repeat(16_384));
  });

  it('addEntry commits a thinking entry with text', () => {
    let s = initial();
    s = reducer(s, { type: 'addEntry', entry: { kind: 'thinking', text: 'reasoning here' } });
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ kind: 'thinking', text: 'reasoning here' });
  });

  it('addEntry skips empty thinking entries', () => {
    let s = initial();
    s = reducer(s, { type: 'addEntry', entry: { kind: 'thinking', text: '   ' } });
    expect(s.entries).toHaveLength(0);
  });

  it('picker open/close lifecycle', () => {
    let s = initial();
    s = reducer(s, { type: 'pickerOpen', query: 'src' });
    expect(s.picker.open).toBe(true);
    expect(s.picker.query).toBe('src');
    s = reducer(s, {
      type: 'pickerSetMatches',
      query: 'src',
      matches: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    });
    expect(s.picker.matches).toHaveLength(3);
    s = reducer(s, { type: 'pickerMove', delta: 1 });
    expect(s.picker.selected).toBe(1);
    s = reducer(s, { type: 'pickerMove', delta: -2 });
    expect(s.picker.selected).toBe(2); // wraps
    s = reducer(s, { type: 'pickerClose' });
    expect(s.picker.open).toBe(false);
    expect(s.picker.matches).toEqual([]);
  });

  it('pickerSetMatches with stale query is dropped', () => {
    let s = initial();
    s = reducer(s, { type: 'pickerOpen', query: 'foo' });
    s = reducer(s, { type: 'pickerSetMatches', query: 'old', matches: ['x'] });
    expect(s.picker.matches).toEqual([]);
  });

  it('pickerMove on empty matches is a no-op', () => {
    let s = initial();
    s = reducer(s, { type: 'pickerOpen', query: 'x' });
    s = reducer(s, { type: 'pickerMove', delta: 1 });
    expect(s.picker.selected).toBe(0);
  });

  it('interrupt counter and resetInterrupts', () => {
    let s = initial();
    s = reducer(s, { type: 'interrupt' });
    s = reducer(s, { type: 'interrupt' });
    expect(s.interrupts).toBe(2);
    s = reducer(s, { type: 'resetInterrupts' });
    expect(s.interrupts).toBe(0);
  });

  it('toolStarted tracks running tools; toolEnded clears by id', () => {
    let s = initial();
    s = reducer(s, { type: 'toolStarted', id: 't1', name: 'read' });
    s = reducer(s, { type: 'toolStarted', id: 't2', name: 'bash' });
    expect(s.runningTools.size).toBe(2);
    s = reducer(s, { type: 'toolEnded', id: 't1' });
    expect(s.runningTools.size).toBe(1);
    expect(s.runningTools.has('t2')).toBe(true);
  });

  it('toolEnded falls back to matching by name when id is unknown', () => {
    let s = initial();
    s = reducer(s, { type: 'toolStarted', id: 't1', name: 'read' });
    s = reducer(s, { type: 'toolStarted', id: 't2', name: 'read' });
    s = reducer(s, { type: 'toolEnded', name: 'read' });
    // Only one of the two should remain.
    expect(s.runningTools.size).toBe(1);
  });

  it('toolEnded with unknown id and no name is a no-op', () => {
    let s = initial();
    s = reducer(s, { type: 'toolStarted', id: 't1', name: 'read' });
    s = reducer(s, { type: 'toolEnded', id: 'nope' });
    expect(s.runningTools.size).toBe(1);
  });

  // Open the settings picker with a full payload so settingsValueChange has a
  // seeded settingsPicker to mutate.
  function openSettings(s: ReturnType<typeof initial>) {
    return reducer(s, {
      type: 'settingsOpen',
      mode: 'off',
      delayMs: 45_000,
      titleAnimation: true,
      yolo: false,
      fleetChat: 'off',
      chime: false,
      confirmExit: true,
      nextPrediction: false,
      featureMcp: true,
      featurePlugins: true,
      featureMemory: true,
      featureSkills: true,
      featureModelsRegistry: true,
      featureTokenSaving: false,
      contextAutoCompact: true,
      contextStrategy: 'hybrid',
      logLevel: 'info',
      auditLevel: 'standard',
      indexOnStart: true,
      multiDiffSummaryThreshold: 5,
      maxIterations: 500,
      autoProceedMaxIterations: 50,
      enhanceDelayMs: 60_000,
      enhanceEnabled: true,
      enhanceLanguage: 'original',
      debugStream: false,
      statuslineMode: 'detailed' as const,
      configScope: 'global',
      restrictFsToRoot: false,
      showAgentSwarmPanel: 'bottom',
    } as never);
  }

  it('settingsValueChange flags a boot-only field (MCP) with a restart hint', () => {
    let s = openSettings(initial());
    s = reducer(s, { type: 'settingsFieldMove', delta: 8 }); // → field 8 = MCP servers
    s = reducer(s, { type: 'settingsValueChange', delta: 1 } as never);
    expect(s.settingsPicker.featureMcp).toBe(false); // toggled
    expect(s.settingsPicker.hint).toBe('↻ Takes effect next session');
  });

  it('settingsValueChange clears the hint for a live-applicable field (YOLO)', () => {
    let s = openSettings(initial());
    s = reducer(s, { type: 'settingsFieldMove', delta: 3 }); // → field 3 = YOLO (live)
    s = reducer(s, { type: 'settingsValueChange', delta: 1 } as never);
    expect(s.settingsPicker.yolo).toBe(true); // toggled
    expect(s.settingsPicker.hint).toBeUndefined();
  });

  it('settingsValueChange toggles the sidebar mission queue live', () => {
    let s = openSettings(initial());
    s = reducer(s, { type: 'settingsFieldMove', delta: 40 });
    s = reducer(s, { type: 'settingsValueChange', delta: 1 } as never);
    expect(s.settingsPicker.showAgentSwarmPanel).toBe('sidebar');
    expect(s.settingsPicker.hint).toBeUndefined();
  });

  it('settingsValueChange flags compactor strategy (boot-only) but not auto-compact toggle (live)', () => {
    // Auto-compact on/off (field 27) applies live → no hint.
    let live = openSettings(initial());
    live = reducer(live, { type: 'settingsFieldMove', delta: 27 });
    live = reducer(live, { type: 'settingsValueChange', delta: 1 } as never);
    expect(live.settingsPicker.contextAutoCompact).toBe(false);
    expect(live.settingsPicker.hint).toBeUndefined();

    // Compactor strategy (field 28) needs a restart → hint.
    let strat = openSettings(initial());
    strat = reducer(strat, { type: 'settingsFieldMove', delta: 28 });
    strat = reducer(strat, { type: 'settingsValueChange', delta: 1 } as never);
    expect(strat.settingsPicker.hint).toBe('↻ Takes effect next session');
  });

  it('fleetTool keeps only the last two compact tool summaries', () => {
    let s = initial();
    s = reducer(s, { type: 'fleetSpawn', id: 'agent-1', name: 'worker' });
    s = reducer(s, {
      type: 'fleetTool',
      id: 'agent-1',
      name: 'read',
      ok: true,
      durationMs: 12,
      outputBytes: 399,
      outputLines: 7,
    });
    s = reducer(s, {
      type: 'fleetTool',
      id: 'agent-1',
      name: 'write',
      ok: true,
      durationMs: 20,
    });
    s = reducer(s, {
      type: 'fleetTool',
      id: 'agent-1',
      name: 'test',
      ok: false,
      durationMs: 30,
    });

    expect(s.fleet['agent-1']?.toolCalls).toBe(3);
    expect(s.fleet['agent-1']?.recentTools.map((tool) => tool.name)).toEqual(['write', 'test']);
    expect(s.fleet['agent-1']?.recentTools[1]?.ok).toBe(false);
  });

  it('fleetRemove deletes a retired subagent from live TUI state', () => {
    let s = reducer(initial(), { type: 'fleetSpawn', id: 'agent-1', name: 'worker' });
    expect(s.fleet['agent-1']).toBeDefined();

    s = reducer(s, { type: 'fleetRemove', id: 'agent-1' });
    expect(s.fleet['agent-1']).toBeUndefined();
  });

  it('enhanceOpen sets the panel state and enhanceClose clears it', () => {
    let s = initial();
    const resolve = () => {};
    s = reducer(s, {
      type: 'enhanceOpen',
      info: {
        original: 'fix the bug',
        refined: 'Fix the null deref in auth.ts',
        english: 'Fix the null deref in auth.ts',
        resolve,
      },
    });
    expect(s.enhance).toEqual({
      original: 'fix the bug',
      refined: 'Fix the null deref in auth.ts',
      english: 'Fix the null deref in auth.ts',
      resolve,
    });
    s = reducer(s, { type: 'enhanceClose' });
    expect(s.enhance).toBeNull();
  });

  it('refineFailureOpen sets the recovery panel and refineFailureClose clears it', () => {
    let s = initial();
    const resolve = () => {};
    s = reducer(s, {
      type: 'refineFailureOpen',
      info: {
        original: 'fix the bug in the parser',
        error: 'timed out after 90s',
        elapsedMs: 91_000,
        fallbackRef: 'anthropic/claude-haiku-4-5',
        models: [{ providerId: 'openai', model: 'gpt-5', label: 'openai' }],
        resolve,
      },
    });
    expect(s.refineFailure).toEqual({
      original: 'fix the bug in the parser',
      error: 'timed out after 90s',
      elapsedMs: 91_000,
      fallbackRef: 'anthropic/claude-haiku-4-5',
      models: [{ providerId: 'openai', model: 'gpt-5', label: 'openai' }],
      resolve,
    });
    s = reducer(s, { type: 'refineFailureClose' });
    expect(s.refineFailure).toBeNull();
  });

  it('shellCommandWarningOpen sets the warning state and shellCommandWarningClose clears it', () => {
    let s = initial();
    const resolve = () => {};
    s = reducer(s, {
      type: 'shellCommandWarningOpen',
      info: { command: 'git status', resolve },
    });

    expect(s.shellCommandWarning).toEqual({ command: 'git status', resolve });
    s = reducer(s, { type: 'shellCommandWarningClose' });
    expect(s.shellCommandWarning).toBeNull();
  });

  it('continueConfirmOpen sets the panel state and continueConfirmClose clears it', () => {
    let s = initial();
    const resolve = () => {};
    s = reducer(s, {
      type: 'continueConfirmOpen',
      info: {
        label: '▶ Continue → todo: Fix auth',
        instruction: 'Continue with the plan. Resume work on the next open todo…',
        source: 'todo',
        grounded: true,
        resolve,
      },
    });
    expect(s.continueConfirm).toEqual({
      label: '▶ Continue → todo: Fix auth',
      instruction: 'Continue with the plan. Resume work on the next open todo…',
      source: 'todo',
      grounded: true,
      resolve,
    });
    s = reducer(s, { type: 'continueConfirmClose' });
    expect(s.continueConfirm).toBeNull();
  });

  it('enhanceSet toggles the enhanceEnabled flag', () => {
    let s = initial();
    expect(s.enhanceEnabled).toBe(true);
    s = reducer(s, { type: 'enhanceSet', enabled: false });
    expect(s.enhanceEnabled).toBe(false);
    s = reducer(s, { type: 'enhanceSet', enabled: true });
    expect(s.enhanceEnabled).toBe(true);
  });

  it('fleetCost folds per-subagent cost into the matching fleet entries', () => {
    let s = initial();
    s = reducer(s, { type: 'fleetSpawn', id: 'agent-1', name: 'worker' });
    s = reducer(s, { type: 'fleetSpawn', id: 'agent-2', name: 'helper' });
    s = reducer(s, {
      type: 'fleetCost',
      cost: 0.5,
      input: 1000,
      output: 200,
      perAgent: {
        'agent-1': { cost: 0.3 },
        'agent-2': { cost: 0.2 },
        // An unknown id must be ignored, not crash or create an entry.
        'ghost-agent': { cost: 9.9 },
      },
    });

    expect(s.fleetCost).toBe(0.5);
    expect(s.fleetTokens).toEqual({ input: 1000, output: 200 });
    expect(s.fleet['agent-1']?.cost).toBe(0.3);
    expect(s.fleet['agent-2']?.cost).toBe(0.2);
    expect(s.fleet['ghost-agent']).toBeUndefined();
  });

  it('fleetCost without perAgent leaves entry costs untouched', () => {
    let s = initial();
    s = reducer(s, { type: 'fleetSpawn', id: 'agent-1', name: 'worker' });
    s = reducer(s, { type: 'fleetCost', cost: 1.2 });
    expect(s.fleetCost).toBe(1.2);
    expect(s.fleet['agent-1']?.cost).toBe(0);
  });

  it('caps fleet and leader context load at 100%', () => {
    let s = initial();
    s = reducer(s, { type: 'fleetSpawn', id: 'agent-1', name: 'worker' });
    s = reducer(s, {
      type: 'fleetCtxPct',
      id: 'agent-1',
      load: 1.5,
      tokens: 150_000,
      maxContext: 100_000,
    });
    expect(s.fleet['agent-1']?.ctxPct).toBe(1);

    const withLeader = reducer(s, {
      type: 'leaderCtxPct',
      load: 1.25,
      tokens: 125_000,
      maxContext: 100_000,
    });
    expect(withLeader.leader.ctxPct).toBe(1);
  });

  it('fleetMessage keeps only the last two compact text snippets', () => {
    let s = initial();
    s = reducer(s, { type: 'fleetSpawn', id: 'agent-1', name: 'worker' });
    s = reducer(s, { type: 'fleetMessage', id: 'agent-1', text: ' first  message ' });
    s = reducer(s, { type: 'fleetMessage', id: 'agent-1', text: 'second message' });
    s = reducer(s, { type: 'fleetMessage', id: 'agent-1', text: 'third message' });

    expect(s.fleet['agent-1']?.recentMessages.map((message) => message.text)).toEqual([
      'second message',
      'third message',
    ]);
  });

  it('enqueue appends with sequential queue ids', () => {
    let s = initial();
    s = reducer(s, { type: 'enqueue', item: { displayText: 'first', blocks: [] } });
    s = reducer(s, { type: 'enqueue', item: { displayText: 'second', blocks: [] } });
    expect(s.queue.map((q) => q.id)).toEqual([1, 2]);
    expect(s.queue.map((q) => q.displayText)).toEqual(['first', 'second']);
    expect(s.nextQueueId).toBe(3);
  });

  it('dequeueFirst removes the head (FIFO)', () => {
    let s = initial();
    s = reducer(s, { type: 'enqueue', item: { displayText: 'a', blocks: [] } });
    s = reducer(s, { type: 'enqueue', item: { displayText: 'b', blocks: [] } });
    s = reducer(s, { type: 'dequeueFirst' });
    expect(s.queue).toHaveLength(1);
    expect(s.queue[0]?.displayText).toBe('b');
  });

  it('dequeueFirst on empty queue is a no-op (same ref)', () => {
    const s = initial();
    const next = reducer(s, { type: 'dequeueFirst' });
    expect(next).toBe(s);
  });

  it('queueClear empties the queue', () => {
    let s = initial();
    s = reducer(s, { type: 'enqueue', item: { displayText: 'a', blocks: [] } });
    s = reducer(s, { type: 'enqueue', item: { displayText: 'b', blocks: [] } });
    s = reducer(s, { type: 'queueClear' });
    expect(s.queue).toEqual([]);
  });

  it('queueClear on empty queue is a no-op (same ref)', () => {
    const s = initial();
    const next = reducer(s, { type: 'queueClear' });
    expect(next).toBe(s);
  });

  it('queueDelete drops by 1-based positions and ignores out-of-range', () => {
    let s = initial();
    for (const t of ['a', 'b', 'c', 'd']) {
      s = reducer(s, { type: 'enqueue', item: { displayText: t, blocks: [] } });
    }
    s = reducer(s, { type: 'queueDelete', positions: [1, 3, 99, 0, -1] });
    expect(s.queue.map((q) => q.displayText)).toEqual(['b', 'd']);
  });

  it('queueDelete with only invalid positions is a no-op', () => {
    let s = initial();
    s = reducer(s, { type: 'enqueue', item: { displayText: 'a', blocks: [] } });
    const before = s;
    s = reducer(s, { type: 'queueDelete', positions: [99, 0, -5] });
    expect(s).toBe(before);
  });

  it('steerConsume clears steeringPending, steerSnapshot, and interrupts', () => {
    let s = initial();
    s = {
      ...s,
      steeringPending: true,
      steerSnapshot: {
        runningTools: ['read'],
        subagents: [],
        subagentsTerminated: 0,
        partialAssistantText: '',
      },
      interrupts: 2,
    };
    s = reducer(s, { type: 'steerConsume' });
    expect(s.steeringPending).toBe(false);
    expect(s.steerSnapshot).toBeNull();
    expect(s.interrupts).toBe(0);
  });

  it('steerStart sets steeringPending + steerSnapshot, steerConsume clears them back', () => {
    const snapshot = {
      runningTools: ['bash'],
      subagents: [{ label: 'w', status: 'running' as const, tool: 'grep' }],
      subagentsTerminated: 1,
      partialAssistantText: '...',
    };
    let s = reducer(initial(), { type: 'steerStart', snapshot });
    expect(s.steeringPending).toBe(true);
    expect(s.steerSnapshot).toEqual(snapshot);
    s = reducer(s, { type: 'steerConsume' });
    expect(s.steeringPending).toBe(false);
    expect(s.steerSnapshot).toBeNull();
  });

  it('Esc confirm flow leaves steeringPending=true AND status=aborting simultaneously (regression for #87)', () => {
    // Regression for issue #87. After the user confirms the Esc interrupt
    // prompt, the TUI is in this exact state:
    //   - `status: 'aborting'` because the active controller is mid-settle
    //   - `steeringPending: true` because the next user message is reserved
    //     as the steering redirect and must NOT be enqueued
    //
    // The submit handler in app.tsx reads both and the !steering override
    // below gates the "queue when busy" branch on `!steering`. This test
    // pins the precondition that the override depends on: when both
    // signals are simultaneously true, the reducer must NOT clear
    // `steeringPending` (so the submit handler sees it), and the status
    // remains 'aborting' (so the gate would otherwise fire).
    const snapshot = {
      runningTools: ['bash'],
      subagents: [],
      subagentsTerminated: 0,
      partialAssistantText: '',
    };
    let s = reducer(initial(), { type: 'status', status: 'aborting' });
    s = reducer(s, { type: 'steerStart', snapshot });
    // Both signals fire together — the gate in app.tsx relies on this.
    expect(s.status).toBe('aborting');
    expect(s.steeringPending).toBe(true);
    expect(s.steerSnapshot).toEqual(snapshot);
    // status: 'idle' after the abort settles does NOT clear steeringPending
    // — only steerConsume does. Otherwise the user's next message would
    // lose the preamble and be enqueued again.
    s = reducer(s, { type: 'status', status: 'idle' });
    expect(s.steeringPending).toBe(true);
    expect(s.steerSnapshot).toEqual(snapshot);
    // Only steerConsume clears the steering flag.
    s = reducer(s, { type: 'steerConsume' });
    expect(s.steeringPending).toBe(false);
    expect(s.steerSnapshot).toBeNull();
  });

  it('addEntry rejects empty/whitespace text for user, assistant, info, warn, error kinds', () => {
    const emptyKinds = ['user', 'assistant', 'info', 'warn', 'error'] as const;
    for (const kind of emptyKinds) {
      let s = initial();
      // Whitespace-only
      s = reducer(s, { type: 'addEntry', entry: { kind, text: '   ' } as any });
      expect(s.entries).toHaveLength(0);
      // Empty string
      s = reducer(s, { type: 'addEntry', entry: { kind, text: '' } as any });
      expect(s.entries).toHaveLength(0);
    }
  });

  it('addEntry accepts non-empty text for user, assistant, info kinds', () => {
    let s = initial();
    s = reducer(s, { type: 'addEntry', entry: { kind: 'user', text: 'hello' } });
    expect(s.entries).toHaveLength(1);
    s = reducer(s, { type: 'addEntry', entry: { kind: 'assistant', text: 'hi' } });
    expect(s.entries).toHaveLength(2);
    s = reducer(s, { type: 'addEntry', entry: { kind: 'info', text: 'ok' } });
    expect(s.entries).toHaveLength(3);
  });

  it('copiedNotice sets and clears the transient copy confirmation and its entry id', () => {
    let s = reducer(initial(), { type: 'copiedNotice', text: '✓ Copied', entryId: 7 });
    expect(s.copiedNotice).toBe('✓ Copied');
    expect(s.copiedEntryId).toBe(7);
    // It is independent of the shared hint slice.
    expect(s.hint).toBe('');
    s = reducer(s, { type: 'copiedNotice', text: '', entryId: null });
    expect(s.copiedNotice).toBe('');
    expect(s.copiedEntryId).toBeNull();
  });

  it('copiedNotice does not disturb the hint slice and vice versa', () => {
    let s = reducer(initial(), { type: 'hint', text: 'managed' });
    s = reducer(s, { type: 'copiedNotice', text: '✓ Copied', entryId: 3 });
    expect(s.hint).toBe('managed');
    expect(s.copiedNotice).toBe('✓ Copied');
    expect(s.copiedEntryId).toBe(3);
  });
});

describe('selectedSlashCommandLine', () => {
  it('returns the selected command line for Enter dispatch', () => {
    expect(
      selectedSlashCommandLine({
        open: true,
        selected: 1,
        matches: [
          { name: 'help', description: 'Help', category: 'App', isBuiltin: true },
          { name: 'init', description: 'Init', category: 'App', isBuiltin: true },
        ],
      }),
    ).toBe('/init');
  });

  it('returns null when the slash picker has nothing to dispatch', () => {
    expect(selectedSlashCommandLine({ open: false, selected: 0, matches: [] })).toBeNull();
    expect(selectedSlashCommandLine({ open: true, selected: 0, matches: [] })).toBeNull();
  });
});

describe('settings picker reducer', () => {
  // Minimal state slice — only the fields the settings cases touch. The
  // reducer returns {...state, settingsPicker}, so other fields are irrelevant.
  const base = (over: Record<string, unknown> = {}) =>
    ({
      settingsPicker: {
        open: false,
        field: 0,
        lastSettingsField: 0,
        filter: '',
        mode: 'off' as const,
        delayMs: 0,
        titleAnimation: true,
        yolo: false,
        fleetChat: 'off',
        chime: false,
        confirmExit: true,
        nextPrediction: false,
        featureMcp: true,
        featurePlugins: true,
        featureMemory: true,
        featureSkills: true,
        featureModelsRegistry: true,
        tokenSavingTier: 'off' as const,
        allowOutsideProjectRoot: true,
        contextAutoCompact: true,
        contextStrategy: 'hybrid' as const,
        contextMode: 'balanced' as const,
        maxConcurrent: 3,
        logLevel: 'info' as const,
        auditLevel: 'standard' as const,
        indexOnStart: true,
        multiDiffSummaryThreshold: 5,
        maxIterations: 500,
        autoProceedMaxIterations: 50,
        enhanceDelayMs: 60_000,
        enhanceEnabled: true,
        enhanceLanguage: 'original' as const,
        reasoningMode: 'auto' as const,
        reasoningEffort: 'medium' as const,
        reasoningPreserve: false,
        thinkingWord: 'thinking',
        cacheTtl: 'default' as const,
        debugStream: false,
        statuslineMode: 'detailed' as const,
        configScope: 'global' as const,
        ...over,
      },
    }) as never as Parameters<typeof reducer>[0];

  // Minimal `settingsOpen` action payload — covers every required field
  // with the same defaults `base()` uses, so tests that exercise close/reopen
  // cycles can dispatch the open action without re-stating 30+ fields.
  // (The reducer ignores the action's `field` — it reads the previous
  // runtime value to preserve the last-visited row.)
  const settingsOpenPayload = (over: Record<string, unknown> = {}): Parameters<typeof reducer>[1] =>
    ({
      type: 'settingsOpen' as const,
      mode: 'off',
      delayMs: 0,
      lastSettingsField: 0,
      titleAnimation: true,
      yolo: false,
      fleetChat: 'off',
      chime: false,
      confirmExit: true,
      nextPrediction: false,
      featureMcp: true,
      featurePlugins: true,
      featureMemory: true,
      featureSkills: true,
      featureModelsRegistry: true,
      tokenSavingTier: 'off' as const,
      allowOutsideProjectRoot: true,
      contextAutoCompact: true,
      contextStrategy: 'hybrid' as const,
      contextMode: 'balanced' as const,
      maxConcurrent: 3,
      logLevel: 'info' as const,
      auditLevel: 'standard' as const,
      indexOnStart: true,
      multiDiffSummaryThreshold: 5,
      maxIterations: 500,
      autoProceedMaxIterations: 50,
      enhanceDelayMs: 60_000,
      enhanceEnabled: true,
      enhanceLanguage: 'original' as const,
      debugStream: false,
      statuslineMode: 'detailed' as const,
      reasoningMode: 'auto' as const,
      reasoningEffort: 'medium' as const,
      reasoningPreserve: false,
      thinkingWord: 'thinking',
      cacheTtl: 'default' as const,
      configScope: 'global' as const,
      showAgentSwarmPanel: 'bottom',
      ...over,
    }) as Parameters<typeof reducer>[1];

  it('opens with the supplied mode + delay and focuses the first field', () => {
    const s = reducer(base(), {
      type: 'settingsOpen',
      mode: 'auto',
      delayMs: 30_000,
      titleAnimation: true,
      yolo: false,
      fleetChat: 'off',
      chime: false,
      confirmExit: true,
      nextPrediction: false,
      featureMcp: true,
      featurePlugins: true,
      featureMemory: true,
      featureSkills: true,
      featureModelsRegistry: true,
      tokenSavingTier: 'off',
      allowOutsideProjectRoot: true,
      contextAutoCompact: true,
      contextStrategy: 'hybrid',
      contextMode: 'balanced',
      maxConcurrent: 3,
      logLevel: 'info',
      auditLevel: 'standard',
      indexOnStart: true,
      multiDiffSummaryThreshold: 5,
      maxIterations: 500,
      autoProceedMaxIterations: 50,
      enhanceDelayMs: 60_000,
      enhanceEnabled: true,
      enhanceLanguage: 'original',
      reasoningMode: 'auto',
      reasoningEffort: 'medium',
      reasoningPreserve: false,
      thinkingWord: 'thinking',
      cacheTtl: 'default',
      debugStream: false,
      statuslineMode: 'detailed' as const,
      configScope: 'global',
    } as Parameters<typeof reducer>[1]);
    expect(s.settingsPicker).toMatchObject({ open: true, field: 0, mode: 'auto', delayMs: 30_000 });
  });

  it('close flips open false but keeps the values', () => {
    const s = reducer(base({ open: true, mode: 'suggest', delayMs: 15_000 }), {
      type: 'settingsClose',
    });
    expect(s.settingsPicker).toMatchObject({ open: false, mode: 'suggest', delayMs: 15_000 });
  });

  it('reopen after close restores the last-visited row (Ctrl+M target)', () => {
    // Simulates: user opens picker, jumps to Multi-diff summary via
    // Ctrl+M (field 21), closes the picker, reopens. The expected
    // behaviour is the picker reopens on field 21 — not back on 0 — so
    // they can keep iterating without re-navigating from the top.
    let s = reducer(base({ open: true, field: 0 }), { type: 'settingsFieldSet', field: 21 });
    expect(s.settingsPicker.field).toBe(21);
    s = reducer(s, { type: 'settingsClose' });
    expect(s.settingsPicker.open).toBe(false);
    expect(s.settingsPicker.field).toBe(21); // survives close
    s = reducer(s, settingsOpenPayload());
    expect(s.settingsPicker.open).toBe(true);
    expect(s.settingsPicker.field).toBe(21); // reopened on the last row
  });

  it('reopen honours the persisted lastSettingsField across a "session restart"', () => {
    // Cross-session behaviour: simulate a fresh runtime (field: 0,
    // lastSettingsField: 0 — as if the process just started and loaded
    // settings from disk). The `settingsOpen` action carries
    // `lastSettingsField: 17` from the canonical Settings shape, and the
    // picker should land on row 17 even though the runtime state
    // remembers nothing.
    //
    // This guards the "open action's lastSettingsField drives the open
    // row" contract — without it, a restart would always drop the user
    // back on row 0.
    const s = reducer(
      base({ field: 0, lastSettingsField: 0 }),
      settingsOpenPayload({ lastSettingsField: 17 }),
    );
    expect(s.settingsPicker.open).toBe(true);
    expect(s.settingsPicker.field).toBe(17);
    expect(s.settingsPicker.lastSettingsField).toBe(17);
  });

  it('navigation keeps lastSettingsField in sync with field (single source of truth)', () => {
    // Whether the user navigates via Ctrl+<letter> (settingsFieldSet)
    // or arrow keys (settingsFieldMove), `lastSettingsField` must mirror
    // `field` so the auto-save effect can write the canonical Settings
    // shape with the most recent focus.
    let s = reducer(base({ open: true, field: 0, lastSettingsField: 0 }), {
      type: 'settingsFieldSet',
      field: 22, // thinking word
    });
    expect(s.settingsPicker.field).toBe(22);
    expect(s.settingsPicker.lastSettingsField).toBe(22);

    s = reducer(s, { type: 'settingsFieldMove', delta: 1 });
    expect(s.settingsPicker.field).toBe(23);
    expect(s.settingsPicker.lastSettingsField).toBe(23);

    // Wrap from field 23 back to 0 — `delta: -23` (or equivalently
    // `delta: SETTINGS_FIELD_COUNT - 23`) is the exact wrap. Both
    // `field` and `lastSettingsField` must land on 0 together.
    s = reducer(s, { type: 'settingsFieldMove', delta: -23 });
    expect(s.settingsPicker.field).toBe(0);
    expect(s.settingsPicker.lastSettingsField).toBe(0);
  });

  it('multiple close/reopen cycles land on the most recent row', () => {
    // User visits row 17, closes, reopens (lands on 17), moves to 30,
    // closes, reopens (should land on 30 — not 17). Verifies that the
    // "last visited" semantics is *last*, not *first visited this session*.
    let s = reducer(base({ open: true, field: 0 }), { type: 'settingsFieldSet', field: 17 });
    s = reducer(s, { type: 'settingsClose' });
    s = reducer(s, settingsOpenPayload());
    expect(s.settingsPicker.field).toBe(17);
    s = reducer(s, { type: 'settingsFieldSet', field: 30 });
    s = reducer(s, { type: 'settingsClose' });
    s = reducer(s, settingsOpenPayload());
    expect(s.settingsPicker.field).toBe(30);
  });

  it('field move wraps between fields', () => {
    // Wrap back to 0 after the last field (SETTINGS_FIELD_COUNT fields total).
    let s = reducer(base({ open: true, field: 0 }), { type: 'settingsFieldMove', delta: 1 });
    expect(s.settingsPicker.field).toBe(1);
    // Move forward enough to wrap around
    for (let i = 1; i < SETTINGS_FIELD_COUNT; i++) {
      s = reducer(s, { type: 'settingsFieldMove', delta: 1 });
    }
    expect(s.settingsPicker.field).toBe(0);
  });

  it('settingsFieldSet focuses an explicit field', () => {
    const s = reducer(base({ open: true, field: 0 }), { type: 'settingsFieldSet', field: 1 });
    expect(s.settingsPicker.field).toBe(1);
  });

  it('value change cycles the mode on field 0 (wraps off→suggest→auto→off)', () => {
    let s = reducer(base({ open: true, field: 0, mode: 'off' }), {
      type: 'settingsValueChange',
      delta: 1,
    });
    expect(s.settingsPicker.mode).toBe('suggest');
    s = reducer(
      { ...s, settingsPicker: { ...s.settingsPicker, mode: 'auto' } },
      {
        type: 'settingsValueChange',
        delta: 1,
      },
    );
    expect(s.settingsPicker.mode).toBe('off');
  });

  it('value change steps the delay presets on field 1 (and wraps backwards)', () => {
    const up = reducer(base({ open: true, field: 1, delayMs: 0 }), {
      type: 'settingsValueChange',
      delta: 1,
    });
    expect(up.settingsPicker.delayMs).toBe(15_000);
    const down = reducer(base({ open: true, field: 1, delayMs: 0 }), {
      type: 'settingsValueChange',
      delta: -1,
    });
    expect(down.settingsPicker.delayMs).toBe(120_000);
  });

  it('field 24 narrows the effort cycle to the documented model vocabulary', () => {
    // Host-documented vocabulary [low, high, max]: the cycle keeps canonical
    // ORDER but only walks documented levels — none/minimal/xhigh are never
    // produced. The persisted-but-unadvertised value participates only while
    // it is the CURRENT selection (same recomputed-options semantics as the
    // WebUI pickers): a backwards step proves the desync slot is live.
    let s = reducer(
      base({
        open: true,
        field: 24,
        reasoningEffort: 'medium',
        reasoningEffortLevels: ['low', 'high', 'max'],
      }),
      { type: 'settingsValueChange', delta: -1 },
    );
    expect(s.settingsPicker.reasoningEffort).toBe('low'); // desync slot: below medium
    // Forward walk on the documented set — medium is gone once left.
    s = reducer(s, { type: 'settingsValueChange', delta: 1 });
    expect(s.settingsPicker.reasoningEffort).toBe('high');
    s = reducer(s, { type: 'settingsValueChange', delta: 1 });
    expect(s.settingsPicker.reasoningEffort).toBe('max');
    s = reducer(s, { type: 'settingsValueChange', delta: 1 });
    expect(s.settingsPicker.reasoningEffort).toBe('low'); // wraps
    s = reducer(s, { type: 'settingsValueChange', delta: 1 });
    expect(s.settingsPicker.reasoningEffort).toBe('high');

    // Undocumented vocabulary: the full canonical set still cycles unchanged.
    s = reducer(
      base({ open: true, field: 24, reasoningEffort: 'high', statuslineMode: 'detailed' }),
      { type: 'settingsValueChange', delta: 1 },
    );
    expect(s.settingsPicker.reasoningEffort).toBe('xhigh');
    expect(s.settingsPicker.statuslineMode).toBe('detailed'); // unaffected
  });

  // New field order (reordered sections, thinkingWord added at field 22, multi-diff summary at field 21):
  // 0-14: Autonomy + UX + Features (unchanged)
  // 15-20: Tools (indexOnStart moved here), 21: multiDiffSummaryThreshold
  // 22: thinkingWord, 23-26: Reasoning, 27-29: Context, 30: Fleet, 31-32: Logging, 33-35: Debug
  it('changes the setting that matches the visible tail field order', () => {
    // Field 23: reasoningMode cycles auto → on
    let s = reducer(
      base({ open: true, field: 23, reasoningMode: 'auto', thinkingWord: 'thinking' }),
      {
        type: 'settingsValueChange',
        delta: 1,
      },
    );
    expect(s.settingsPicker.reasoningMode).toBe('on');
    expect(s.settingsPicker.thinkingWord).toBe('thinking'); // unaffected

    // Field 24: reasoningEffort cycles medium → high
    s = reducer(
      base({ open: true, field: 24, reasoningEffort: 'medium', statuslineMode: 'detailed' }),
      {
        type: 'settingsValueChange',
        delta: 1,
      },
    );
    expect(s.settingsPicker.reasoningEffort).toBe('high');
    expect(s.settingsPicker.statuslineMode).toBe('detailed'); // unaffected

    // Field 25: reasoningPreserve cycles false → true
    s = reducer(base({ open: true, field: 25, reasoningPreserve: false, reasoningMode: 'auto' }), {
      type: 'settingsValueChange',
      delta: 1,
    });
    expect(s.settingsPicker.reasoningPreserve).toBe(true);
    expect(s.settingsPicker.reasoningMode).toBe('auto'); // unaffected

    // Field 26: cacheTtl cycles default → 5m
    s = reducer(base({ open: true, field: 26, cacheTtl: 'default', configScope: 'global' }), {
      type: 'settingsValueChange',
      delta: 1,
    });
    expect(s.settingsPicker.cacheTtl).toBe('5m');
    expect(s.settingsPicker.configScope).toBe('global'); // unaffected

    // Field 33: debugStream toggles false → true
    s = reducer(base({ open: true, field: 33, debugStream: false }), {
      type: 'settingsValueChange',
      delta: 1,
    });
    expect(s.settingsPicker.debugStream).toBe(true);

    // Field 34: statuslineMode cycles detailed → no-color
    s = reducer(base({ open: true, field: 34, statuslineMode: 'detailed' }), {
      type: 'settingsValueChange',
      delta: 1,
    });
    expect(s.settingsPicker.statuslineMode).toBe('no-color');

    // Field 35: configScope cycles global → project
    s = reducer(base({ open: true, field: 35, configScope: 'global', cacheTtl: 'default' }), {
      type: 'settingsValueChange',
      delta: 1,
    });
    expect(s.settingsPicker.configScope).toBe('project');
    expect(s.settingsPicker.cacheTtl).toBe('default'); // unaffected
  });

  it('value change cycles preRefineSeconds on field 41 through [0, 2, 3, 5, 8, 10]', () => {
    // Forward step from default 3 → 5
    const fwd = reducer(base({ open: true, field: 41, preRefineSeconds: 3 }), {
      type: 'settingsValueChange',
      delta: 1,
    });
    expect(fwd.settingsPicker.preRefineSeconds).toBe(5);

    // Backward step from 3 → 2
    const bwd = reducer(base({ open: true, field: 41, preRefineSeconds: 3 }), {
      type: 'settingsValueChange',
      delta: -1,
    });
    expect(bwd.settingsPicker.preRefineSeconds).toBe(2);

    // Forward from 10 (last) wraps to 0 (skip)
    const wrapFwd = reducer(base({ open: true, field: 41, preRefineSeconds: 10 }), {
      type: 'settingsValueChange',
      delta: 1,
    });
    expect(wrapFwd.settingsPicker.preRefineSeconds).toBe(0);

    // Backward from 0 (skip) wraps to 10 (last)
    const wrapBwd = reducer(base({ open: true, field: 41, preRefineSeconds: 0 }), {
      type: 'settingsValueChange',
      delta: -1,
    });
    expect(wrapBwd.settingsPicker.preRefineSeconds).toBe(10);
  });

  it('settingsFieldSet jumps directly to an arbitrary field (Ctrl+M target)', () => {
    // Simulates Ctrl+M dispatching `settingsFieldSet` with the multi-diff
    // summary row's index. Guards against drift between
    // MULTI_DIFF_SUMMARY_THRESHOLD_FIELD (settings-picker.tsx) and the
    // actual field order in the reducer's switch.
    const s = reducer(base({ open: true, field: 0 }), { type: 'settingsFieldSet', field: 21 });
    expect(s.settingsPicker.field).toBe(21);
  });

  it('settingsFieldSet clamps out-of-range fields to 0', () => {
    const s = reducer(base({ open: true, field: 5 }), { type: 'settingsFieldSet', field: 999 });
    expect(s.settingsPicker.field).toBe(0);
  });

  it('settingsFieldSet accepts every registered jump-chord target', () => {
    // Each modifier+<letter> chord in settings-picker.tsx dispatches
    // settingsFieldSet with a specific field index. This spot-checks every
    // target so a row reorder in the picker that breaks a jump surfaces as
    // a failing test rather than a silent land-on-row-0.
    for (const target of [0, 3, 5, 6, 13, 17, 20, 21, 22, 23, 29, 30, 31, 32, 33, 34, 35]) {
      const s = reducer(base({ open: true, field: 0 }), {
        type: 'settingsFieldSet',
        field: target,
      });
      expect(s.settingsPicker.field).toBe(target);
    }
  });
});

describe('Monitor overlays do not block input buffer mutations', () => {
  // Regression: F2 (fleet), F3 (agents), F4 (worktree), F6 (todos), F7 (queue)
  // and the goalRun monitor used to make handleKey swallow every keystroke
  // except F-keys and Esc, so typing into the chat input behind the panel
  // silently failed. The guard was removed; the reducer is now the only
  // place that decides whether a `setBuffer` action takes effect, and it
  // must accept the action regardless of overlay state.
  it('setBuffer still mutates the buffer when every monitor overlay is open', () => {
    const overlayKeys = [
      'monitorOpen',
      'agentsMonitorOpen',
      'worktreeMonitorOpen',
      'todosMonitorOpen',
      'queuePanelOpen',
    ] as const;

    for (const key of overlayKeys) {
      const closed: Record<string, unknown> = { monitorOpen: false };
      // Build a baseline state that mirrors what App.tsx feeds to handleKey:
      // the overlay under test is open, every other overlay is closed.
      for (const k of overlayKeys) closed[k] = false;
      closed[key] = true;

      const typed = reducer({ ...initial(), ...closed } as Parameters<typeof reducer>[0], {
        type: 'setBuffer',
        buffer: 'hello world',
        cursor: 11,
      });
      expect(typed.buffer, `setBuffer should work while ${key} is true`).toBe('hello world');
      expect(typed.cursor).toBe(11);
    }
  });

  it('setBuffer still mutates the buffer when goalRun monitor is open', () => {
    const s = reducer(
      {
        ...initial(),
        goalRun: {
          title: 't',
          phases: {},
          runningPhaseIds: [],
          elapsedMs: 0,
          monitorOpen: true,
        },
      } as Parameters<typeof reducer>[0],
      { type: 'setBuffer', buffer: 'draft text', cursor: 10 },
    );
    expect(s.buffer).toBe('draft text');
    expect(s.cursor).toBe(10);
  });

  it('clearInput resets the buffer even when a monitor overlay is open', () => {
    const dirty: Record<string, unknown> = {
      monitorOpen: false,
      agentsMonitorOpen: false,
      worktreeMonitorOpen: false,
      todosMonitorOpen: false,
      queuePanelOpen: false,
    };
    dirty.monitorOpen = true;
    const s = reducer(
      {
        ...initial(),
        ...dirty,
        buffer: 'leftover draft',
        cursor: 14,
        historyIndex: 1,
      } as Parameters<typeof reducer>[0],
      { type: 'clearInput' },
    );
    expect(s.buffer).toBe('');
    expect(s.cursor).toBe(0);
    expect(s.historyIndex).toBe(0);
  });

  it('computes Ctrl+Arrow and Ctrl+word-delete targets across whitespace runs', () => {
    const buffer = 'alpha  beta\tgamma';
    expect(previousInputWordStart(buffer, buffer.length)).toBe(12);
    expect(previousInputWordStart(buffer, 12)).toBe(7);
    expect(previousInputWordStart(buffer, 7)).toBe(0);
    expect(nextInputWordStart(buffer, 0)).toBe(7);
    expect(nextInputWordStart(buffer, 7)).toBe(12);
    expect(nextInputWordStart(buffer, 12)).toBe(buffer.length);

    const backspaceFromEnd = previousInputWordStart(buffer, buffer.length);
    expect(buffer.slice(0, backspaceFromEnd) + buffer.slice(buffer.length)).toBe('alpha  beta\t');
    const deleteFromStart = nextInputWordStart(buffer, 0);
    expect(buffer.slice(0, 0) + buffer.slice(deleteFromStart)).toBe('beta\tgamma');
  });

  it('treats pasted/file/image chips as one word-navigation and word-delete unit', () => {
    const chip = '[pasted #3, 10 lines]';
    const buffer = `alpha ${chip} beta`;
    const chipStart = 'alpha '.length;
    const chipEnd = chipStart + chip.length;
    expect(nextInputWordStart(buffer, chipStart)).toBe(chipEnd + 1);
    expect(previousInputWordStart(buffer, chipEnd)).toBe(chipStart);

    expect(buffer.slice(0, chipStart) + buffer.slice(nextInputWordStart(buffer, chipStart))).toBe(
      'alpha beta',
    );
    expect(buffer.slice(0, previousInputWordStart(buffer, chipEnd)) + buffer.slice(chipEnd)).toBe(
      'alpha  beta',
    );
  });
});

describe('goalRun board reducer', () => {
  function withPhase() {
    return reducer(
      initial() as never,
      {
        type: 'goalRunPhaseUpdate',
        phaseId: 'p1',
        name: 'Alpha',
        status: 'running',
        completedTasks: 0,
        totalTasks: 2,
      } as never,
    );
  }

  it('goalRunTaskActive adds a live worker to its phase', () => {
    let s = withPhase();
    s = reducer(s, {
      type: 'goalRunTaskActive',
      phaseId: 'p1',
      taskId: 't1',
      title: 'Build login',
      agent: 'Einstein',
      active: true,
    } as never);
    const active = (
      s as never as {
        goalRun: {
          phases: Record<string, { activeTasks?: Array<{ taskId: string; agent?: string }> }>;
        };
      }
    ).goalRun.phases['p1']!.activeTasks;
    expect(active).toEqual([{ taskId: 't1', title: 'Build login', agent: 'Einstein' }]);
  });

  it('goalRunPhaseUpdate preserves activeTasks across status/count updates', () => {
    let s = withPhase();
    s = reducer(s, {
      type: 'goalRunTaskActive',
      phaseId: 'p1',
      taskId: 't1',
      title: 'Build login',
      agent: 'Einstein',
      active: true,
    } as never);
    // A later count update (e.g. taskCompleted) must not wipe live workers.
    s = reducer(s, {
      type: 'goalRunPhaseUpdate',
      phaseId: 'p1',
      name: 'Alpha',
      status: 'running',
      completedTasks: 1,
      totalTasks: 2,
    } as never);
    const phase = (
      s as never as {
        goalRun: { phases: Record<string, { completedTasks: number; activeTasks?: unknown[] }> };
      }
    ).goalRun.phases['p1']!;
    expect(phase.completedTasks).toBe(1);
    expect(phase.activeTasks).toHaveLength(1);
  });

  it('goalRunTaskActive with active:false removes the worker', () => {
    let s = withPhase();
    s = reducer(s, {
      type: 'goalRunTaskActive',
      phaseId: 'p1',
      taskId: 't1',
      title: 'x',
      agent: 'Tesla',
      active: true,
    } as never);
    s = reducer(s, {
      type: 'goalRunTaskActive',
      phaseId: 'p1',
      taskId: 't1',
      title: '',
      active: false,
    } as never);
    const active = (
      s as never as { goalRun: { phases: Record<string, { activeTasks?: unknown[] }> } }
    ).goalRun.phases['p1']!.activeTasks;
    expect(active).toEqual([]);
  });
});

describe('sendModePicker reducer', () => {
  const openInfo = {
    selected: 0,
    text: 'fix the test',
    displayText: 'fix the test',
    blocks: [],
    resolve: () => {},
  };

  it('open stores the picker info; close clears it', () => {
    let s = reducer(initial() as never, { type: 'sendModePickerOpen', info: openInfo } as never);
    expect((s as never as { sendModePicker: unknown }).sendModePicker).not.toBeNull();
    s = reducer(s, { type: 'sendModePickerClose' } as never);
    expect((s as never as { sendModePicker: unknown }).sendModePicker).toBeNull();
  });

  it('move wraps the selection across the 3 options', () => {
    let s = reducer(initial() as never, { type: 'sendModePickerOpen', info: openInfo } as never);
    const sel = () =>
      (s as never as { sendModePicker: { selected: number } }).sendModePicker.selected;
    s = reducer(s, { type: 'sendModePickerMove', delta: 1 } as never);
    expect(sel()).toBe(1);
    s = reducer(s, { type: 'sendModePickerMove', delta: 1 } as never);
    expect(sel()).toBe(2);
    s = reducer(s, { type: 'sendModePickerMove', delta: 1 } as never);
    expect(sel()).toBe(0);
    s = reducer(s, { type: 'sendModePickerMove', delta: -1 } as never);
    expect(sel()).toBe(2);
  });

  it('move is a no-op when no picker is open', () => {
    const s = reducer(initial() as never, { type: 'sendModePickerMove', delta: 1 } as never);
    expect((s as never as { sendModePicker: unknown }).sendModePicker).toBeNull();
  });
});
