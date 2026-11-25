import { describe, expect, it } from 'vitest';
import { createH1State } from '../src/runtime/h1-state.js';

describe('createH1State releaseAll cross-key reentrancy', () => {
  it('terminates even when unregister callbacks ping-pong across keys', () => {
    const h1 = createH1State({ count: 0 });
    let steps = 0;
    const offA = () => {
      steps += 1;
      h1.register('b', offB);
    };
    const offB = () => {
      steps += 1;
      h1.register('a', offA);
    };
    h1.register('a', offA);
    h1.releaseAll();
    expect(steps).toBe(2);
    expect(h1.size()).toBe(0);
  });
});
