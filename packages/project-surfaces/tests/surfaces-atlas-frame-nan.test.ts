import { describe, expect, it } from 'vitest';
import { useCodemapIndexStore } from '../src/atlas/codemap-index-store';
import { applyAtlasFrame } from '../src/atlas/frames';

describe('applyAtlasFrame finite timestamp guard', () => {
  it('ignores non-finite timestamps on codemap.index_updated', () => {
    useCodemapIndexStore.setState({ lastUpdatedAt: 1000 });
    applyAtlasFrame({ type: 'codemap.index_updated', payload: { at: Number.NaN } });
    const after = useCodemapIndexStore.getState().lastUpdatedAt;
    expect(Number.isFinite(after)).toBe(true);
  });
});
