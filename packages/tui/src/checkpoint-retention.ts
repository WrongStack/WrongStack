/**
 * Bounded retention for the session checkpoint list (`state.checkpoints`).
 *
 * Mirrors the dual-budget pattern of history-retention.ts: the checkpoint
 * list is a display index into the canonical session record, not the record
 * itself. The JSONL session log still carries every `checkpoint` event, so
 * pruning old in-memory rows loses nothing — `/rewind` simply shows the
 * newest slice. Without a bound, resuming a long session rebuilt every
 * checkpoint ever written into memory (see buildRestoredCheckpoints) and
 * the live `checkpointReceived` reducer appended forever.
 *
 * This module is pure TypeScript — no React, no Ink.
 */

import type { State } from './app-state.js';

export type CheckpointEntry = State['checkpoints'][number];

/** Default maximum number of retained checkpoints. */
export const TUI_CHECKPOINTS_MAX_ENTRIES = 200;

/** Default maximum serialized bytes across all retained checkpoints. */
const TUI_CHECKPOINTS_MAX_BYTES = 256 * 1024;

interface CheckpointBudget {
  maxEntries?: number | undefined;
  maxBytes?: number | undefined;
}

function entryBytes(entry: CheckpointEntry): number {
  try {
    return Buffer.byteLength(JSON.stringify(entry), 'utf8');
  } catch {
    // A non-serializable entry must never disable retention.
    return TUI_CHECKPOINTS_MAX_BYTES + 1;
  }
}

/**
 * Retain the newest checkpoints within both a count and serialized-byte
 * budget. Checkpoints are chronological (ascending promptIndex), so the
 * newest entries are at the end of the array. Like retainTuiHistory, at
 * least one entry is always kept — dropping the only checkpoint would make
 * `/rewind` report "no checkpoints" for a session that has one.
 *
 * Returns the ORIGINAL array reference when nothing needs pruning so
 * reducer callers can bail out without scheduling another render.
 */
export function retainCheckpoints(
  checkpoints: CheckpointEntry[],
  budget: CheckpointBudget = {},
): CheckpointEntry[] {
  const maxEntries = Math.max(1, Math.floor(budget.maxEntries ?? TUI_CHECKPOINTS_MAX_ENTRIES));
  const maxBytes = Math.max(1, Math.floor(budget.maxBytes ?? TUI_CHECKPOINTS_MAX_BYTES));

  let keepFrom = checkpoints.length;
  let retainedBytes = 0;
  let retainedCount = 0;
  while (keepFrom > 0 && retainedCount < maxEntries) {
    const next = checkpoints[keepFrom - 1];
    if (!next) break;
    const bytes = entryBytes(next);
    if (retainedCount > 0 && retainedBytes + bytes > maxBytes) break;
    retainedBytes += bytes;
    retainedCount += 1;
    keepFrom -= 1;
  }

  if (keepFrom === 0) return checkpoints;
  return checkpoints.slice(keepFrom);
}
