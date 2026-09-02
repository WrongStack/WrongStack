// Tests for the Brain panel reducer cases. The panel is opened by `/brain`
// via the slash-command → onPanelOpen dispatch bridge; these tests pin down
// the state-mutation contract that bridge depends on.
//
// Coverage:
//   - brainOpen              → opens, closes siblings, seeds riskLevel + log
//   - brainClose             → closes
//   - brainMove              → wrap-around on empty (no-op) and non-empty
//   - brainRiskChange        → cycles risk levels bidirectionally
//   - brainSetLog            → replaces log, clamps selected
//   - brainHint              → sets hint text (and clears it)

import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app.js';
import type { State } from '../src/app-state.js';
import type { BrainLogEntry, BrainRiskLevel } from '../src/components/brain-panel.js';

function logEntry(kind = 'tool', question = 'test question', outcome = 'approved'): BrainLogEntry {
  return { kind, question, outcome, age: '30s' };
}

function initial(over: Partial<State> = {}): State {
  return {
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
    brain: { state: 'idle' as const },
    brainPrompt: null,
    nextId: 1,
    historyGen: 0,
    picker: { open: false, query: '', matches: [], selected: 0 },
    slashPicker: { open: false, query: '', matches: [], selected: 0 },
    runningTools: new Map(),
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
    auditPanelOpen: false,
    kanbanPanelOpen: false,
    planPanelOpen: false,
    goalPanelOpen: false,
    worktreeMonitorOpen: false,
    sessionsPanelOpen: false,
    sessionsPanel: { sessions: [], busy: false, selected: -1 },
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
    brainPanel: {
      open: false,
      riskLevel: 'medium',
      log: [],
      selected: 0,
      hint: undefined,
    },
    authPanel: {
      open: false,
      view: 'list',
      providers: [],
      presets: [],
      busy: false,
      selected: 0,
      filter: '',
      catalog: [],
      catalogFilter: '',
      input: null,
      confirm: null,
      flowLog: [],
    },
    projectPicker: {
      open: false,
      allItems: [],
      items: [],
      selected: 0,
      filter: '',
      hint: undefined,
    },
    fKeyPicker: { open: false, selected: 0 },
    sessionResumeConfirm: null,
    collabSession: null,
    checkpoints: [],
    rewindOverlay: null,
    eternalStage: null,
    goalSummary: null,
    goalRun: null,
    sddBoard: null,
    worktrees: {},
    coordinator: {
      goals: [],
      timeline: [],
      knowledgeCount: 0,
      monitorOpen: false,
      healthy: false,
    },
    settingsPicker: {
      open: false,
      field: 0,
      lastSettingsField: 0,
      mode: 'off',
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
      tokenSavingTier: 'off',
      allowOutsideProjectRoot: true,
      contextAutoCompact: true,
      contextStrategy: 'hybrid',
      contextMode: 'balanced',
      maxConcurrent: 4,
      logLevel: 'info',
      auditLevel: 'standard',
      indexOnStart: true,
      multiDiffSummaryThreshold: 5,
      maxIterations: 500,
      autoProceedMaxIterations: 50,
      enhanceDelayMs: 60000,
      enhanceEnabled: true,
      enhanceLanguage: 'original',
      debugStream: false,
      statuslineMode: 'detailed',
      reasoningMode: 'auto',
      reasoningEffort: 'high',
      reasoningPreserve: false,
      thinkingWord: 'thinking',
      cacheTtl: 'default',
      configScope: 'global',
      animationStyle: 'rainbow',
      filter: undefined,
      hint: undefined,
    },
    statuslinePicker: { open: false, field: 0, hiddenItems: [], visibleChips: [], hint: undefined },
    viewportRows: 0,
    historyScrolled: false,
    debugStreamStats: null,
    countdown: null,
    ...over,
  } as State;
}

