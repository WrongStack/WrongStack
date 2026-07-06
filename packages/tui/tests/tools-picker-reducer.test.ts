// Tests for the tools picker reducer cases. The picker is opened by `/tools`
// via the slash-command → onPanelOpen dispatch bridge; these tests pin down
// the state-mutation contract that bridge depends on.
//
// Coverage:
//   - toolsPickerOpen            → opens, closes siblings, busy when items=[]
//   - toolsPickerOpen + items    → seeds items and clamps selected
//   - toolsPickerClose           → closes, clears busy, clears filter
//   - toolsPickerMove            → wrap-around on empty (no-op) and non-empty
//   - toolsPickerSetItems        → replaces items and busy=false
//   - toolsPickerToggle          → no-op (handled by host)
//   - toolsPickerBusy            → toggles busy
//   - toolsPickerHint            → sets hint text (and clears it)
//   - toolsPickerFilter          → sets inline search filter, preserves items

import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app.js';
import type { State } from '../src/app-state.js';
import type { ToolPickerItem } from '../src/components/tools-picker.js';

function item(name: string, enabled = true, category = 'Core'): ToolPickerItem {
  return {
    name,
    owner: 'core',
    category,
    enabled,
    mutating: false,
    permission: 'allow',
    descMode: 'extend',
    description: `${name} test row`,
  };
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
    streamFleet: true,
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
    toolsPicker: { open: false, items: [], selected: 0, busy: false, hint: undefined, filter: undefined },
    authPanel: { open: false, view: 'list', providers: [], presets: [], busy: false, selected: 0, filter: '', catalog: [], catalogFilter: '', input: null, confirm: null, flowLog: [] },
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
    autoPhase: null,
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
      open: false, field: 0, lastSettingsField: 0,
      mode: 'off', delayMs: 0, titleAnimation: true, yolo: false,
      streamFleet: false, chime: false, confirmExit: true,
      nextPrediction: false, featureMcp: true, featurePlugins: true,
      featureMemory: true, featureSkills: true, featureModelsRegistry: true,
      tokenSavingTier: 'off', allowOutsideProjectRoot: true,
      contextAutoCompact: true, contextStrategy: 'hybrid', contextMode: 'balanced',
      maxConcurrent: 4, logLevel: 'info', auditLevel: 'standard',
      indexOnStart: true, multiDiffSummaryThreshold: 5,
      maxIterations: 500, autoProceedMaxIterations: 50,
      enhanceDelayMs: 60000, enhanceEnabled: true, enhanceLanguage: 'original',
      debugStream: false, statuslineMode: 'detailed',
      reasoningMode: 'auto', reasoningEffort: 'high', reasoningPreserve: false,
      thinkingWord: 'thinking', cacheTtl: 'default', configScope: 'global',
      animationStyle: 'rainbow', filter: undefined, hint: undefined,
    },
    statuslinePicker: { open: false, field: 0, hiddenItems: [], visibleChips: [], hint: undefined },
    scrollOffset: 0,
    totalLines: 0,
    viewportRows: 0,
    pendingNewLines: 0,
    debugStreamStats: null,
    countdown: null,
    ...over,
  } as State;
}

