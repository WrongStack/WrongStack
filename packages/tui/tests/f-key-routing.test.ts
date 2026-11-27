// Focused routing tests for the F-key launcher (TUI_TASKS.md task 2).
//
// Pins the two launch paths every advertised panel must support:
//   1. direct keyboard — routeFKeyPanels (F-key / Ctrl-alias) and
//      routeChordPanels (Ctrl+Y) in key-routes/key-route-overlay.ts
//   2. the `/f` picker — the metadata → actionForFKeyPanel → dispatch
//      contract that `onFKeyPickerEnter` (hooks/use-app-picker-keys.ts)
//      resolves on Enter, plus a source pin that the hook keeps using it.
//
// Also pins: F5 plan routing, F12 kanban routing (F12 is the kanban board,
// NOT the statusline picker — the statusline picker is a payload-requiring
// `statuslineOpen` action launched via /statusline and the bridge), the
// typed statuslineOpen payload, mutual exclusion, and Esc close behavior.

import { describe, expect, it, vi } from 'vitest';
import type { Action } from '../src/app-action-type.js';
import { reducer } from '../src/app-reducer.js';
import type { State } from '../src/app-state.js';
import { EMPTY_KEY } from '../src/components/input.js';
import {
  actionForFKeyPanel,
  F_KEY_PANEL_ENTRIES,
  type FKeyPanelEntry,
} from '../src/f-key-panels.js';
import type { KeyRouteContext } from '../src/key-handler-context.js';
import {
  routeChordPanels,
  routeEscClosePanels,
  routeFKeyPanels,
} from '../src/key-routes/key-route-overlay.js';
import { createPanelOpenDispatcher } from '../src/on-panel-open.js';
import { initial } from './reducer.test.js';