describe('brainPanel reducer — open/close', () => {
  it('opens the panel with riskLevel and log from the action', () => {
    const s = reducer(
      initial() as never,
      {
        type: 'brainOpen',
        riskLevel: 'high',
        log: [logEntry('tool', 'Allow write to /etc?', 'denied')],
      } as never,
    ) as unknown as {
      brainPanel: {
        open: boolean;
        riskLevel: string;
        log: BrainLogEntry[];
        selected: number;
        hint?: string;
      };
    };
    expect(s.brainPanel.open).toBe(true);
    expect(s.brainPanel.riskLevel).toBe('high');
    expect(s.brainPanel.log).toHaveLength(1);
    expect(s.brainPanel.log[0]?.question).toBe('Allow write to /etc?');
    expect(s.brainPanel.selected).toBe(0);
    expect(s.brainPanel.hint).toBeUndefined();
  });

  it('closes sibling panels so the panel owns the screen', () => {
    const s = reducer(
      initial({ helpOpen: true, monitorOpen: true }) as never,
      {
        type: 'brainOpen',
        riskLevel: 'low',
        log: [],
      } as never,
    ) as unknown as { helpOpen: boolean; monitorOpen: boolean };
    expect(s.helpOpen).toBe(false);
    expect(s.monitorOpen).toBe(false);
  });

  it('brainClose flips open=false', () => {
    const opened = reducer(
      initial() as never,
      { type: 'brainOpen', riskLevel: 'medium', log: [] } as never,
    ) as unknown as { brainPanel: { open: boolean } };
    expect(opened.brainPanel.open).toBe(true);

    const closed = reducer(opened as never, { type: 'brainClose' } as never) as unknown as {
      brainPanel: { open: boolean };
    };
    expect(closed.brainPanel.open).toBe(false);
  });
});

describe('brainPanel reducer — navigation', () => {
  function openWith(log: BrainLogEntry[]): State {
    return reducer(
      initial() as never,
      { type: 'brainOpen', riskLevel: 'medium', log } as never,
    ) as unknown as State;
  }

  it('move is a no-op when the log is empty', () => {
    const before = initial();
    const after = reducer(
      before as never,
      { type: 'brainMove', delta: 1 } as never,
    ) as unknown as State;
    expect(after).toBe(before);
  });

  it('move wraps forward across log entries', () => {
    let s = openWith([logEntry('a'), logEntry('b'), logEntry('c')]);
    const sel = () => (s as unknown as { brainPanel: { selected: number } }).brainPanel.selected;
    s = reducer(s as never, { type: 'brainMove', delta: 1 } as never) as unknown as State;
    expect(sel()).toBe(1);
    s = reducer(s as never, { type: 'brainMove', delta: 1 } as never) as unknown as State;
    expect(sel()).toBe(2);
    s = reducer(s as never, { type: 'brainMove', delta: 1 } as never) as unknown as State;
    expect(sel()).toBe(0); // wraps to first
  });

  it('move wraps backward past the first entry', () => {
    let s = openWith([logEntry('a'), logEntry('b')]);
    const sel = () => (s as unknown as { brainPanel: { selected: number } }).brainPanel.selected;
    s = reducer(s as never, { type: 'brainMove', delta: -1 } as never) as unknown as State;
    expect(sel()).toBe(1);
  });

  it('move clears hint on every navigation', () => {
    let s = openWith([logEntry('a')]);
    s = reducer(s as never, { type: 'brainHint', text: 'hint text' } as never) as unknown as State;
    expect((s as unknown as { brainPanel: { hint?: string } }).brainPanel.hint).toBe('hint text');
    s = reducer(s as never, { type: 'brainMove', delta: 1 } as never) as unknown as State;
    expect((s as unknown as { brainPanel: { hint?: string } }).brainPanel.hint).toBeUndefined();
  });
});

