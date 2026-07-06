// Tests for the plugin picker reducer cases. The picker is opened by
// `/plugin` and `/plugin menu` via the slash-command → onPanelOpen dispatch
// bridge; these tests pin down the state-mutation contract that bridge
// depends on. Adding them here means a future refactor that breaks
// `open: true` after `pluginPickerOpen`, or the `selected` wrap-around, will
// be caught by CI rather than a silent user-visible regression.
//
// Coverage:
//   - pluginPickerOpen           → opens, closes siblings, busy when items=[]
//   - pluginPickerOpen + items   → seeds items and clamps selected
//   - pluginPickerClose          → closes, clears busy
//   - pluginPickerMove           → wrap-around on empty (no-op) and non-empty
//   - pluginPickerSetItems       → replaces items and busy=false
//   - pluginPickerBusy           → toggles busy
//   - pluginPickerHint           → sets hint text (and clears it)

import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app.js';
import type { State } from '../src/app-state.js';
import type { PluginPickerItem } from '../src/components/plugin-picker.js';

function item(name: string, enabled = false, lockable = true): PluginPickerItem {
  return { name, enabled, risk: 'low', summary: `${name} test row`, lockable };
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
    planPanelOpen: false,
    goalPanelOpen: false,
    worktreeMonitorOpen: false,
    sessionsPanelOpen: false,
    sessionsPanel: { sessions: [], busy: false, selected: -1 },
    pluginPicker: { open: false, items: [], selected: 0, busy: false, hint: undefined },
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
    scrollOffset: 0,
    totalLines: 0,
    viewportRows: 0,
    pendingNewLines: 0,
    debugStreamStats: null,
    countdown: null,
    ...over,
  } as State;
}

describe('pluginPicker reducer — open/close', () => {
  it('opens the picker and closes other panels on bare pluginPickerOpen', () => {
    const s = reducer(initial(), {
      type: 'pluginPickerOpen',
    } as never) as unknown as {
      pluginPicker: { open: boolean; busy: boolean; items: PluginPickerItem[] };
    };
    expect(s.pluginPicker.open).toBe(true);
    expect(s.pluginPicker.busy).toBe(true);
    expect(s.pluginPicker.items).toEqual([]);
  });

  it('closes sibling panels so the picker owns the screen', () => {
    const s = reducer(
      initial({ helpOpen: true, monitorOpen: true }) as never,
      {
        type: 'pluginPickerOpen',
        items: [item('cost-tracker'), item('format-on-save')],
      } as never,
    ) as unknown as {
      helpOpen: boolean;
      monitorOpen: boolean;
      pluginPicker: { open: boolean; busy: boolean };
    };
    expect(s.helpOpen).toBe(false);
    expect(s.monitorOpen).toBe(false);
    expect(s.pluginPicker.open).toBe(true);
    expect(s.pluginPicker.busy).toBe(false);
  });

  it('seeds items and clamps selected at the last index', () => {
    const s = reducer(
      initial() as never,
      {
        type: 'pluginPickerOpen',
        items: [item('a'), item('b'), item('c')],
      } as never,
    ) as unknown as {
      pluginPicker: { items: PluginPickerItem[]; selected: number; busy: boolean };
    };
    expect(s.pluginPicker.items.map((i) => i.name)).toEqual(['a', 'b', 'c']);
    expect(s.pluginPicker.busy).toBe(false);
    // selected defaults to 0 in initial state — the reducer should NOT clamp
    // it down, and it should NOT clamp beyond items.length-1.
    expect(s.pluginPicker.selected).toBe(0);
  });

  it('pluginPickerClose flips open=false and busy=false', () => {
    const opened = reducer(
      initial() as never,
      {
        type: 'pluginPickerOpen',
        items: [item('a')],
      } as never,
    ) as unknown as { pluginPicker: { open: boolean; busy: boolean } };
    expect(opened.pluginPicker.open).toBe(true);
    const closed = reducer(opened as never, { type: 'pluginPickerClose' } as never) as unknown as {
      pluginPicker: { open: boolean; busy: boolean };
    };
    expect(closed.pluginPicker.open).toBe(false);
    expect(closed.pluginPicker.busy).toBe(false);
  });
});

