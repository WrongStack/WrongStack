import { describe, expect, it } from 'vitest';
import { buildCopyRegistry } from '../src/components/history/copy-registry.js';
import { railMargin } from '../src/components/history/entry-helpers.js';

describe('copy icon row', () => {
  it('sits beside a card’s first line of text, not on the margin row above it', () => {
    // A user card (no margin, one row) followed by an assistant card whose rail
    // has a one-row margin above and below two rows of text.
    const heights = new Map<number, number>([
      [1, 1],
      [2, 4],
    ]);
    const registry = buildCopyRegistry({
      renderGroups: [
        { type: 'single', entry: { id: 1, kind: 'user', text: 'question' } },
        { type: 'single', entry: { id: 2, kind: 'assistant', text: 'answer\nmore' } },
      ] as never,
      heightCache: { getHeight: (id: number) => heights.get(id), size: 2 } as never,
      scrolled: true,
      clip: 0,
      tailRows: 0,
      viewportRows: 20,
      iconCol: 70,
      liveToolVisible: false,
    });
    expect(registry.hits.map((hit) => [hit.entryId, hit.startRow])).toEqual([
      [1, 0],
      [2, 2],
    ]);
  });

  it('names the cards whose rail opens with a margin', () => {
    expect(railMargin('assistant')).toBe(1);
    expect(railMargin('thinking')).toBe(1);
    expect(railMargin('user')).toBe(0);
    expect(railMargin('tool')).toBe(0);
  });
});