describe('toolsPicker reducer — open/close', () => {
  it('opens the picker and sets busy when no items provided', () => {
    const s = reducer(initial(), {
      type: 'toolsPickerOpen',
    } as never) as unknown as {
      toolsPicker: { open: boolean; busy: boolean; items: ToolPickerItem[]; filter?: string };
    };
    expect(s.toolsPicker.open).toBe(true);
    expect(s.toolsPicker.busy).toBe(true);
    expect(s.toolsPicker.items).toEqual([]);
    expect(s.toolsPicker.filter).toBeUndefined();
  });

  it('closes sibling panels so the picker owns the screen', () => {
    const s = reducer(
      initial({ helpOpen: true, monitorOpen: true }) as never,
      {
        type: 'toolsPickerOpen',
        items: [item('read'), item('write')],
      } as never,
    ) as unknown as {
      helpOpen: boolean;
      monitorOpen: boolean;
      toolsPicker: { open: boolean; busy: boolean };
    };
    expect(s.helpOpen).toBe(false);
    expect(s.monitorOpen).toBe(false);
    expect(s.toolsPicker.open).toBe(true);
    expect(s.toolsPicker.busy).toBe(false);
  });

  it('seeds items and clamps selected at the last index', () => {
    const s = reducer(
      initial() as never,
      {
        type: 'toolsPickerOpen',
        items: [item('a'), item('b'), item('c')],
      } as never,
    ) as unknown as {
      toolsPicker: { items: ToolPickerItem[]; selected: number; busy: boolean };
    };
    expect(s.toolsPicker.items.map((i) => i.name)).toEqual(['a', 'b', 'c']);
    expect(s.toolsPicker.busy).toBe(false);
    expect(s.toolsPicker.selected).toBe(0);
  });

  it('toolsPickerClose flips open=false busy=false and clears filter', () => {
    const opened = reducer(
      initial() as never,
      { type: 'toolsPickerOpen', items: [item('a')] } as never,
    ) as unknown as { toolsPicker: { open: boolean; busy: boolean; filter?: string } };
    expect(opened.toolsPicker.open).toBe(true);

    const closed = reducer(
      opened as never,
      { type: 'toolsPickerClose' } as never,
    ) as unknown as { toolsPicker: { open: boolean; busy: boolean; filter?: string } };
    expect(closed.toolsPicker.open).toBe(false);
    expect(closed.toolsPicker.busy).toBe(false);
    expect(closed.toolsPicker.filter).toBeUndefined();
  });
});

describe('toolsPicker reducer — navigation', () => {
  function openWith(items: ToolPickerItem[]): State {
    return reducer(
      initial() as never,
      { type: 'toolsPickerOpen', items } as never,
    ) as unknown as State;
  }

  it('move is a no-op when the picker is empty', () => {
    const before = initial();
    const after = reducer(
      before as never,
      { type: 'toolsPickerMove', delta: 1 } as never,
    ) as unknown as State;
    expect(after).toBe(before);
  });

  it('move wraps forward across the items list', () => {
    let s = openWith([item('a'), item('b'), item('c')]);
    const sel = () =>
      (s as unknown as { toolsPicker: { selected: number } }).toolsPicker.selected;
    s = reducer(s as never, { type: 'toolsPickerMove', delta: 1 } as never) as unknown as State;
    expect(sel()).toBe(1);
    s = reducer(s as never, { type: 'toolsPickerMove', delta: 1 } as never) as unknown as State;
    expect(sel()).toBe(2);
    s = reducer(s as never, { type: 'toolsPickerMove', delta: 1 } as never) as unknown as State;
    expect(sel()).toBe(0); // wraps to first
  });

  it('move wraps backward past the first item', () => {
    let s = openWith([item('a'), item('b')]);
    const sel = () =>
      (s as unknown as { toolsPicker: { selected: number } }).toolsPicker.selected;
    s = reducer(s as never, { type: 'toolsPickerMove', delta: -1 } as never) as unknown as State;
    expect(sel()).toBe(1);
  });

  it('move clears hint on every navigation', () => {
    let s = openWith([item('a'), item('b')]);
    s = reducer(s as never, { type: 'toolsPickerHint', text: 'some hint' } as never) as unknown as State;
    const withHint = () =>
      (s as unknown as { toolsPicker: { hint?: string } }).toolsPicker.hint;
    expect(withHint()).toBe('some hint');
    s = reducer(s as never, { type: 'toolsPickerMove', delta: 1 } as never) as unknown as State;
    expect(withHint()).toBeUndefined();
  });
});

