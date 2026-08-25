import { describe, expect, it } from 'vitest';
import {
  ITEM_LINE,
  STATUSLINE_FIELD_COUNT,
  STATUSLINE_ITEMS,
  type StatuslineItem,
} from '../src/components/statusline-picker.js';

/**
 * Navigation order must match the visual layout order.
 * The picker groups items by their status-bar line (1-4) and shows
 * them in section order. Up/Down arrow keys cycle through STATUSLINE_ITEMS
 * by index, so the array order must match the visual top-to-bottom order.
 */
describe('STATUSLINE_ITEMS navigation order matches visual layout', () => {
  it('has exactly 37 fields', () => {
    expect(STATUSLINE_ITEMS.length).toBe(37);
    expect(STATUSLINE_FIELD_COUNT).toBe(37);
  });

  it('follows line 1 → line 2 → line 3 → line 4 order', () => {
    const lines = STATUSLINE_ITEMS.map((item) => ITEM_LINE[item]);

    // All line 1 items come first
    const line1End = lines.findIndex((l) => l !== 1);
    expect(lines.slice(0, line1End).every((l) => l === 1)).toBe(true);

    // Then all line 2 items
    const line2Start = line1End;
    const line2End = lines.findIndex((l, i) => i >= line2Start && l !== 2);
    expect(lines.slice(line2Start, line2End).every((l) => l === 2)).toBe(true);

    // Then all line 3 items
    const line3Start = line2End;
    const line3End = lines.findIndex((l, i) => i >= line3Start && l !== 3);
    expect(lines.slice(line3Start, line3End).every((l) => l === 3)).toBe(true);

    // Then all line 4 items
    const line4Start = line3End;
    expect(lines.slice(line4Start).every((l) => l === 4)).toBe(true);

    // No items on line 5+
    expect(lines.every((l) => l >= 1 && l <= 4)).toBe(true);
  });

  it('is alphabetically sorted within each line (after priority items)', () => {
    // Priority items that appear at the start of a line regardless of alpha sort.
    // Line 1 starts with its runtime-priority items; line 2 starts with the
    // location pair so navigation follows the rendered status-bar rail.
    const PRIORITY_ITEMS = new Set<StatuslineItem>(['yolo', 'autonomy', 'project', 'working_dir']);

    // Group by line, in the order items actually appear in STATUSLINE_ITEMS
    // (so we exercise the same grouping the picker uses for navigation).
    const byLine = new Map<number, StatuslineItem[]>();
    for (const item of STATUSLINE_ITEMS) {
      const line = ITEM_LINE[item];
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line)!.push(item);
    }

    // Each group should be alphabetically sorted after its priority items
    for (const [_line, items] of byLine) {
      const headCount = items.findIndex((i) => !PRIORITY_ITEMS.has(i));
      const tail = headCount === -1 ? [] : items.slice(headCount);
      const sorted = [...tail].sort((a, b) => a.localeCompare(b));
      expect(tail).toEqual(sorted);
    }
  });

  it('groups codebase index server status on line 4 (background services)', () => {
    expect(ITEM_LINE.index).toBe(4);

    const line4Items = STATUSLINE_ITEMS.filter((item) => ITEM_LINE[item] === 4);
    expect(line4Items).toContain('index');

    const line3Items = STATUSLINE_ITEMS.filter((item) => ITEM_LINE[item] === 3);
    expect(line3Items).not.toContain('index');
  });

  it('groups memory_context on line 4 (background services)', () => {
    expect(ITEM_LINE.memory_context).toBe(4);

    const line4Items = STATUSLINE_ITEMS.filter((item) => ITEM_LINE[item] === 4);
    expect(line4Items).toContain('memory_context');

    const line3Items = STATUSLINE_ITEMS.filter((item) => ITEM_LINE[item] === 3);
    expect(line3Items).not.toContain('memory_context');
  });

  it('places goal, eternal_stage, and auto_proceed on line 3 (active work)', () => {
    expect(ITEM_LINE.goal).toBe(3);
    expect(ITEM_LINE.eternal_stage).toBe(3);
    expect(ITEM_LINE.auto_proceed).toBe(3);

    const line3Items = STATUSLINE_ITEMS.filter((item) => ITEM_LINE[item] === 3);
    expect(line3Items).toContain('goal');
    expect(line3Items).toContain('eternal_stage');
    expect(line3Items).toContain('auto_proceed');

    const line2Items = STATUSLINE_ITEMS.filter((item) => ITEM_LINE[item] === 2);
    expect(line2Items).not.toContain('goal');
    expect(line2Items).not.toContain('eternal_stage');
    expect(line2Items).not.toContain('auto_proceed');
  });

  it('places side_effects on line 2 (session context)', () => {
    expect(ITEM_LINE.side_effects).toBe(2);

    const line2Items = STATUSLINE_ITEMS.filter((item) => ITEM_LINE[item] === 2);
    expect(line2Items).toContain('side_effects');
  });

  it('has no duplicate items', () => {
    const unique = new Set(STATUSLINE_ITEMS);
    expect(unique.size).toBe(STATUSLINE_ITEMS.length);
  });

  it('includes every statusline item exactly once', () => {
    const expected = [
      'auto_proceed',
      'autonomy',
      'brain',
      'breaker',
      'cache',
      'context',
      'cost',
      'debug_stream',
      'elapsed',
      'enhance',
      'eternal_stage',
      'fleet',
      'fleet_agents',
      'git',
      'goal',
      'hint',
      'index',
      'mailbox',
      'memory_context',
      'mode',
      'model',
      'next_steps',
      'plan',
      'processes',
      'project',
      'queue',
      'sessions',
      'side_effects',
      'state',
      'tasks',
      'theme',
      'token_saving',
      'tokens',
      'todos',
      'tools',
      'working_dir',
      'yolo',
    ].sort();
    const actual = [...STATUSLINE_ITEMS].sort();
    expect(actual).toEqual(expected);
  });

  it('does not include removed phantom items', () => {
    expect(STATUSLINE_ITEMS).not.toContain('version');
    expect(STATUSLINE_ITEMS).not.toContain('time');
    expect(STATUSLINE_ITEMS).not.toContain('sage');
  });
});
