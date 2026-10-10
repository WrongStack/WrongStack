import type { SlashCommandRegistry } from '@wrongstack/core/registry';
import type { PersistedQueueItem, QueueStore } from '@wrongstack/core/storage';
import type { ContentBlock } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { useEffect, useRef } from 'react';
import type { Action, State } from '../app-reducer.js';
import type { Settings } from '../app-state.js';
import { createQueueSlashCommand } from '../queue-slash.js';

export interface UseQueueManagerOptions {
  /** Optional persistent store — absent => in-memory only (no crash recovery). */
  queueStore?: QueueStore | undefined;
  /**
   * The store of another session. With it, resuming a session brings that
   * session's queue along (the WebUI keeps its queue in the same file) and
   * leaves the previous session's on disk; without it, the queue is dropped.
   */
  queueStoreFor?: ((sessionId: string) => QueueStore | undefined) | undefined;
  /** Called on every queue change so the host learns what's waiting. */
  onQueueChange?: ((items: string[]) => void) | undefined;
  /** Slash registry to register the /queue command. */
  slashRegistry: SlashCommandRegistry;
  /** Live state snapshot (ref, not render-state) for slash command closures. */
  stateRef: React.MutableRefObject<State>;
  dispatch: React.Dispatch<Action>;
  /** Settings access for persisting the mid-run send-mode picker toggle. */
  getSettings?: (() => Settings) | undefined;
  saveSettings?: ((settings: Settings) => string | Promise<string | null> | null) | undefined;
  /** Live mirror of the mid-run send-mode picker enabled flag. */
  midRunSendPickerRef: React.MutableRefObject<boolean>;
}

export interface QueueManager {
  /** Move the queue to the session just resumed: its own queue replaces this one. */
  switchSession(sessionId: string): void;
}

/**
 * Manages the TUI message queue: rehydration from persistent store,
 * persistence on every change, host mirroring, and the /queue slash
 * command. All side-effect wiring extracted from app.tsx.
 */
