/**
 * use-history-archive — wires {@link HistoryArchive} into the scroll-back path.
 *
 * The reducer caps the in-memory window (`retainTuiHistory`), so entries that
 * age out are gone from `state.entries`. This hook mirrors every entry to a
 * disk-backed JSONL archive as it appears, and serves pages back when the user
 * scrolls past the oldest in-memory entry. Without it `onRequestOlderEntries`
 * resolves with zero entries and scroll-back silently dead-ends.
 *
 * Scope is one process run. The archive file is truncated at startup because
 * entry ids restart at 1 on resume (`replaySessionMessages(..., 1)`) — keeping
 * a previous run's lines would collide ids and duplicate rows in the view.
 * Cross-run history is `/resume`'s job, not the scroll window's.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Action } from '../app-reducer.js';
import { ARCHIVE_PAGE_SIZE, HistoryArchive, historyArchivePath } from '../history-archive.js';
import type { HistoryEntry } from '../history-entry.js';

interface UseHistoryArchiveOptions {
  entries: readonly HistoryEntry[];
  dispatch: React.Dispatch<Action>;
  /** Root of the session store. Absent for ephemeral (`--no-session`) runs. */
  sessionsDir?: string | undefined;
  /** Current session id; the archive lives beside the session's own files. */
  sessionId?: string | undefined;
}

interface HistoryArchiveResult {
  /** Passed to <ScrollableHistory>; fires when the user reaches the oldest row. */
  onRequestOlderEntries: () => void;
}

export function useHistoryArchive({
  entries,
  dispatch,
  sessionsDir,
  sessionId,
}: UseHistoryArchiveOptions): HistoryArchiveResult {
  const archiveRef = useRef<HistoryArchive | null>(null);
  /** Highest entry id already mirrored to disk. Ids are monotonic per run. */
  const lastArchivedIdRef = useRef(-1);
  /** Lines written this run — the archive's own index is invalidated per write. */
  const appendedCountRef = useRef(0);
  /** Exclusive archive index where the next scroll-back page ends. */
  const nextLoadEndRef = useRef<number | null>(null);
  const loadingRef = useRef(false);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  // Bumped once the archive exists so the append effect re-runs and flushes
  // entries that were created while the async open was still in flight.
  const [archiveGeneration, setArchiveGeneration] = useState(0);

  useEffect(() => {
    if (!sessionsDir || !sessionId) return;
    let disposed = false;
    let created: HistoryArchive | null = null;
    const directory = path.join(sessionsDir, sessionId);

    void (async () => {
      try {
        // `force` swallows ENOENT. Anything else (locked file on Windows,
        // permissions) means we cannot guarantee a clean file — leave the
        // archive unwired rather than appending onto foreign, id-colliding
        // lines that would render as duplicate rows on scroll-back.
        await fsp.rm(historyArchivePath(directory), { force: true });
      } catch {
        return;
      }
      if (disposed) return;
      created = new HistoryArchive(directory);
      archiveRef.current = created;
      setArchiveGeneration((generation) => generation + 1);
    })();

    return () => {
      disposed = true;
      archiveRef.current = null;
      lastArchivedIdRef.current = -1;
      appendedCountRef.current = 0;
      nextLoadEndRef.current = null;
      // Drains the pending write chain before closing the handle.
      void created?.close();
    };
  }, [sessionsDir, sessionId]);

  // Mirror newly added entries. Keyed on the `entries` identity: the reducer
  // replaces the array on every append, and entries reloaded from the archive
  // carry ids at or below the watermark, so they are never re-written.
  useEffect(() => {
    const archive = archiveRef.current;
    if (!archive) return;
    const since = lastArchivedIdRef.current;
    let highest = since;
    let appended = 0;
    for (const entry of entries) {
      if (entry.id <= since) continue;
      archive.append(entry);
      appended++;
      if (entry.id > highest) highest = entry.id;
    }
    if (appended === 0) return;
    lastArchivedIdRef.current = highest;
    appendedCountRef.current += appended;
  }, [entries, archiveGeneration]);

  const onRequestOlderEntries = useCallback(() => {
    if (loadingRef.current) return;

    // The scroll controller waits for `archiveLoading` to clear before it will
    // fire again, so every path below must complete the start/loaded pair.
    const settleEmpty = () => {
      dispatch({ type: 'startArchiveLoad' });
      dispatch({ type: 'archiveLoaded', entries: [] });
    };

    const archive = archiveRef.current;
    if (!archive) {
      settleEmpty();
      return;
    }

    if (nextLoadEndRef.current === null) {
      // The in-memory window is the tail of the archive, so the oldest row on
      // screen sits exactly `entries.length` lines from the end.
      nextLoadEndRef.current = Math.max(0, appendedCountRef.current - entriesRef.current.length);
    }
    const end = nextLoadEndRef.current;
    if (end <= 0) {
      settleEmpty();
      return;
    }

    const start = Math.max(0, end - ARCHIVE_PAGE_SIZE);
    loadingRef.current = true;
    dispatch({ type: 'startArchiveLoad' });
    void archive
      .loadRange(start, end - start)
      .then((loaded) => {
        nextLoadEndRef.current = start;
        dispatch({ type: 'archiveLoaded', entries: loaded });
      })
      .catch(() => {
        // A failed page must not wedge scroll-back: settle the loading flag
        // and leave the cursor put so a retry re-reads the same range.
        dispatch({ type: 'archiveLoaded', entries: [] });
      })
      .finally(() => {
        loadingRef.current = false;
      });
  }, [dispatch]);

  return { onRequestOlderEntries };
}
