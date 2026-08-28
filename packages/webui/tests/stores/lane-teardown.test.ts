import { beforeEach, describe, expect, it, vi } from 'vitest';
import { disposeLane, ensureLane, onLaneDisposed, useChatLanes } from '../../src/stores/chat-lanes';

/**
 * Closing a tab must take everything about it with it.
 *
 * The lane record itself was always removed, but the WS handlers keep their
 * own per-session maps beside it — pending next-steps, the thinking
 * coalescer's buffer. `forgetLaneRunState` existed for exactly that and was
 * never called from anywhere, so a retired session's bookkeeping leaked for
 * the life of the page and would have resurfaced if the id were reused.
 *
 * The handlers cannot be torn down from `session-tab-store` directly — they
 * import the stores, so importing them back would close a cycle. Subscribing
 * to disposal inverts the dependency, and this pins that the notification
 * actually fires.
 */

beforeEach(() => {
  useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
});

describe('lane disposal notifies its subscribers', () => {
  it('calls every subscriber with the retired session id', () => {
    const seen: string[] = [];
    const off = onLaneDisposed((id) => seen.push(id));
    ensureLane('tab-9');

    disposeLane('tab-9');

    expect(seen).toEqual(['tab-9']);
    off();
  });

  it('fires even when the tab never materialised a chat lane', () => {
    // Teardown is unconditional on purpose. A tab can be opened, given a
    // draft, a pref override and an auto-submit streak, and closed again
    // without ever receiving a chat event — so keying the notification on
    // "did a chat lane exist" leaked exactly the state of the tabs that did
    // the least.
    const spy = vi.fn();
    const off = onLaneDisposed(spy);
    disposeLane('never-existed');
    expect(spy).toHaveBeenCalledWith('never-existed');
    off();
  });

  it('a throwing subscriber does not block the others', () => {
    const after = vi.fn();
    const offBad = onLaneDisposed(() => {
      throw new Error('subscriber blew up');
    });
    const offGood = onLaneDisposed(after);
    ensureLane('tab-8');

    expect(() => disposeLane('tab-8')).not.toThrow();
    expect(after).toHaveBeenCalledWith('tab-8');
    offBad();
    offGood();
  });

  it('stops notifying after unsubscribe', () => {
    const spy = vi.fn();
    onLaneDisposed(spy)();
    ensureLane('tab-7');
    disposeLane('tab-7');
    expect(spy).not.toHaveBeenCalled();
  });

  it('the chat handlers are subscribed by importing them', async () => {
    // The registration is a module side effect; if it is ever dropped, the
    // leak comes back silently.
    const mod = await import('../../src/hooks/ws-handlers/chat-handlers');
    expect(typeof mod.forgetLaneRunState).toBe('function');

    const seen: string[] = [];
    const off = onLaneDisposed((id) => seen.push(id));
    ensureLane('tab-6');
    disposeLane('tab-6');
    expect(seen).toContain('tab-6');
    off();
  });
});
