// Tests for the MCP picker reducer cases. The picker is opened by `/mcp`
// via the slash-command → onPanelOpen dispatch bridge; these tests pin down
// the state-mutation contract that bridge depends on.
//
// Coverage:
//   - mcpPickerOpen             → opens, closes siblings, busy when items=[]
//   - mcpPickerOpen + items     → seeds items and clamps selected
//   - mcpPickerClose            → closes, clears busy
//   - mcpPickerMove             → wrap-around on empty (no-op) and non-empty
//   - mcpPickerSetItems         → replaces items and busy=false
//   - mcpPickerBusy             → toggles busy
//   - mcpPickerHint             → sets hint text (and clears it)

import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app.js';
import type { State } from '../src/app-state.js';
import type { McpPickerItem } from '../src/components/mcp-picker.js';

function item(name: string, enabled = true, status = 'connected'): McpPickerItem {
  return {
    name,
    enabled,
    status,
    transport: 'stdio',
    description: `${name} MCP server`,
    toolCount: 3,
    lazy: false,
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

describe('mcpPicker reducer — open/close', () => {
  it('opens the picker and sets busy when no items provided', () => {
    const s = reducer(initial(), {
      type: 'mcpPickerOpen',
    } as never) as unknown as {
      mcpPicker: { open: boolean; busy: boolean; items: McpPickerItem[] };
    };
    expect(s.mcpPicker.open).toBe(true);
    expect(s.mcpPicker.busy).toBe(true);
    expect(s.mcpPicker.items).toEqual([]);
  });

  it('closes sibling panels so the picker owns the screen', () => {
    const s = reducer(
      initial({ helpOpen: true, monitorOpen: true }) as never,
      {
        type: 'mcpPickerOpen',
        items: [item('github'), item('filesystem')],
      } as never,
    ) as unknown as {
      helpOpen: boolean;
      monitorOpen: boolean;
      mcpPicker: { open: boolean; busy: boolean };
    };
    expect(s.helpOpen).toBe(false);
    expect(s.monitorOpen).toBe(false);
    expect(s.mcpPicker.open).toBe(true);
    expect(s.mcpPicker.busy).toBe(false);
  });

  it('seeds items and clamps selected at the last index', () => {
    const s = reducer(
      initial() as never,
      {
        type: 'mcpPickerOpen',
        items: [item('a'), item('b'), item('c')],
      } as never,
    ) as unknown as {
      mcpPicker: { items: McpPickerItem[]; selected: number; busy: boolean };
    };
    expect(s.mcpPicker.items.map((i) => i.name)).toEqual(['a', 'b', 'c']);
    expect(s.mcpPicker.busy).toBe(false);
    expect(s.mcpPicker.selected).toBe(0);
  });

  it('mcpPickerClose flips open=false and busy=false', () => {
    const opened = reducer(
      initial() as never,
      { type: 'mcpPickerOpen', items: [item('a')] } as never,
    ) as unknown as { mcpPicker: { open: boolean; busy: boolean } };
    expect(opened.mcpPicker.open).toBe(true);

    const closed = reducer(opened as never, { type: 'mcpPickerClose' } as never) as unknown as {
      mcpPicker: { open: boolean; busy: boolean };
    };
    expect(closed.mcpPicker.open).toBe(false);
    expect(closed.mcpPicker.busy).toBe(false);
  });
});

describe('mcpPicker reducer — navigation', () => {
  function openWith(items: McpPickerItem[]): State {
    return reducer(
      initial() as never,
      { type: 'mcpPickerOpen', items } as never,
    ) as unknown as State;
  }

  it('move is a no-op when the picker is empty', () => {
    const before = initial();
    const after = reducer(
      before as never,
      { type: 'mcpPickerMove', delta: 1 } as never,
    ) as unknown as State;
    expect(after).toBe(before);
  });

  it('move wraps forward across the items list', () => {
    let s = openWith([item('a'), item('b'), item('c')]);
    const sel = () => (s as unknown as { mcpPicker: { selected: number } }).mcpPicker.selected;
    s = reducer(s as never, { type: 'mcpPickerMove', delta: 1 } as never) as unknown as State;
    expect(sel()).toBe(1);
    s = reducer(s as never, { type: 'mcpPickerMove', delta: 1 } as never) as unknown as State;
    expect(sel()).toBe(2);
    s = reducer(s as never, { type: 'mcpPickerMove', delta: 1 } as never) as unknown as State;
    expect(sel()).toBe(0); // wraps to first
  });

  it('move wraps backward past the first item', () => {
    let s = openWith([item('a'), item('b')]);
    const sel = () => (s as unknown as { mcpPicker: { selected: number } }).mcpPicker.selected;
    s = reducer(s as never, { type: 'mcpPickerMove', delta: -1 } as never) as unknown as State;
    expect(sel()).toBe(1);
  });

  it('move clears hint on every navigation', () => {
    let s = openWith([item('a'), item('b')]);
    s = reducer(
      s as never,
      { type: 'mcpPickerHint', text: 'restarting…' } as never,
    ) as unknown as State;
    const withHint = () => (s as unknown as { mcpPicker: { hint?: string } }).mcpPicker.hint;
    expect(withHint()).toBe('restarting…');
    s = reducer(s as never, { type: 'mcpPickerMove', delta: 1 } as never) as unknown as State;
    expect(withHint()).toBeUndefined();
  });
});

describe('mcpPicker reducer — items / busy / hint', () => {
  function openWith(items: McpPickerItem[]): State {
    return reducer(
      initial() as never,
      { type: 'mcpPickerOpen', items } as never,
    ) as unknown as State;
  }

  it('setItems replaces the items list and clears busy', () => {
    const opened = reducer(
      initial() as never,
      { type: 'mcpPickerOpen' } as never,
    ) as unknown as State;
    const s = reducer(
      opened as never,
      {
        type: 'mcpPickerSetItems',
        items: [item('github'), item('filesystem')],
      } as never,
    ) as unknown as {
      mcpPicker: { items: McpPickerItem[]; busy: boolean };
    };
    expect(s.mcpPicker.items.map((i) => i.name)).toEqual(['github', 'filesystem']);
    expect(s.mcpPicker.busy).toBe(false);
  });

  it('setItems clamps selected when item count shrinks', () => {
    let s = openWith([item('a'), item('b'), item('c')]);
    s = reducer(s as never, { type: 'mcpPickerMove', delta: 2 } as never) as unknown as State;
    const sel = () => (s as unknown as { mcpPicker: { selected: number } }).mcpPicker.selected;
    expect(sel()).toBe(2); // moved to third item
    s = reducer(
      s as never,
      { type: 'mcpPickerSetItems', items: [item('x')] } as never,
    ) as unknown as State;
    expect(sel()).toBe(0); // clamped
  });

  it('busy toggles only the busy flag, preserves other picker state', () => {
    const opened = reducer(
      initial() as never,
      { type: 'mcpPickerOpen', items: [item('a')] } as never,
    ) as unknown as { mcpPicker: { busy: boolean; open: boolean } };
    expect(opened.mcpPicker.busy).toBe(false);

    const busy = reducer(
      opened as never,
      { type: 'mcpPickerBusy', busy: true } as never,
    ) as unknown as { mcpPicker: { busy: boolean; open: boolean } };
    expect(busy.mcpPicker.busy).toBe(true);
    expect(busy.mcpPicker.open).toBe(true);
  });

  it('hint sets and clears row guidance text', () => {
    const opened = reducer(
      initial() as never,
      { type: 'mcpPickerOpen', items: [item('a')] } as never,
    ) as unknown as { mcpPicker: { hint?: string } };

    const withHint = reducer(
      opened as never,
      { type: 'mcpPickerHint', text: 'Restarted.' } as never,
    ) as unknown as { mcpPicker: { hint?: string } };
    expect(withHint.mcpPicker.hint).toBe('Restarted.');

    const cleared = reducer(withHint as never, { type: 'mcpPickerHint' } as never) as unknown as {
      mcpPicker: { hint?: string };
    };
    expect(cleared.mcpPicker.hint).toBeUndefined();
  });
});