describe('brainPanel reducer — risk change (cycling)', () => {
  function openedWith(riskLevel: BrainRiskLevel): State {
    return reducer(
      initial() as never,
      { type: 'brainOpen', riskLevel, log: [logEntry()] } as never,
    ) as unknown as State;
  }

  it('cycles forward through risk levels', () => {
    let s = openedWith('off');
    const risk = () =>
      (s as unknown as { brainPanel: { riskLevel: BrainRiskLevel } }).brainPanel.riskLevel;
    // off → low
    s = reducer(s as never, { type: 'brainRiskChange', delta: 1 } as never) as unknown as State;
    expect(risk()).toBe('low');
    // low → medium
    s = reducer(s as never, { type: 'brainRiskChange', delta: 1 } as never) as unknown as State;
    expect(risk()).toBe('medium');
    // medium → high
    s = reducer(s as never, { type: 'brainRiskChange', delta: 1 } as never) as unknown as State;
    expect(risk()).toBe('high');
    // high → all
    s = reducer(s as never, { type: 'brainRiskChange', delta: 1 } as never) as unknown as State;
    expect(risk()).toBe('all');
    // all → off (wraps)
    s = reducer(s as never, { type: 'brainRiskChange', delta: 1 } as never) as unknown as State;
    expect(risk()).toBe('off');
  });

  it('cycles backward through risk levels', () => {
    let s = openedWith('off');
    const risk = () =>
      (s as unknown as { brainPanel: { riskLevel: BrainRiskLevel } }).brainPanel.riskLevel;
    // off → all (wraps)
    s = reducer(s as never, { type: 'brainRiskChange', delta: -1 } as never) as unknown as State;
    expect(risk()).toBe('all');
    // all → high
    s = reducer(s as never, { type: 'brainRiskChange', delta: -1 } as never) as unknown as State;
    expect(risk()).toBe('high');
  });

  it('cycles from medium forward by 3 to all', () => {
    let s = openedWith('medium');
    const risk = () =>
      (s as unknown as { brainPanel: { riskLevel: BrainRiskLevel } }).brainPanel.riskLevel;
    // medium +3 → high(+1) → all(+2) → off(+3) - wait no.
    // medium +1 → high, +2 → all, +3 → off
    s = reducer(s as never, { type: 'brainRiskChange', delta: 3 } as never) as unknown as State;
    expect(risk()).toBe('off'); // medium→high→all→off
  });
});

describe('brainPanel reducer — setLog and hint', () => {
  function openWith(log: BrainLogEntry[]): State {
    return reducer(
      initial() as never,
      { type: 'brainOpen', riskLevel: 'medium', log } as never,
    ) as unknown as State;
  }

  it('setLog replaces the log and clamps selected', () => {
    let s = openWith([logEntry('a'), logEntry('b'), logEntry('c')]);
    // Navigate to last entry
    s = reducer(s as never, { type: 'brainMove', delta: 2 } as never) as unknown as State;
    const sel = () => (s as unknown as { brainPanel: { selected: number } }).brainPanel.selected;
    expect(sel()).toBe(2);

    // Shrink log to 1 entry
    s = reducer(
      s as never,
      { type: 'brainSetLog', log: [logEntry('x')] } as never,
    ) as unknown as State;
    expect(sel()).toBe(0);
    expect((s as unknown as { brainPanel: { log: BrainLogEntry[] } }).brainPanel.log).toHaveLength(
      1,
    );
  });

  it('setLog preserves riskLevel', () => {
    const opened = reducer(
      initial() as never,
      { type: 'brainOpen', riskLevel: 'all', log: [] } as never,
    ) as unknown as { brainPanel: { riskLevel: string } };
    expect(opened.brainPanel.riskLevel).toBe('all');

    const updated = reducer(
      opened as never,
      { type: 'brainSetLog', log: [logEntry()] } as never,
    ) as unknown as { brainPanel: { riskLevel: string; log: BrainLogEntry[] } };
    expect(updated.brainPanel.riskLevel).toBe('all');
    expect(updated.brainPanel.log).toHaveLength(1);
  });

  it('hint sets and clears text', () => {
    const opened = reducer(
      initial() as never,
      { type: 'brainOpen', riskLevel: 'medium', log: [] } as never,
    ) as unknown as { brainPanel: { hint?: string } };

    const withHint = reducer(
      opened as never,
      { type: 'brainHint', text: 'Risk ceiling → HIGH' } as never,
    ) as unknown as { brainPanel: { hint?: string } };
    expect(withHint.brainPanel.hint).toBe('Risk ceiling → HIGH');

    const cleared = reducer(withHint as never, { type: 'brainHint' } as never) as unknown as {
      brainPanel: { hint?: string };
    };
    expect(cleared.brainPanel.hint).toBeUndefined();
  });
});
