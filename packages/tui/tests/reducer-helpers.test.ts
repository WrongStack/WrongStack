/**
 * Tests for src/reducers/helpers.ts — pure utility functions.
 * Covers clampContextLoad, closePanels, pruneToolInput, firstSelectable,
 * and skipDivider to 100% line and branch.
 */

import { describe, expect, it } from 'vitest';
import type { State } from '../src/app-state.js';
import {
  clampContextLoad,
  closePanels,
  firstSelectable,
  pruneToolInput,
  retainStreamTail,
  skipDivider,
} from '../src/reducers/helpers.js';
import { createTestState } from './helpers/create-test-state.js';

function stubState(over: Partial<State> | Record<string, unknown> = {}): State {
  return createTestState(over);
}

describe('clampContextLoad', () => {
  it('clamps values above 1 to 1', () => {
    expect(clampContextLoad(1.5)).toBe(1);
    // Infinity is not finite so clampContextLoad returns 0 (default for NaN/Infinity).
    expect(clampContextLoad(Infinity)).toBe(0);
  });

  it('clamps values below 0 to 0', () => {
    expect(clampContextLoad(-0.5)).toBe(0);
    expect(clampContextLoad(-Infinity)).toBe(0);
  });

  it('returns 0 for non-finite values', () => {
    expect(clampContextLoad(NaN)).toBe(0);
  });

  it('returns the value unchanged when within [0, 1]', () => {
    expect(clampContextLoad(0)).toBe(0);
    expect(clampContextLoad(0.5)).toBe(0.5);
    expect(clampContextLoad(1)).toBe(1);
  });
});

describe('closePanels', () => {
  it('closes every tracked panel and picker', () => {
    const state = stubState();
    const result = closePanels(state);

    expect(result.monitorOpen).toBe(false);
    expect(result.agentsMonitorOpen).toBe(false);
    expect(result.helpOpen).toBe(false);
    expect(result.todosMonitorOpen).toBe(false);
    expect(result.queuePanelOpen).toBe(false);
    expect(result.processListOpen).toBe(false);
    expect(result.auditPanelOpen).toBe(false);
    expect(result.planPanelOpen).toBe(false);
    expect(result.kanbanPanelOpen).toBe(false);
    expect(result.goalPanelOpen).toBe(false);
    expect(result.goalKanbanPanelOpen).toBe(false);
    expect(result.contextPanelOpen).toBe(false);
    expect(result.sessionsPanelOpen).toBe(false);
    expect(result.worktreeMonitorOpen).toBe(false);
    expect(result.cronMonitorOpen).toBe(false);
  });

  it('closes pickers with open:false', () => {
    const state = stubState();
    const result = closePanels(state);

    expect(result.settingsPicker.open).toBe(false);
    expect(result.statuslinePicker.open).toBe(false);
    expect(result.pluginPicker.open).toBe(false);
    expect(result.mcpPicker.open).toBe(false);
    expect(result.toolsPicker.open).toBe(false);
    expect(result.brainPanel.open).toBe(false);
    expect(result.helpPanel.open).toBe(false);
    expect(result.shadowPanel.open).toBe(false);
    expect(result.authPanel.open).toBe(false);
    expect(result.projectPicker.open).toBe(false);
    expect(result.fKeyPicker.open).toBe(false);
  });

  it('sets authPanel.busy to false when closing', () => {
    const state = stubState({ authPanel: { open: true, view: 'list', busy: true, providers: [], presets: [], catalog: [], selected: 0, filter: '', flowTitle: '', log: [], flowDone: false } });
    const result = closePanels(state);
    expect(result.authPanel.open).toBe(false);
    expect(result.authPanel.busy).toBe(false);
  });

  it('preserves goalRun and sddBoard when null', () => {
    const state = stubState({ goalRun: null, sddBoard: null });
    const result = closePanels(state);
    expect(result.goalRun).toBeNull();
    expect(result.sddBoard).toBeNull();
  });

  it('closes monitorOpen on goalRun and sddBoard when non-null', () => {
    const state = stubState({
      goalRun: { monitorOpen: true } as never,
      sddBoard: { monitorOpen: true } as never,
    });
    const result = closePanels(state);
    expect((result.goalRun as { monitorOpen: boolean } | null)?.monitorOpen).toBe(false);
    expect((result.sddBoard as { monitorOpen: boolean } | null)?.monitorOpen).toBe(false);
  });

  it('closes coordinator.monitorOpen', () => {
    const state = stubState();
    const result = closePanels(state);
    expect(result.coordinator.monitorOpen).toBe(false);
  });
});

