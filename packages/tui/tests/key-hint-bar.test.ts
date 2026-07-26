import { describe, expect, it } from 'vitest';
import { IDLE_MESSAGES, hintsFor, isIdleContext } from '../src/components/key-hint-bar.js';

const keys = (ctx: Parameters<typeof hintsFor>[0]) => hintsFor(ctx).map((h) => h.key);

describe('KeyHintBar context priority', () => {
  it('confirm wins over everything', () => {
    expect(keys({ confirm: true, picker: true, monitor: true })).toEqual(['y', 'n', 'a', 'd']);
  });

  it('picker shows move/select/cancel', () => {
    expect(keys({ picker: true })).toEqual(['↑↓', '↵', 'Esc']);
  });

  it('monitor shows close + terminal-safe switch keys', () => {
    expect(keys({ monitor: true })).toContain('Esc');
    expect(keys({ monitor: true })).toContain('F2');
    expect(keys({ monitor: true })).toContain('F3');
    expect(keys({ monitor: true })).toContain('F4');
  });

  it('idle shows brand link instead of keybinding hints', () => {
    const h = hintsFor({});
    expect(h).toHaveLength(1);
    expect(h[0]!.label).toBe('github.com/wrongstack/wrongstack');
    expect(h[0]!.key).toBe('');
  });

  it('shows wheel and compact-keyboard paging while history is scrolled', () => {
    const h = hintsFor({ managed: true });
    expect(h).toEqual([
      { key: 'wheel', label: 'scroll' },
      { key: 'Ctrl+U/D', label: 'page' },
    ]);
  });
});

describe('Idle message rotation', () => {
  it('IDLE_MESSAGES is a non-empty array of hints with empty keys', () => {
    expect(IDLE_MESSAGES.length).toBeGreaterThan(1);
    for (const m of IDLE_MESSAGES) {
      expect(m.key).toBe('');
      expect(m.label.length).toBeGreaterThan(0);
    }
  });

  it('first idle message is always the canonical brand link', () => {
    expect(IDLE_MESSAGES[0]!.label).toBe('github.com/wrongstack/wrongstack');
  });

  it('isIdleContext returns true only when no interactive flag is set', () => {
    expect(isIdleContext({})).toBe(true);
    expect(isIdleContext({ confirm: true })).toBe(false);
    expect(isIdleContext({ picker: true })).toBe(false);
    expect(isIdleContext({ monitor: true })).toBe(false);
    expect(isIdleContext({ managed: true })).toBe(false);
    // monitor takes priority, but isIdleContext should still be false
    expect(isIdleContext({ confirm: true, picker: true })).toBe(false);
  });

  it('hintsFor idle case returns the same hint as IDLE_MESSAGES[0]', () => {
    expect(hintsFor({})).toEqual([IDLE_MESSAGES[0]]);
  });
});