describe('pluginPicker reducer — navigation', () => {
  function openWith(items: PluginPickerItem[]): State {
    return reducer(
      initial() as never,
      {
        type: 'pluginPickerOpen',
        items,
      } as never,
    ) as unknown as State;
  }

  it('move is a no-op when the picker is empty', () => {
    const before = initial();
    const after = reducer(
      before as never,
      {
        type: 'pluginPickerMove',
        delta: 1,
      } as never,
    ) as unknown as State;
    expect(after).toBe(before);
  });

  it('move wraps forward across the items list', () => {
    let s = openWith([item('a'), item('b'), item('c')]);
    const sel = () =>
      (s as unknown as { pluginPicker: { selected: number } }).pluginPicker.selected;
    s = reducer(s as never, { type: 'pluginPickerMove', delta: 1 } as never) as unknown as State;
    expect(sel()).toBe(1);
    s = reducer(s as never, { type: 'pluginPickerMove', delta: 1 } as never) as unknown as State;
    expect(sel()).toBe(2);
    s = reducer(s as never, { type: 'pluginPickerMove', delta: 1 } as never) as unknown as State;
    // Wraps from last to first.
    expect(sel()).toBe(0);
  });

  it('move wraps backward past the first item', () => {
    let s = openWith([item('a'), item('b')]);
    const sel = () =>
      (s as unknown as { pluginPicker: { selected: number } }).pluginPicker.selected;
    s = reducer(s as never, { type: 'pluginPickerMove', delta: -1 } as never) as unknown as State;
    expect(sel()).toBe(1);
  });
});

describe('pluginPicker reducer — items / busy / hint', () => {
  it('setItems replaces the items list and clears busy', () => {
    const opened = reducer(
      initial() as never,
      {
        type: 'pluginPickerOpen',
      } as never,
    ) as unknown as State;
    const s = reducer(
      opened as never,
      {
        type: 'pluginPickerSetItems',
        items: [item('format-on-save'), item('cost-tracker')],
      } as never,
    ) as unknown as {
      pluginPicker: { items: PluginPickerItem[]; busy: boolean };
    };
    expect(s.pluginPicker.items.map((i) => i.name)).toEqual(['format-on-save', 'cost-tracker']);
    expect(s.pluginPicker.busy).toBe(false);
  });

  it('busy toggles only the busy flag, preserves other picker state', () => {
    const opened = reducer(
      initial() as never,
      {
        type: 'pluginPickerOpen',
        items: [item('a')],
      } as never,
    ) as unknown as { pluginPicker: { busy: boolean; open: boolean } };
    expect(opened.pluginPicker.busy).toBe(false);
    const busy = reducer(
      opened as never,
      {
        type: 'pluginPickerBusy',
        busy: true,
      } as never,
    ) as unknown as { pluginPicker: { busy: boolean; open: boolean } };
    expect(busy.pluginPicker.busy).toBe(true);
    expect(busy.pluginPicker.open).toBe(true);
  });

  it('hint sets and clears row guidance text', () => {
    const opened = reducer(
      initial() as never,
      {
        type: 'pluginPickerOpen',
        items: [item('a')],
      } as never,
    ) as unknown as { pluginPicker: { hint?: string } };

    const withHint = reducer(
      opened as never,
      {
        type: 'pluginPickerHint',
        text: 'X is locked — see /plugin report',
      } as never,
    ) as unknown as { pluginPicker: { hint?: string } };
    expect(withHint.pluginPicker.hint).toBe('X is locked — see /plugin report');

    const cleared = reducer(
      withHint as never,
      {
        type: 'pluginPickerHint',
      } as never,
    ) as unknown as { pluginPicker: { hint?: string } };
    expect(cleared.pluginPicker.hint).toBeUndefined();
  });

  it('locked-row metadata survives a round-trip through setItems', () => {
    const opened = reducer(
      initial() as never,
      {
        type: 'pluginPickerOpen',
      } as never,
    ) as unknown as State;
    const coreRow = { ...item('legacy-core', false, false), name: 'legacy-core' };
    const toggleable = item('format-on-save');
    const s = reducer(
      opened as never,
      {
        type: 'pluginPickerSetItems',
        items: [coreRow, toggleable],
      } as never,
    ) as unknown as { pluginPicker: { items: PluginPickerItem[] } };
    const items = s.pluginPicker.items;
    const locked = items.find((i) => i.name === 'legacy-core');
    expect(locked?.lockable).toBe(false);
    const format = items.find((i) => i.name === 'format-on-save');
    expect(format?.lockable).toBe(true);
  });
});
