import { describe, expect, it } from 'vitest';
import { createSelectionBandStore } from '../src/components/history/selection-band-store.js';

describe('createSelectionBandStore re-entrant subscribe guard (F2264)', () => {
  it('does not invoke listeners added during an active publish pass', () => {
    const store = createSelectionBandStore();
    let lateCalled = false;
    store.subscribe(() => {
      store.subscribe(() => {
        lateCalled = true;
      });
    });
    store.publish({ topRow: 1, bottomRow: 2, headRow: 2 });
    expect(lateCalled).toBe(false);
  });
});
