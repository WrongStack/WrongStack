// Reducer contract for the `/statusline` editor's layout controls.
//
// Line assignment and density pins existed in statusline.json and in the
// renderer long before any UI could reach them; these cases are that UI's
// state machine. They pin the behaviours the picker's key handling depends
// on: `auto` is stored as the ABSENCE of a pin (so the persisted document
// stays sparse), `[`/`]` wraps within 1–4, `a` derives its target from the
// chip's EFFECTIVE line rather than its default, and the filter never leaves
// the selection parked on a row the picker isn't drawing.

import { describe, expect, it } from 'vitest';
import { DEFAULT_LINES, effectiveLine } from '@wrongstack/core/statusline';
import { reducer } from '../src/app.js';
import { createInitialState } from '../src/app-initial-state.js';
import type { State } from '../src/app-state.js';
import { STATUSLINE_ITEMS } from '../src/components/statusline-picker.js';

function openPicker(over: Partial<State['statuslinePicker']> = {}): State {
  const base = createInitialState({
    banner: '',
    appVersion: '0.0.0',
    provider: 'p',
    model: 'm',
    cwd: '/tmp',
    restoredEntries: [],
    enhanceEnabled: false,
  } as never);
  return {
    ...base,
    statuslinePicker: { ...base.statuslinePicker, open: true, ...over },
  };
}

describe('statusline layout reducer', () => {
  it('seeds the editor from the live layout when it opens', () => {
    const next = reducer(openPicker({ open: false }), {
      type: 'statuslineOpen',
      hiddenItems: ['git'],
      lines: { todos: 1 },
      densities: { cache: 'micro' },
    });
    expect(next.statuslinePicker.open).toBe(true);
    expect(next.statuslinePicker.lines).toEqual({ todos: 1 });
    expect(next.statuslinePicker.densities).toEqual({ cache: 'micro' });
    expect(next.statuslinePicker.filter).toBe('');
    expect(next.statuslinePicker.filtering).toBe(false);
    expect(next.statuslinePicker.layoutSeeded).toBe(true);
  });

  it('marks an unseeded open so the app never mirrors an empty layout back', () => {
    // A caller that opens the editor without handing it the live layout (the
    // F-key dispatch path) must not cause the user's saved assignment to be
    // overwritten with the editor's empty one.
    const next = reducer(openPicker({ open: false }), {
      type: 'statuslineOpen',
      hiddenItems: [],
    });
    expect(next.statuslinePicker.layoutSeeded).toBe(false);
  });

  it('marks the layout seeded as soon as the user edits it', () => {
    const unseeded = reducer(openPicker({ open: false }), {
      type: 'statuslineOpen',
      hiddenItems: [],
    });
    expect(
      reducer(unseeded, { type: 'statuslineSetLine', item: 'cost', line: 2 }).statuslinePicker
        .layoutSeeded,
    ).toBe(true);
    expect(
      reducer(unseeded, { type: 'statuslineSetDensity', item: 'cost' }).statuslinePicker
        .layoutSeeded,
    ).toBe(true);
    expect(
      reducer(unseeded, { type: 'statuslineResetLayout' }).statuslinePicker.layoutSeeded,
    ).toBe(true);
  });

  it('assigns a chip to an explicit line, clamping out-of-range values', () => {
    const next = reducer(openPicker(), {
      type: 'statuslineSetLine',
      item: 'cost',
      line: 9 as never,
    });
    expect(next.statuslinePicker.lines.cost).toBe(4);
    expect(next.statuslinePicker.hint).toContain('line 4');
  });

  it('shifts a chip one line at a time and wraps within 1-4', () => {
    // `project` defaults to line 1; one step back must land on 4, not stick.
    const back = reducer(openPicker(), {
      type: 'statuslineMoveLine',
      item: 'project',
      delta: -1,
    });
    expect(back.statuslinePicker.lines.project).toBe(4);
    const forward = reducer(back, { type: 'statuslineMoveLine', item: 'project', delta: 1 });
    expect(forward.statuslinePicker.lines.project).toBe(1);
  });

  it('cycles density and stores `auto` as the absence of a pin', () => {
    let state = openPicker();
    for (const expected of ['full', 'short', 'micro'] as const) {
      state = reducer(state, { type: 'statuslineSetDensity', item: 'cache' });
      expect(state.statuslinePicker.densities.cache).toBe(expected);
    }
    state = reducer(state, { type: 'statuslineSetDensity', item: 'cache' });
    // Back to auto — and the key is gone, not set to the string 'auto'.
    expect(state.statuslinePicker.densities).not.toHaveProperty('cache');
  });

  it('accepts an explicit density without cycling', () => {
    const next = reducer(openPicker(), {
      type: 'statuslineSetDensity',
      item: 'model',
      density: 'micro',
    });
    expect(next.statuslinePicker.densities.model).toBe('micro');
  });

  it('toggles a whole line off, then back on, using the effective assignment', () => {
    // `cost` has been moved to line 1, so hiding line 1 must take it too.
    const moved = openPicker({ lines: { cost: 1 } });
    const off = reducer(moved, { type: 'statuslineToggleLine', line: 1 });
    const hidden = new Set(off.statuslinePicker.hiddenItems);
    expect(hidden.has('cost')).toBe(true);
    expect(hidden.has('project')).toBe(true);
    // …and a chip whose default is line 1 but which was moved away is spared.
    expect(DEFAULT_LINES.cost).not.toBe(1);

    const on = reducer(off, { type: 'statuslineToggleLine', line: 1 });
    expect(new Set(on.statuslinePicker.hiddenItems).has('cost')).toBe(false);
  });

  it('reset restores default lines and densities without touching visibility', () => {
    const dirty = openPicker({
      lines: { cost: 1 },
      densities: { cache: 'micro' },
      hiddenItems: ['git'],
    });
    const next = reducer(dirty, { type: 'statuslineResetLayout' });
    expect(next.statuslinePicker.lines).toEqual({});
    expect(next.statuslinePicker.densities).toEqual({});
    expect(next.statuslinePicker.hiddenItems).toEqual(['git']);
    expect(effectiveLine('cost', next.statuslinePicker.lines)).toBe(DEFAULT_LINES.cost);
  });

  it('moves the selection onto a surviving row when a filter is applied', () => {
    const state = openPicker({ field: STATUSLINE_ITEMS.indexOf('project') });
    const filtered = reducer(state, { type: 'statuslineFilter', text: 'cost' });
    expect(STATUSLINE_ITEMS[filtered.statuslinePicker.field]).toBe('cost');
    expect(filtered.statuslinePicker.filter).toBe('cost');
  });

  it('keeps arrow navigation inside the filtered rows', () => {
    // The filter matches descriptions as well as keys, so `countdown` finds
    // the four countdown chips scattered across lines 3 and 4. Navigation
    // must step between them and skip everything in between.
    const state = openPicker({
      filter: 'countdown',
      field: STATUSLINE_ITEMS.indexOf('breaker'),
    });
    const next = reducer(state, { type: 'statuslineFieldMove', delta: 1 });
    expect(STATUSLINE_ITEMS[next.statuslinePicker.field]).toBe('next_steps');
    const back = reducer(next, { type: 'statuslineFieldMove', delta: -1 });
    expect(STATUSLINE_ITEMS[back.statuslinePicker.field]).toBe('breaker');
  });

  it('falls back to the full list when a filter matches nothing', () => {
    const state = openPicker({ filter: 'zzzz', field: 3 });
    const next = reducer(state, { type: 'statuslineFieldMove', delta: 1 });
    expect(next.statuslinePicker.field).toBe(4);
  });
});
