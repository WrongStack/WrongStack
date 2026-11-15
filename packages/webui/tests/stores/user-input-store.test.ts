import { beforeEach, describe, expect, it } from 'vitest';
import {
  pendingUserInputForSession,
  useUserInputStore,
} from '../../src/stores/user-input-store.js';

describe('useUserInputStore Object.prototype safety', () => {
  beforeEach(() => {
    useUserInputStore.getState().reset();
  });

  it('handles Object.prototype sessionId keys in enqueue and pendingUserInputForSession', () => {
    for (const sessionId of ['toString', 'constructor', 'valueOf']) {
      useUserInputStore.getState().enqueue({
        sessionId,
        request: { id: `req-${sessionId}` } as never,
      });
      const pending = pendingUserInputForSession(useUserInputStore.getState().queues, sessionId);
      expect(pending?.request.id).toBe(`req-${sessionId}`);
    }
    expect(pendingUserInputForSession({}, 'toString')).toBeNull();
  });
});
