import { describe, expect, it } from 'vitest';
import { createH1State } from '../src/runtime/h1-state.js';

describe('createH1State register reentrancy', () => {
  it('returns when an unregister callback synchronously re-arms its own key', () => {
    const h1 = createH1State<{ calls: number }>({ calls: 0 });
    const rearm = (): void => {
      h1.state.calls += 1;
      h1.register('hook', rearm);
    };
    const replacement = (): void => {};

    h1.register('hook', rearm);
    h1.register('hook', replacement);

    // Exactly one release of the self-rearming callback; a second would
    // mean the sweep spun on the re-armed handle.
    expect(h1.state.calls).toBe(1);
    expect(h1.keys()).toEqual(['hook']);
    expect(h1.size()).toBe(1);

    // The stale re-arm was dropped: releasing the key must not invoke
    // the already-released rearm() a second time.
    h1.release('hook');
    expect(h1.state.calls).toBe(1);
    expect(h1.size()).toBe(0);
  });

  it('releases each distinct reentrant registration before replacing the slot', () => {
    const h1 = createH1State<{ released: string[] }>({ released: [] });
    const first = (): void => {
      h1.state.released.push('first');
      // Re-arm with a *distinct* handle: must still be released once.
      h1.register('hook', () => h1.state.released.push('second'));
    };

    h1.register('hook', first);
    h1.register('hook', (): void => {});

    expect(h1.state.released).toEqual(['first', 'second']);
    expect(h1.size()).toBe(1);
  });
});

describe('H1 releaseAll reentrancy', () => {
  it('releases ordinary handles once and preserves user state', () => {
    const h1 = createH1State({ count: 7 });
    const calls: string[] = [];
    h1.register('first', () => calls.push('first'));
    h1.register('second', () => calls.push('second'));
    const { releaseAll } = h1;
    releaseAll();
    releaseAll();
    expect(calls).toEqual(['first', 'second']);
    expect(h1.size()).toBe(0);
    expect(h1.state.count).toBe(7);
  });

  it('does not release the active callback twice when it releases its own key', () => {
    const h1 = createH1State({ calls: 0 });
    h1.register('hook', () => {
      h1.state.calls += 1;
      h1.release('hook');
    });
    h1.releaseAll();
    expect(h1.state.calls, 'FAIL: releaseAll must remove a handle before invoking it').toBe(1);
    expect(h1.size()).toBe(0);
  });

  it('does not invoke an already-released callback again after it re-arms once', () => {
    const h1 = createH1State({ calls: 0 });
    const rearm = () => {
      h1.state.calls += 1;
      if (h1.state.calls === 1) h1.register('hook', rearm);
    };
    h1.register('hook', rearm);
    h1.releaseAll();
    expect(h1.state.calls, 'FAIL: releaseAll must drop an already-released re-arm').toBe(1);
    expect(h1.size()).toBe(0);
  });

  it('releases a distinct replacement registered during cleanup', () => {
    const h1 = createH1State<{ calls: string[] }>({ calls: [] });
    const next = () => h1.state.calls.push('next');
    h1.register('hook', () => {
      h1.state.calls.push('prior');
      if (h1.state.calls.length === 1) h1.register('hook', next);
    });
    h1.releaseAll();
    expect(h1.state.calls, 'FAIL: each distinct unregister must run exactly once').toEqual([
      'prior',
      'next',
    ]);
    expect(h1.size()).toBe(0);
  });
});
