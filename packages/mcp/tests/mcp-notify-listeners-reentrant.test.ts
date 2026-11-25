import { describe, expect, it } from 'vitest';
import { notifyListeners } from '../src/client-lifecycle.js';

describe('notifyListeners snapshot iteration', () => {
  it('does not invoke listeners added reentrantly during the same broadcast', () => {
    let firstCalls = 0;
    let lateCalls = 0;
    const listeners = new Set<() => void>();
    listeners.add(() => {
      firstCalls++;
      listeners.add(() => {
        lateCalls++;
      });
    });

    notifyListeners(listeners);
    expect(firstCalls).toBe(1);
    expect(lateCalls).toBe(0);
  });
});