export function useQueueManager({
  queueStore,
  queueStoreFor,
  onQueueChange,
  slashRegistry,
  stateRef,
  dispatch,
  getSettings,
  saveSettings,
  midRunSendPickerRef,
}: UseQueueManagerOptions): QueueManager {
  const persistState = useRef<{
    running: boolean;
    pending: { store: QueueStore; items: PersistedQueueItem[] } | null;
  }>({ running: false, pending: null });
  // Set once the rehydrate effect has read (or decided there's nothing to
  // restore). Until then the persist effect must NOT write, because on mount
  // the in-memory queue is empty and write([]) maps to QueueStore.clear() —
  // which would unlink the persisted queue.json the rehydrate read is about
  // to restore, silently losing queued messages on every restart.
  const hydrated = useRef(!queueStore);
  // Set when a queue change is observed before the rehydrate read resolves.
  // Those writes must be preserved (not dropped) and flushed once hydration
  // completes.
  const pendingBeforeHydration = useRef(false);
  /** The store the queue is written to: the current session's. */
  const storeRef = useRef(queueStore);
  /** Bumped per read, so a slow read for a session left since is ignored. */
  const hydration = useRef(0);

  // Coalescing queue writer: records the CURRENT in-memory queue into the
  // shared pending slot and drains it. Safe to call repeatedly.
  const writeQueue = (store: QueueStore): void => {
    const raw = stateRef.current.queue.map(
      ({
        displayText,
        blocks,
        shouldRefine,
        journalRaw,
      }: {
        displayText: string;
        blocks: ContentBlock[];
        shouldRefine?: boolean | undefined;
        journalRaw?: string | undefined;
      }) => ({
        displayText,
        blocks,
        ...(shouldRefine !== undefined ? { shouldRefine } : {}),
        ...(journalRaw !== undefined ? { journalRaw } : {}),
      }),
    );
    const persistence = persistState.current;
    persistence.pending = { store, items: raw };
    if (persistence.running) return;
    persistence.running = true;
    void (async () => {
      try {
        while (persistence.pending !== null) {
          const latest = persistence.pending;
          persistence.pending = null;
          await latest.store.write(latest.items).catch(() => undefined);
        }
      } finally {
        persistence.running = false;
      }
    })();
  };

  /** Read `store` into the (empty) queue, then let writes through again. */
  const hydrateFrom = (store: QueueStore, restoredText: (count: number) => string): void => {
    const run = ++hydration.current;
    store
      .read()
      .then((items: PersistedQueueItem[]) => {
        if (run !== hydration.current || storeRef.current !== store) return;
        // Mark hydrated BEFORE dispatching so the persist path can use the
        // current queue (restored items + any user enqueues) without racing.
        hydrated.current = true;
        for (const item of items) {
          dispatch({
            type: 'enqueue',
            item: {
              displayText: item.displayText,
              blocks: item.blocks,
              ...(item.shouldRefine !== undefined ? { shouldRefine: item.shouldRefine } : {}),
              ...(item.journalRaw !== undefined ? { journalRaw: item.journalRaw } : {}),
            },
          });
        }
        if (items.length > 0) {
          dispatch({ type: 'addEntry', entry: { kind: 'info', text: restoredText(items.length) } });
        }
        // Any queue change observed before the read resolved must be flushed
        // now (with the full current queue), or an enqueue made during the
        // pre-hydration window would be lost. This only runs when NOTHING was
        // read: on the read-resolves-with-items path the enqueue dispatches
        // below guarantee a post-render persist write of the restored queue
        // (plus any pre-hydration enqueues), so flushing here with the STILL
        // mount-empty `stateRef.current.queue` would write [] ->
        // QueueStore.clear() -> unlink the freshly-restored file.
        if (pendingBeforeHydration.current && items.length === 0) {
          pendingBeforeHydration.current = false;
          writeQueue(store);
        }
      })
      .catch(() => undefined);
  };

  // ── Rehydrate persisted queue on mount ──────────────────────────────
  useEffect(() => {
    if (!queueStore) return;
    storeRef.current = queueStore;
    hydrateFrom(
      queueStore,
      (n) => `Restored ${n} queued message${n === 1 ? '' : 's'} from a previous run.`,
    );
    return () => {
      hydration.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueStore]);

  // ── Persist queue on every change ──────────────────────────────────
  useEffect(() => {
    const store = storeRef.current;
    if (!store) return;
    if (!hydrated.current) {
      // Queue changed before the rehydrate read resolved. Writing the queue
      // now — the mount-time one is empty, so write([]) -> QueueStore.clear()
      // would unlink the persisted file the read is about to restore. Record
      // the change and let the rehydrate handler flush it after hydration.
      pendingBeforeHydration.current = true;
      return;
    }
    writeQueue(store);
  }, [stateRef.current.queue, stateRef]);

  // ── Mirror queue to host on every change ───────────────────────────
  useEffect(() => {
    onQueueChange?.(stateRef.current.queue.map((q) => q.displayText));
  }, [stateRef.current.queue, onQueueChange, stateRef]);

  // ── Register /queue slash command ──────────────────────────────────
  useEffect(() => {
    const cmd = createQueueSlashCommand({
      getQueue: () => stateRef.current.queue,
      clear: () => dispatch({ type: 'queueClear' }),
      deleteAt: (positions) => dispatch({ type: 'queueDelete', positions }),
      getPickerEnabled: () => midRunSendPickerRef.current,
      setPickerEnabled: (enabled) => {
        midRunSendPickerRef.current = enabled;
        const cur = getSettings?.();
        if (cur && saveSettings) {
          Promise.resolve(saveSettings({ ...cur, midRunSendPicker: enabled })).catch(
            (err: unknown) =>
              dispatch({
                type: 'addEntry',
                entry: {
                  kind: 'error',
                  text: `Could not save queue picker setting: ${toErrorMessage(err)}`,
                },
              }),
          );
        }
      },
    });
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('queue');
    };
  }, [slashRegistry, stateRef, dispatch, getSettings, saveSettings, midRunSendPickerRef]);

  return {
    switchSession(sessionId) {
      const next = queueStoreFor?.(sessionId);
      if (!next) {
        dispatch({ type: 'queueClear' });
        return;
      }
      // The session being left keeps its queue on disk (every change was
      // written as it happened). Nothing is written until the new session's
      // queue is read, so the clear below cannot reach either file.
      storeRef.current = next;
      hydrated.current = false;
      pendingBeforeHydration.current = false;
      dispatch({ type: 'queueClear' });
      hydrateFrom(
        next,
        (n) => `${n} queued message${n === 1 ? ' is' : 's are'} waiting in this session.`,
      );
    },
  };
}
