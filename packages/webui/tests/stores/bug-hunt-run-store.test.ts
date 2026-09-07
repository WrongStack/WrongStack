import { beforeEach, describe, expect, it } from 'vitest';
import { useBugHuntRunStore } from '../../src/stores/bug-hunt-run-store.js';

describe('bug hunt run store', () => {
  beforeEach(() => useBugHuntRunStore.setState({ runs: {} }));

  it('advances only the matching session and reserves the next request', () => {
    const store = useBugHuntRunStore.getState();
    store.start('session-a', {
      scope: 'packages/webui',
      totalRounds: 3,
      currentRound: 1,
      requestId: 'one',
    });

    expect(store.advance('session-b', 'one')).toBeNull();
    expect(store.advance('session-a', 'other')).toBeNull();
    expect(store.advance('session-a', 'one')).toMatchObject({
      currentRound: 2,
      requestId: '__bug_hunt_continuation_pending__',
    });
    expect(store.advance('session-a', 'one')).toBeNull();

    useBugHuntRunStore.getState().setRequestId('session-a', 'two');
    expect(useBugHuntRunStore.getState().runs['session-a']).toMatchObject({
      currentRound: 2,
      requestId: 'two',
    });
  });

  it('clears a completed or failed hunt', () => {
    const store = useBugHuntRunStore.getState();
    store.start('session-a', { scope: '', totalRounds: 1, currentRound: 1, requestId: 'one' });
    expect(store.advance('session-a', 'one')).toBeNull();
    expect(useBugHuntRunStore.getState().runs['session-a']).toBeUndefined();
  });
});