describe('retainStreamTail', () => {
  it('keeps small streams unchanged', () => {
    expect(retainStreamTail('abc', 'def', 10)).toBe('abcdef');
  });

  it('caps a single oversized delta to the bound', () => {
    expect(retainStreamTail('0123456789', 'abcdefghij', 8)).toBe('cdefghij');
  });

  it('lets the buffer ride up to the high-water mark before cutting', () => {
    // 2x the bound is the ceiling, so 14 chars against a bound of 8 is left
    // alone. Trimming here instead would cost a full rope flatten per token.
    expect(retainStreamTail('0123456789', 'ABCD', 8)).toBe('0123456789ABCD');
  });

  it('cuts back to the bound once the high-water mark is crossed', () => {
    // 17 + 1 = 18 > 2 * 8, so the result is exactly the newest 8 characters
    // and still ends with the delta.
    expect(retainStreamTail('q'.repeat(17), 'Z', 8)).toBe('qqqqqqqZ');
  });

  it('never exceeds twice the bound across a long stream', () => {
    let tail = '';
    for (let i = 0; i < 500; i++) tail = retainStreamTail(tail, 'abcde', 8);
    expect(tail.length).toBeLessThanOrEqual(16);
    expect(tail.endsWith('abcde')).toBe(true);
  });

  it('does not retain an orphaned UTF-16 surrogate when trimming the head', () => {
    // The cut lands mid-pair: 5 code units back from the end of a 9-unit
    // buffer is the low half of a surrogate pair, so the guard moves forward.
    expect(retainStreamTail('😀😀😀😀', 'C', 4)).toBe('😀C');
    expect(retainStreamTail('', 'A😀B', 3)).toBe('😀B');
  });

  it('returns an empty tail when the configured bound is non-positive', () => {
    expect(retainStreamTail('abc', 'def', 0)).toBe('');
  });
});

describe('pruneToolInput', () => {
  it('truncates long strings', () => {
    const long = 'a'.repeat(10_000);
    const result = pruneToolInput(long) as string;
    expect(result.length).toBeLessThanOrEqual(2048 + 100); // truncated message appended
    expect(result).toContain('truncated');
    expect(result).toContain('10000');
  });

  it('returns short strings unchanged', () => {
    expect(pruneToolInput('hello')).toBe('hello');
    expect(pruneToolInput('')).toBe('');
  });

  it('returns null and primitives unchanged', () => {
    expect(pruneToolInput(null)).toBeNull();
    expect(pruneToolInput(42)).toBe(42);
    expect(pruneToolInput(true)).toBe(true);
    expect(pruneToolInput(undefined)).toBeUndefined();
  });

  it('truncates arrays with too many items', () => {
    const arr = Array.from({ length: 100 }, (_, i) => `item-${i}`);
    const result = pruneToolInput(arr) as unknown[];
    expect(result).toHaveLength(65); // 64 items + 1 pruned marker
    expect(result[result.length - 1]).toContain('36 more items');
  });

  it('truncates objects with too many keys', () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 100; i++) obj[`k${i}`] = i;
    const result = pruneToolInput(obj) as Record<string, unknown>;
    const keys = Object.keys(result);
    expect(keys.length).toBeLessThanOrEqual(65); // 64 keys + 1 pruned marker
    expect(result['…']).toContain('pruned');
  });

  it('limits recursion depth', () => {
    // MAX_RETAINED_INPUT_DEPTH = 4. Starting at depth=0 for the root, depth=4
    // triggers the depth guard. { a: { b: { c: { d: { e: 'deep' } } } } }
    // has depth 4 at the 'd' level, so 'd' is replaced with the pruned sentinel.
    const deep: Record<string, unknown> = { a: { b: { c: { d: { e: 'deep' } } } } };
    const result = pruneToolInput(deep) as Record<string, unknown>;
    const c = (result.a as Record<string, unknown>).b as Record<string, unknown>;
    expect((c.c as Record<string, unknown>).d).toEqual('[pruned: too deep]');
  });

  it('recursively prunes nested arrays', () => {
    const input = [Array.from({ length: 100 }, (_, i) => `x${i}`), 'keep'];
    const result = pruneToolInput(input) as unknown[];
    expect((result[0] as unknown[]).length).toBe(65);
    expect(result[1]).toBe('keep');
  });
});

