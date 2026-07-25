import { describe, expect, it } from 'vitest';
import { hintsFor } from '../src/components/key-hint-bar.js';

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
