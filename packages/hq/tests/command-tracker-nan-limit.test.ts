import { describe, expect, it } from 'vitest';
import { CommandTracker } from '../src/publisher-command-tracker.js';

describe('CommandTracker non-finite maxTrackedCommands (F1853)', () => {
  it('falls back to 500 and evicts oldest settled commands when limit is invalid', () => {
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const tracker = new CommandTracker(bad);
      for (let i = 0; i < 600; i++) {
        tracker.remember(`cmd-${i}`, { commandId: `cmd-${i}`, status: 'accepted' });
      }
      expect(tracker.get('cmd-0')).toBeUndefined();
      expect(tracker.get('cmd-599')).toBeDefined();
    }
  });

  it('floors valid positive limits', () => {
    const tracker = new CommandTracker(2.9);
    tracker.remember('a', { commandId: 'a', status: 'accepted' });
    tracker.remember('b', { commandId: 'b', status: 'accepted' });
    tracker.remember('c', { commandId: 'c', status: 'accepted' });
    expect(tracker.get('a')).toBeUndefined();
    expect(tracker.get('b')).toBeDefined();
    expect(tracker.get('c')).toBeDefined();
  });
});