const entryFor = (key: number): FKeyPanelEntry => {
  const found = F_KEY_PANEL_ENTRIES.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Missing F${key} entry`);
  return found;
};

/** Minimal route context — only the fields the overlay routes read. */
function makeCtx(state: State, dispatch: (action: Action) => void) {
  const openProjectPicker = vi.fn(async () => {});
  const loadLiveSessions = vi.fn(async () => {});
  const openStatuslinePicker = vi.fn();
  const ctx = {
    state,
    dispatch,
    openProjectPicker,
    loadLiveSessions,
    openStatuslinePicker,
    statuslineHiddenItems: [],
    lastEscAtRef: { current: 0 },
    terminalColumns: 100,
  } as unknown as KeyRouteContext;
  return { ctx, openProjectPicker, loadLiveSessions, openStatuslinePicker };
}

describe('F5 plan panel routing', () => {
  it('opens the plan panel directly from the F5 key', () => {
    const dispatch = vi.fn();
    const { ctx } = makeCtx(initial(), dispatch);

    expect(routeFKeyPanels(ctx, '', { ...EMPTY_KEY, fn: 5 })).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: 'togglePlanPanel' });

    const out = reducer(initial(), { type: 'togglePlanPanel' });
    expect(out.planPanelOpen).toBe(true);
  });

  it('closes the plan panel when F5 is pressed again (toggle)', () => {
    const dispatch = vi.fn();
    const { ctx } = makeCtx(initial({ planPanelOpen: true }), dispatch);

    expect(routeFKeyPanels(ctx, '', { ...EMPTY_KEY, fn: 5 })).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: 'togglePlanPanel' });

    const out = reducer(initial({ planPanelOpen: true }), { type: 'togglePlanPanel' });
    expect(out.planPanelOpen).toBe(false);
  });

  it('opens the plan panel from the /f picker dispatch contract', () => {
    // Mirrors onFKeyPickerEnter: close the picker, resolve the selected
    // entry's action from the shared metadata, dispatch it.
    const state = initial({ fKeyPicker: { open: true, selected: 4 } });
    const entry = F_KEY_PANEL_ENTRIES[state.fKeyPicker.selected];
    expect(entry?.key).toBe(5);

    const action = actionForFKeyPanel(entry!);
    expect(action).toEqual({ type: 'togglePlanPanel' });

    let out = reducer(state, { type: 'fKeyPickerClose' });
    out = reducer(out, action!);
    expect(out.fKeyPicker.open).toBe(false);
    expect(out.planPanelOpen).toBe(true);
  });

  it('keeps the /f picker Enter handler wired to the shared metadata', async () => {
    // Source pin (pattern: kanban-panel-render.test.ts): the picker Enter
    // callback must resolve actions via actionForFKeyPanel instead of
    // hardcoding a parallel label/action table.
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = fileURLToPath(import.meta.url);
    const hookPath = path.resolve(path.dirname(here), '../src/hooks/use-app-picker-keys.ts');
    const source = await readFile(hookPath, 'utf8');
    expect(source).toMatch(/onFKeyPickerEnter:[\s\S]{0,900}actionForFKeyPanel/);
    // F1 and F10 stay special-cased via hostAction: the host must load the
    // panel data (project items / live sessions) on the picker path too, not
    // just on the direct F-key route.
    expect(source).toMatch(/onFKeyPickerEnter:[\s\S]{0,900}hostAction === 'openProjectPicker'/);
    expect(source).toMatch(/onFKeyPickerEnter:[\s\S]{0,900}hostAction === 'loadLiveSessions'/);
    expect(source).toMatch(/onFKeyPickerEnter:[\s\S]{0,900}loadLiveSessions\(\)/);
  });
});

describe('F12 kanban panel routing', () => {
  it('opens the kanban board directly from the F12 key', () => {
    const dispatch = vi.fn();
    const { ctx } = makeCtx(initial(), dispatch);

    expect(routeFKeyPanels(ctx, '', { ...EMPTY_KEY, fn: 12 })).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: 'toggleKanbanPanel' });

    const out = reducer(initial(), { type: 'toggleKanbanPanel' });
    expect(out.kanbanPanelOpen).toBe(true);
  });

  it('opens the kanban board from the Ctrl+Y chord', () => {
    const dispatch = vi.fn();
    const { ctx } = makeCtx(initial(), dispatch);

    expect(routeChordPanels(ctx, 'y', { ...EMPTY_KEY, ctrl: true })).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: 'toggleKanbanPanel' });
  });

  it('opens the kanban board from the /f picker without a statusline payload', () => {
    const entry = entryFor(12);
    expect(entry.label).toBe('Kanban board panel');
    // hiddenItems are irrelevant for F12 — they must not leak into the action.
    expect(actionForFKeyPanel(entry, ['todos', 'cost'])).toEqual({ type: 'toggleKanbanPanel' });

    const state = initial({ fKeyPicker: { open: true, selected: 11 } });
    let out = reducer(state, { type: 'fKeyPickerClose' });
    out = reducer(out, { type: 'toggleKanbanPanel' });
    expect(out.kanbanPanelOpen).toBe(true);
  });
});

describe('statuslineOpen payload routing (typed, no casts)', () => {
  it('builds the hiddenItems payload for a statuslineOpen entry', () => {
    const statuslineEntry: FKeyPanelEntry = {
      key: 0,
      label: 'Statusline',
      action: 'statuslineOpen',
      helpKeys: '/statusline',
      helpDescription: 'statusline picker',
      hostAction: 'openStatuslinePicker',
    };
    expect(actionForFKeyPanel(statuslineEntry, ['todos', 'cost'])).toEqual({
      type: 'statuslineOpen',
      hiddenItems: ['todos', 'cost'],
    });
    // Defaults to an empty snapshot when the host has nothing hidden.
    expect(actionForFKeyPanel(statuslineEntry)).toEqual({
      type: 'statuslineOpen',
      hiddenItems: [],
    });
  });

  it('delegates statuslineOpen to the host opener that computes the snapshot', () => {
    const dispatch = vi.fn();
    const openStatuslinePicker = vi.fn();
    const dispatcher = createPanelOpenDispatcher({
      dispatch,
      openProjectPicker: vi.fn(),
      openStatuslinePicker,
    });
    expect(dispatcher('statuslineOpen')).toBe(true);
    expect(openStatuslinePicker).toHaveBeenCalledTimes(1);
    // The opener owns the payload-carrying dispatch, not the bridge.
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('every advertised F-key panel is launchable', () => {
  it('the slash-command bridge launches every metadata action', () => {
    const dispatcher = createPanelOpenDispatcher({
      dispatch: vi.fn(),
      openProjectPicker: vi.fn(),
      openStatuslinePicker: vi.fn(),
    });
    for (const entry of F_KEY_PANEL_ENTRIES) {
      expect(dispatcher(entry.action)).toBe(true);
    }
  });

  it('the direct keyboard route handles every metadata entry', () => {
    for (const entry of F_KEY_PANEL_ENTRIES) {
      const dispatch = vi.fn();
      const { ctx } = makeCtx(initial(), dispatch);
      const key = entry.key > 0 ? { ...EMPTY_KEY, fn: entry.key } : { ...EMPTY_KEY, ctrl: true };
      const input = entry.key > 0 ? '' : (entry.ctrlAlias ?? '');
      expect(routeFKeyPanels(ctx, input, key)).toBe(true);
    }
  });

  it('the picker dispatch contract resolves an action for every non-host entry', () => {
    for (const entry of F_KEY_PANEL_ENTRIES) {
      if (entry.action === 'projectPickerOpen') {
        // F1 must load project items from the host before opening.
        expect(actionForFKeyPanel(entry)).toBeNull();
      } else {
        expect(actionForFKeyPanel(entry)).not.toBeNull();
      }
    }
  });

  it('F1 delegates to openProjectPicker and F10 to loadLiveSessions', () => {
    const f1 = makeCtx(initial(), vi.fn());
    expect(routeFKeyPanels(f1.ctx, '', { ...EMPTY_KEY, fn: 1 })).toBe(true);
    expect(f1.openProjectPicker).toHaveBeenCalledTimes(1);

    const f10 = makeCtx(initial(), vi.fn());
    expect(routeFKeyPanels(f10.ctx, '', { ...EMPTY_KEY, fn: 10 })).toBe(true);
    expect(f10.loadLiveSessions).toHaveBeenCalledTimes(1);
  });
});

describe('mutual exclusion and Esc behavior', () => {
  it('opening F12 after F5 closes the plan panel', () => {
    let out = reducer(initial(), { type: 'togglePlanPanel' });
    expect(out.planPanelOpen).toBe(true);
    out = reducer(out, { type: 'toggleKanbanPanel' });
    expect(out.planPanelOpen).toBe(false);
    expect(out.kanbanPanelOpen).toBe(true);
  });

  it('Esc closes the open plan panel before any busy-interrupt', () => {
    const dispatch = vi.fn();
    const { ctx } = makeCtx(initial({ planPanelOpen: true }), dispatch);
    expect(routeEscClosePanels(ctx, { ...EMPTY_KEY, escape: true })).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: 'togglePlanPanel' });
  });

  it('Esc with no panel open is not consumed by the panel route', () => {
    const dispatch = vi.fn();
    const { ctx } = makeCtx(initial(), dispatch);
    expect(routeEscClosePanels(ctx, { ...EMPTY_KEY, escape: true })).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
