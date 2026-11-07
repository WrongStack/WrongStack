export interface ChimeraWorkRegistry {
  /** Track one review/cascade promise until it settles. */
  track(work: Promise<void>): boolean;
  /** Snapshot currently pending work for parent-before-child ordering. */
  pending(): Promise<void> | undefined;
  /** Stop accepting new roots after draining all accepted work to a fixed point. */
  drainAndClose(): Promise<void>;
  readonly size: number;
}

/**
 * Session-scoped registry for Chimera review and cascade work.
 *
 * A single Promise slot loses overlapping reviews. A single Promise.all snapshot
 * can also miss cascades or re-reviews registered while an earlier batch is
 * settling. This registry retains every accepted promise and drains repeatedly
 * until no accepted work remains, then seals admission.
 */
export function createChimeraWorkRegistry(): ChimeraWorkRegistry {
  const pending = new Set<Promise<void>>();
  let accepting = true;
  let closePromise: Promise<void> | undefined;

  const track = (work: Promise<void>): boolean => {
    if (!accepting) return false;

    const tracked = Promise.resolve(work).finally(() => {
      pending.delete(tracked);
    });
    // Attach a rejection observer immediately. The owning handler still records
    // its own error, while this prevents a rejected background task from becoming
    // an unhandled rejection before shutdown reaches the registry.
    void tracked.catch(() => undefined);
    pending.add(tracked);
    return true;
  };

  const snapshot = (): Promise<void> | undefined => {
    if (pending.size === 0) return undefined;
    return Promise.allSettled([...pending]).then(() => undefined);
  };

  const drainAndClose = (): Promise<void> => {
    closePromise ??= (async () => {
      // Producers are joined before this method is called. Keep admission open
      // while draining so review completion can synchronously register cascades
      // and cascades can register re-reviews.
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
      accepting = false;
    })();
    return closePromise;
  };

  return {
    track,
    pending: snapshot,
    drainAndClose,
    get size() {
      return pending.size;
    },
  };
}
