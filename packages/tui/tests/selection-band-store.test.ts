/**
 * Unit tests for the drag-selection highlight band's external store.
 *
 * The store's contract is the load-bearing half of the "no card re-render"
 * guarantee: it notifies ONLY subscribed listeners, so components that never
 * subscribe (the history cards) can never re-render on drag motion. These
 * tests pin that notification contract plus the value-identical suppression
 * that keeps a held drag from spamming re-renders.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  bandFromSelection,
  createSelectionBandStore,
} from '../src/components/history/selection-band-store.js';

describe('SelectionBandStore', () => {
  it('starts at null, notifies subscribers on publish, and returns the latest snapshot', () => {
    const store = createSelectionBandStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    expect(store.getSnapshot()).toBe(null);

    store.publish({ topRow: 2, bottomRow: 4, headRow: 4 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual({ topRow: 2, bottomRow: 4, headRow: 4 });

    unsubscribe();
  });

  it('stops notifying after unsubscribe', () => {
    const store = createSelectionBandStore();
    const active = vi.fn();
    const stale = vi.fn();
    const unsubscribeStale = store.subscribe(stale);
    store.subscribe(active);

    unsubscribeStale();
    store.publish({ topRow: 0, bottomRow: 1, headRow: 1 });

    expect(active).toHaveBeenCalledTimes(1);
    expect(stale).not.toHaveBeenCalled();
  });

  it('suppresses value-identical publishes so a held drag does not spam listeners', () => {
    const store = createSelectionBandStore();
    const listener = vi.fn();
    store.subscribe(listener);

    const band = { topRow: 0, bottomRow: 3, headRow: 3 };
    store.publish(band); // null → band: notifies
    store.publish({ ...band }); // value-identical (new object): suppressed
    store.publish({ topRow: 0, bottomRow: 3, headRow: 2 }); // head moved: notifies

    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toEqual({ topRow: 0, bottomRow: 3, headRow: 2 });
  });

  it('publish(null) after a band notifies; a repeated null does not', () => {
    const store = createSelectionBandStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.publish({ topRow: 1, bottomRow: 2, headRow: 2 });
    store.publish(null);
    store.publish(null);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toBe(null);
  });

  it('bandFromSelection orders the span regardless of drag direction', () => {
    // Drag upward: head above the anchor.
    expect(bandFromSelection({ row: 5 }, { row: 2 })).toEqual({
      topRow: 2,
      bottomRow: 5,
      headRow: 2,
    });
    // Drag downward: head below the anchor.
    expect(bandFromSelection({ row: 2 }, { row: 5 })).toEqual({
      topRow: 2,
      bottomRow: 5,
      headRow: 5,
    });
  });
});
