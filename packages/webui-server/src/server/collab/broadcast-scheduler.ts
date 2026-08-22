import type { CollabSessionRegistry } from './session-registry.js';

/**
 * CollabBroadcastScheduler — owns the 2s periodic `collab.state` broadcast
 * (6A-4). The interval only re-sends state when a session's participant-set
 * fingerprint changed (join/leave), so an idle session costs one tiny string
 * build per tick instead of a serialize + fan-out. The eager fingerprint
 * record on join/leave is `record()`; the interval compares against it.
 *
 * Extracted behavior-preserving from CollaborationWebSocketHandler:
 * ensure/stop semantics (including `.unref?.()` and fingerprint clearing
 * on stop) are the originals.
 */
export class CollabBroadcastScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly fingerprints = new Map<string, string>();

  constructor(
    private readonly registry: CollabSessionRegistry,
    /** Invoked when a session's state went stale since the last broadcast. */
    private readonly onStaleState: (sessionId: string) => void,
  ) {}

  /** Start the periodic loop if not already running (idempotent). */
  ensure(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      for (const sessionId of this.registry.sessionIds()) {
        if (this.fingerprints.get(sessionId) === this.registry.stateFingerprint(sessionId)) {
          continue;
        }
        this.onStaleState(sessionId);
      }
    }, 2000);
    this.interval.unref?.();
  }

  /** Record the just-broadcast fingerprint so the tick skips unchanged state. */
  record(sessionId: string): void {
    this.fingerprints.set(sessionId, this.registry.stateFingerprint(sessionId));
  }

  /** Drop a session's fingerprint when its bucket emptied (leave path). */
  forget(sessionId: string): void {
    this.fingerprints.delete(sessionId);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.fingerprints.clear();
  }
}