describe('firstSelectable', () => {
  it('returns index of first non-divider item', () => {
    const items = [
      { key: '__divider__', label: '--', kind: 'action' as const },
      { key: 'proj-a', label: 'Project A', kind: 'project' as const },
    ];
    expect(firstSelectable(items)).toBe(1);
  });

  it('returns 0 when list is empty', () => {
    expect(firstSelectable([])).toBe(0);
  });

  it('returns 0 when all items are dividers', () => {
    const items = [
      { key: '__divider__', label: '--', kind: 'action' as const },
    ];
    expect(firstSelectable(items)).toBe(0);
  });

  it('returns 0 when first item is selectable', () => {
    const items = [
      { key: 'proj-a', label: 'A', kind: 'project' as const },
    ];
    expect(firstSelectable(items)).toBe(0);
  });
});

describe('skipDivider', () => {
  const items = [
    { key: '__divider__', label: '--', kind: 'action' as const },
    { key: 'proj-a', label: 'A', kind: 'project' as const },
    { key: '__divider__', label: '--', kind: 'action' as const },
    { key: 'proj-b', label: 'B', kind: 'project' as const },
  ];

  it('skips forward over dividers', () => {
    expect(skipDivider(items, 0, 1)).toBe(1); // skips divider[0] to proj-a
    expect(skipDivider(items, 2, 1)).toBe(3); // skips divider[2] to proj-b
  });

  it('skips backward over dividers', () => {
    expect(skipDivider(items, 2, -1)).toBe(1); // from divider[2] backward to proj-a
  });

  it('wraps around forward (past end)', () => {
    // items = [divider(0), A(1), divider(2), B(3)]. From index 3 (B) forward,
    // B is already selectable so it stays at 3. Start from a divider to force
    // wrap-around: from index 2 (divider) forward -> 3 (B).
    expect(skipDivider(items, 2, 1)).toBe(3);
    // From index 3 (B) forward -> B is selectable -> stays at 3
    expect(skipDivider(items, 3, 1)).toBe(3);
  });

  it('wraps around backward (past start)', () => {
    // items = [divider(0), A(1), divider(2), B(3)]. From index 1 (A) backward,
    // A is already selectable so it stays at 1. Start from a divider to force
    // wrap: from index 0 (divider) backward -> wraps to 3 (B).
    expect(skipDivider(items, 0, -1)).toBe(3);
    expect(skipDivider(items, 1, -1)).toBe(1);
  });

  it('stays at index when all items are dividers', () => {
    const allDividers = [
      { key: '__divider__', label: '--', kind: 'action' as const },
      { key: '__divider__', label: '--', kind: 'action' as const },
    ];
    expect(skipDivider(allDividers, 1, 1)).toBe(1);
    expect(skipDivider(allDividers, 1, -1)).toBe(1);
  });

  it('returns the same index when already on a selectable', () => {
    expect(skipDivider(items, 1, 1)).toBe(1);
    expect(skipDivider(items, 1, -1)).toBe(1);
  });
});