describe('toolsPicker reducer — items / busy / hint / filter', () => {
  it('setItems replaces the items list and clears busy', () => {
    const opened = reducer(
      initial() as never,
      { type: 'toolsPickerOpen' } as never,
    ) as unknown as State;
    const s = reducer(
      opened as never,
      {
        type: 'toolsPickerSetItems',
        items: [item('read'), item('write')],
      } as never,
    ) as unknown as {
      toolsPicker: { items: ToolPickerItem[]; busy: boolean };
    };
    expect(s.toolsPicker.items.map((i) => i.name)).toEqual(['read', 'write']);
    expect(s.toolsPicker.busy).toBe(false);
  });

  it('setItems clamps selected when item count shrinks', () => {
    let s = openWith([item('a'), item('b'), item('c')]);
    s = reducer(s as never, { type: 'toolsPickerMove', delta: 2 } as never) as unknown as State;
    const sel = () =>
      (s as unknown as { toolsPicker: { selected: number } }).toolsPicker.selected;
    expect(sel()).toBe(2); // moved to third item
    s = reducer(
      s as never,
      { type: 'toolsPickerSetItems', items: [item('x')] } as never,
    ) as unknown as State;
    expect(sel()).toBe(0); // clamped
  });

  it('toolsPickerToggle is a no-op in the reducer', () => {
    const s = reducer(
      initial() as never,
      { type: 'toolsPickerToggle' } as never,
    ) as unknown as State;
    // The toggle action is handled by the host callback; reducer returns state unchanged.
    expect(s).toStrictEqual(initial());
  });

  it('busy toggles only the busy flag, preserves other picker state', () => {
    const opened = reducer(
      initial() as never,
      { type: 'toolsPickerOpen', items: [item('a')] } as never,
    ) as unknown as { toolsPicker: { busy: boolean; open: boolean } };
    expect(opened.toolsPicker.busy).toBe(false);

    const busy = reducer(
      opened as never,
      { type: 'toolsPickerBusy', busy: true } as never,
    ) as unknown as { toolsPicker: { busy: boolean; open: boolean } };
    expect(busy.toolsPicker.busy).toBe(true);
    expect(busy.toolsPicker.open).toBe(true);
  });

  it('hint sets and clears row guidance text', () => {
    const opened = reducer(
      initial() as never,
      { type: 'toolsPickerOpen', items: [item('a')] } as never,
    ) as unknown as { toolsPicker: { hint?: string } };

    const withHint = reducer(
      opened as never,
      { type: 'toolsPickerHint', text: 'Now disabled' } as never,
    ) as unknown as { toolsPicker: { hint?: string } };
    expect(withHint.toolsPicker.hint).toBe('Now disabled');

    const cleared = reducer(
      withHint as never,
      { type: 'toolsPickerHint' } as never,
    ) as unknown as { toolsPicker: { hint?: string } };
    expect(cleared.toolsPicker.hint).toBeUndefined();
  });

  it('filter sets the inline search string', () => {
    const opened = reducer(
      initial() as never,
      { type: 'toolsPickerOpen', items: [item('read'), item('write')] } as never,
    ) as unknown as { toolsPicker: { filter?: string } };

    const filtered = reducer(
      opened as never,
      { type: 'toolsPickerFilter', filter: 'read' } as never,
    ) as unknown as { toolsPicker: { filter?: string } };
    expect(filtered.toolsPicker.filter).toBe('read');
  });

  it('filter can be empty string to clear', () => {
    let s = reducer(
      initial() as never,
      { type: 'toolsPickerOpen', items: [item('a')] } as never,
    ) as unknown as State;
    s = reducer(s as never, { type: 'toolsPickerFilter', filter: 'hello' } as never) as unknown as State;
    s = reducer(s as never, { type: 'toolsPickerFilter', filter: '' } as never) as unknown as {
      toolsPicker: { filter?: string };
    };
    expect(s.toolsPicker.filter).toBe('');
  });

  it('filter does not affect other state fields', () => {
    const opened = reducer(
      initial() as never,
      { type: 'toolsPickerOpen', items: [item('bash'), item('read')] } as never,
    ) as unknown as {
      toolsPicker: { items: ToolPickerItem[]; selected: number; open: boolean; filter?: string };
    };
    expect(opened.toolsPicker.items.length).toBe(2);
    expect(opened.toolsPicker.selected).toBe(0);

    const filtered = reducer(
      opened as never,
      { type: 'toolsPickerFilter', filter: 'bash' } as never,
    ) as unknown as {
      toolsPicker: { items: ToolPickerItem[]; selected: number; open: boolean; filter?: string };
    };
    expect(filtered.toolsPicker.items.length).toBe(2); // items unchanged
    expect(filtered.toolsPicker.selected).toBe(0); // selected unchanged
    expect(filtered.toolsPicker.open).toBe(true);
  });
});

// Helper to open a picker with items (used by multi-case tests)
function openWith(items: ToolPickerItem[]): State {
  return reducer(
    initial() as never,
    { type: 'toolsPickerOpen', items } as never,
  ) as unknown as State;
}
