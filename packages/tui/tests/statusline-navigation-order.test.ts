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
    // navigation mirrors what the user sees on screen. Lines are grouped by
    // VOLATILITY: identity is static, vitals redraw every token, safety &
    // work change a few times a turn, async comes and goes on its own.
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
      2: ['state', 'context', 'tokens', 'cost', 'cache', 'elapsed', 'queue', 'hint', 'index'],
      3: [
        'yolo',
        'autonomy',
        'eternal_stage',
        'breaker',
        'token_saving',
        'processes',
        'side_effects',
        'dropped_tools',
        'goal',
        'todos',
        'plan',
        'tasks',
      ],
      4: [
        'fleet',
        'fleet_agents',
        'mailbox',
        'brain',
        'debug_stream',
        'memory_context',
        'next_steps',
        'auto_proceed',
        'enhance',
      ],
    };
    for (const [line, items] of Object.entries(expected)) {
      const actual = STATUSLINE_ITEMS.filter((item) => ITEM_LINE[item] === Number(line));
      expect(actual).toEqual(items);
    }
  });

  it('anchors index beside the vitals it reports on, not on the async rail', () => {
    expect(ITEM_LINE.index).toBe(2);
    expect(STATUSLINE_ITEMS.filter((item) => ITEM_LINE[item] === 2)).toContain('index');
  });

  it('keeps the ephemeral hint on the vitals rail so no rail strobes for it', () => {
    // `hint` appears and disappears several times within one turn. On a
    // conditional rail that would open and close the whole rail; on line 2
    // (which always renders) it is simply the first chip overflow sheds.
    expect(ITEM_LINE.hint).toBe(2);
    const line2 = STATUSLINE_ITEMS.filter((item) => ITEM_LINE[item] === 2);
    expect(line2[line2.length - 1]).toBe('index');
    expect(line2[line2.length - 2]).toBe('hint');
  });

  it('groups memory_context and the fleet with the other async activity', () => {
    for (const item of ['memory_context', 'fleet', 'fleet_agents', 'mailbox'] as const) {
      expect(ITEM_LINE[item]).toBe(4);
    }
  });

  it('groups every countdown on the async rail', () => {
    for (const item of ['next_steps', 'auto_proceed', 'enhance'] as const) {
      expect(ITEM_LINE[item]).toBe(4);
    }
  });

  it('puts the safety posture ahead of the work boards on line 3', () => {
    const line3 = STATUSLINE_ITEMS.filter((item) => ITEM_LINE[item] === 3);
    expect(line3.indexOf('yolo')).toBeLessThan(line3.indexOf('todos'));
    expect(line3.indexOf('breaker')).toBeLessThan(line3.indexOf('goal'));
    for (const item of ['yolo', 'autonomy', 'eternal_stage', 'breaker', 'side_effects'] as const) {
      expect(ITEM_LINE[item]).toBe(3);
    }
  });

  it('splits the telemetry composite into four independently placeable chips', () => {
    // They used to render as one atomic `primary-0` entry, which silently
    // ignored per-chip line assignment for tokens/cost/cache.
    for (const item of ['context', 'tokens', 'cost', 'cache'] as const) {
      expect(ITEM_LINE[item]).toBe(2);
      expect(STATUSLINE_ITEMS).toContain(item);
    }
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
