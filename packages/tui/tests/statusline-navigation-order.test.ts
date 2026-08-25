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
 * by index, so the array order must match the visual top-to-bottom order
 * AND the left-to-right render order within each rail.
 */
describe('STATUSLINE_ITEMS navigation order matches visual layout', () => {
  it('has exactly 40 fields', () => {
    expect(STATUSLINE_ITEMS.length).toBe(40);
    expect(STATUSLINE_FIELD_COUNT).toBe(40);
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

  it('lists items in render order within each line (mirrors the rails)', () => {
    // The exact left-to-right render order of each rail, so picker
    // navigation mirrors what the user sees on screen.
    const expected: Record<number, StatuslineItem[]> = {
      1: [
        'project',
        'working_dir',
        'git',
        'model',
        'mode',
        'prompt_variant',
        'theme',
        'sessions',
        'tools',
        'version',
      ],
      2: [
        'state',
        'yolo',
        'autonomy',
        'eternal_stage',
        'context',
        'tokens',
        'cost',
        'cache',
        'queue',
        'hint',
        'breaker',
        'processes',
        'elapsed',
        'token_saving',
        'side_effects',
      ],
      3: [
        'goal',
        'todos',
        'plan',
        'tasks',
        'next_steps',
        'auto_proceed',
        'enhance',
        'dropped_tools',
      ],
      4: [
        'fleet',
        'fleet_agents',
        'mailbox',
        'brain',
        'debug_stream',
        'memory_context',
        'index',
      ],
    };
    for (const [line, items] of Object.entries(expected)) {
      const actual = STATUSLINE_ITEMS.filter((item) => ITEM_LINE[item] === Number(line));
      expect(actual).toEqual(items);
    }
  });

  it('groups codebase index server status on line 4 (connectivity & services)', () => {
    expect(ITEM_LINE.index).toBe(4);

    const line4Items = STATUSLINE_ITEMS.filter((item) => ITEM_LINE[item] === 4);
    expect(line4Items).toContain('index');

    const line3Items = STATUSLINE_ITEMS.filter((item) => ITEM_LINE[item] === 3);
    expect(line3Items).not.toContain('index');
  });

  it('groups memory_context on line 4 (connectivity & services)', () => {
    expect(ITEM_LINE.memory_context).toBe(4);

    const line4Items = STATUSLINE_ITEMS.filter((item) => ITEM_LINE[item] === 4);
    expect(line4Items).toContain('memory_context');

    const line3Items = STATUSLINE_ITEMS.filter((item) => ITEM_LINE[item] === 3);
    expect(line3Items).not.toContain('memory_context');
  });

  it('places goal on line 3 (active work) and eternal_stage on line 2 (run state)', () => {
    expect(ITEM_LINE.goal).toBe(3);
    expect(ITEM_LINE.eternal_stage).toBe(2);
    expect(ITEM_LINE.auto_proceed).toBe(3);

    const line3Items = STATUSLINE_ITEMS.filter((item) => ITEM_LINE[item] === 3);
    expect(line3Items).toContain('goal');
    expect(line3Items).toContain('auto_proceed');

    const line2Items = STATUSLINE_ITEMS.filter((item) => ITEM_LINE[item] === 2);
    expect(line2Items).toContain('eternal_stage');
    expect(line2Items).not.toContain('goal');
  });

  it('places side_effects on line 2 (run state & safety)', () => {
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
      'dropped_tools',
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
      'prompt_variant',
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
      'version',
      'working_dir',
      'yolo',
    ].sort();
    const actual = [...STATUSLINE_ITEMS].sort();
    expect(actual).toEqual(expected);
  });

  it('does not include removed phantom items', () => {
    const names = STATUSLINE_ITEMS as string[];
    expect(names).not.toContain('time');
    expect(names).not.toContain('sage');
    expect(names).not.toContain('cpu');
    expect(names).not.toContain('memory');
  });
});
