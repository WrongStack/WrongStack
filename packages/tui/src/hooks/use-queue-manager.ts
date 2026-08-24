import type { SlashCommandRegistry } from '@wrongstack/core/registry';
import type { PersistedQueueItem, QueueStore } from '@wrongstack/core/storage';
import type { ContentBlock } from '@wrongstack/core/types';
import { useEffect, useRef } from 'react';
import type { Action, State } from '../app-reducer.js';
import type { Settings } from '../app-state.js';
import { createQueueSlashCommand } from '../queue-slash.js';

export interface UseQueueManagerOptions {
  /** Optional persistent store — absent => in-memory only (no crash recovery). */
  queueStore?: QueueStore | undefined;
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

/**
 * Manages the TUI message queue: rehydration from persistent store,
 * persistence on every change, host mirroring, and the /queue slash
 * command. All side-effect wiring extracted from app.tsx.
 */
export function useQueueManager({
  queueStore,
  onQueueChange,
  slashRegistry,
  stateRef,
  dispatch,
  getSettings,
  saveSettings,
  midRunSendPickerRef,
}: UseQueueManagerOptions): void {
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

  // ── Rehydrate persisted queue on mount ──────────────────────────────
  useEffect(() => {
    if (!queueStore) return;
    let cancelled = false;
    queueStore
      .read()
      .then((items: PersistedQueueItem[]) => {
        if (cancelled) return;
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
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'info',
              text: `Restored ${items.length} queued message${items.length === 1 ? '' : 's'} from a previous run.`,
            },
          });
        }
        // Any queue change observed before the read resolved must be flushed
        // now (with the full current queue), or an enqueue made during the
        // pre-hydration window would be lost.
        if (pendingBeforeHydration.current) {
          pendingBeforeHydration.current = false;
          writeQueue(queueStore);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueStore]);

  // ── Persist queue on every change ──────────────────────────────────
  useEffect(() => {
    if (!queueStore) return;
    if (!hydrated.current) {
      // Queue changed before the rehydrate read resolved. Writing the queue
      // now — the mount-time one is empty, so write([]) -> QueueStore.clear()
      // would unlink the persisted file the read is about to restore. Record
      // the change and let the rehydrate handler flush it after hydration.
      pendingBeforeHydration.current = true;
      return;
    }
    writeQueue(queueStore);
  }, [stateRef.current.queue, queueStore, stateRef]);

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
          Promise.resolve(saveSettings({ ...cur, midRunSendPicker: enabled })).catch(() => {});
        }
      },
    });
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('queue');
    };
  }, [slashRegistry, stateRef, dispatch, getSettings, saveSettings, midRunSendPickerRef]);
}
