import { describe, expect, it } from 'vitest';
import { desktopOfficeFeed } from '../src/desktop-office-feed.js';

describe('desktopOfficeFeed start ownership and synchronous throw cleanup', () => {
  function makeClient() {
    const listeners = new Map<string, Set<(msg: unknown) => void>>();
    let liveSubs = 0;
    const client = {
      on(type: string, fn: (msg: unknown) => void) {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
        liveSubs++;
        return () => {
          if (set.delete(fn)) liveSubs--;
        };
      },
      findMemoriesForFile() {},
    } as never;
    return { client, liveCount: () => liveSubs };
  }

  it('cleans up all registered listeners if initial send() throws synchronously', () => {
    const { client, liveCount } = makeClient();
    const { start } = desktopOfficeFeed({
      client,
      send() {
        throw new Error('socket closed');
      },
      projectName: 'demo',
    });

    expect(() => start()).toThrow('socket closed');
    expect(liveCount()).toBe(0);
  });

  it('tears down prior subscriptions when start() is called again and swallows synchronous pingFleet throws', () => {
    const { client, liveCount } = makeClient();
    const { start } = desktopOfficeFeed({
      client,
      send() {},
      projectName: 'demo',
      pingFleet() {
        throw new Error('sync ping error');
      },
    });

    const stop1 = start();
    const initialSubs = liveCount();
    expect(initialSubs).toBeGreaterThan(0);

    const stop2 = start();
    expect(liveCount()).toBe(initialSubs);

    // Calling superseded stop1 must not affect stop2's active subscriptions
    stop1();
    expect(liveCount()).toBe(initialSubs);

    stop2();
    expect(liveCount()).toBe(0);
  });
});
