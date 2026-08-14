import { attachTodosCheckpoint } from '@wrongstack/core/storage';
import { sessionScopedPath } from '@wrongstack/core/utils';

export function createStandaloneTodosCheckpointLifecycle(input: {
  state: Parameters<typeof attachTodosCheckpoint>[0];
  sessionsDir: string;
  sessionId: string;
  events?: Parameters<typeof attachTodosCheckpoint>[3];
  traceId?: string | undefined;
  warn?: ((message: string) => void) | undefined;
}): {
  rebind: (sessionId: string, sessionsDir: string) => Promise<void>;
  detach: () => Promise<void>;
} {
  let checkpointSessionId = input.sessionId;
  let checkpointSessionsDir = input.sessionsDir;
  const attachCheckpoint = (sessionId: string, sessionsDir: string) =>
    attachTodosCheckpoint(
      input.state,
      sessionScopedPath(sessionsDir, sessionId, '.todos.json'),
      sessionId,
      input.events,
      input.traceId,
      input.warn,
    );
  let detachCurrent = attachCheckpoint(input.sessionId, input.sessionsDir);
  let checkpointAttached = true;
  const detachCurrentCheckpoint = async (): Promise<void> => {
    if (!checkpointAttached) return;
    checkpointAttached = false;
    await detachCurrent();
  };
  let transitionTail = Promise.resolve();

  const rebind = (nextSessionId: string, sessionsDir: string): Promise<void> => {
    const transition = transitionTail.then(async () => {
      if (
        checkpointAttached &&
        nextSessionId === checkpointSessionId &&
        sessionsDir === checkpointSessionsDir
      ) {
        return;
      }
      let detachFailed = false;
      let detachError: unknown;
      try {
        await detachCurrentCheckpoint();
      } catch (error) {
        // The listener unsubscribes before its final flush. The runtime has
        // already selected the next session, so bind that session even when
        // the old flush reports a failure; reattaching the old session would
        // persist future todos into the wrong sidecar.
        detachFailed = true;
        detachError = error;
      }
      const nextDetach = attachCheckpoint(nextSessionId, sessionsDir);
      checkpointSessionId = nextSessionId;
      checkpointSessionsDir = sessionsDir;
      detachCurrent = nextDetach;
      checkpointAttached = true;
      if (detachFailed) throw detachError;
    });
    transitionTail = transition.catch(() => undefined);
    return transition;
  };

  return {
    rebind,
    detach: async (): Promise<void> => {
      await transitionTail;
      await detachCurrentCheckpoint();
    },
  };
}
