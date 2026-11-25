import { describe, expect, it } from 'vitest';
import { createSelectionBandStore } from '../src/components/history/selection-band-store.js';

describe('selection-band-store NaN dedupe', () => {
  it('suppresses duplicate publishes containing NaN via Object.is', () => {
    const store = createSelectionBandStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.publish({ topRow: Number.NaN, bottomRow: Number.NaN, headRow: Number.NaN });
    store.publish({ topRow: Number.NaN, bottomRow: Number.NaN, headRow: Number.NaN });
    expect(calls).toBe(1);
  });
});
