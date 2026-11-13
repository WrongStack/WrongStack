import { stat } from 'node:fs/promises';
import type { SessionStore } from '@wrongstack/contracts/types';
import { sessionScopedPath } from '@wrongstack/core/utils';
import type { SessionHistoryWireEntry } from './session-history.js';

/**
 * Whether the session's journal was never written at all: its live transcript exists with
 * zero bytes. The store's strict check needs a lifecycle line to call a journal empty, so a
 * transcript that never got one (an engine's boot session left behind by a resume, a process
 * killed before its first write) read as content and stayed in every history list with empty
 * journals hidden. Summary counters cannot decide this (a journal of `message_appended`
 * events counts zero messages); only the file can. This only decides what a list shows: the
 * background sweep still deletes on the strict check alone. Anything unreadable is unknown.
 */
async function neverWritten(sessionsDir: string | undefined, id: string): Promise<boolean> {
  if (!sessionsDir) return false;
  try {
    return (await stat(sessionScopedPath(sessionsDir, id, '.jsonl'))).size === 0;
  } catch {
    return false;
  }
}

/** An absent/failed emptiness check is unknown, never permission to hide a journal. */
export async function withSessionContentState(
  rows: SessionHistoryWireEntry[],
  store: Pick<SessionStore, 'isEmpty'> & { readonly sessionsDir?: string | undefined },
) {
  const result: Array<SessionHistoryWireEntry & { isEmpty?: boolean }> = rows.map((row) => ({
    ...row,
  }));
  if (!store.isEmpty) return result;
  for (let offset = 0; offset < result.length; offset += 8) {
    await Promise.all(
      result.slice(offset, offset + 8).map(async (row) => {
        try {
          row.isEmpty =
            (await store.isEmpty!(row.id)) || (await neverWritten(store.sessionsDir, row.id));
        } catch {
          /* Unknown content remains visible. */
        }
      }),
    );
  }
  return result;
}
