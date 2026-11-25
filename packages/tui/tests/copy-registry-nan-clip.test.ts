import { describe, expect, it } from 'vitest';
import { buildCopyRegistry } from '../src/components/history/copy-registry.js';
import type { RenderGroup } from '../src/components/history/tool-group.js';
import type { EntryHeightCache } from '../src/height-cache.js';

describe('buildCopyRegistry (F2170)', () => {
  it('does not emit CopyHit entries with non-finite rows when clip is NaN', () => {
    const reg = buildCopyRegistry({
      renderGroups: [
        {
          type: 'entry',
          entry: { id: 1, kind: 'assistant', text: 'hello' },
        } as unknown as RenderGroup,
      ],
      heightCache: { getHeight: () => 2 } as unknown as EntryHeightCache,
      scrolled: true,
      clip: Number.NaN,
      tailRows: 0,
      viewportRows: 10,
      iconCol: 78,
      liveToolVisible: false,
    });
    expect(reg.hits).toEqual([]);
  });
});
