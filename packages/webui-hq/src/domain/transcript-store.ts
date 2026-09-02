/**
 * Transcript accumulation for the HQ Live Console.
 *
 * The console has two sources for one conversation:
 *   1. an initial HTTP fetch (`/api/sessions/:id/events`) — for local sessions
 *      this is the DISK replay, where each tool's args + result are already
 *      merged into one entry;
 *   2. the live `session.transcript` stream — where a tool call arrives as an
 *      args entry first and its result arrives LATER as a separate entry
 *      (role tool/error, `toolUseId` set, no `toolInput`).
 *
 * This module reconciles both into a single entry list:
 *   - live result entries are merged INTO the matching args entry (by
 *     `toolUseId`), mirroring the server-side `mergeToolResults`;
 *   - every batch is consumed exactly once (batches are keyed by
 *     `fromSeq`+length, so a re-render never re-appends the ring);
 *   - entries that were already delivered by the fetch are dropped via a
 *     content key, so the fetch/stream overlap never double-renders.
 *
 * Pure data structure — no React, no DOM — so it is trivially unit-testable.
 *
 * @module lib/transcript-store
 */
import type { HqTranscriptEntry } from '@wrongstack/core/hq';

export interface TranscriptState {
  entries: HqTranscriptEntry[];
  /** Content keys of every entry already represented (dedup). */
  seen: Set<string>;
  /** Batch keys (`fromSeq:length`) already folded in (exactly-once). */
  consumedBatches: Set<string>;
  /** Index of open tool cards by toolUseId, for live result merging. */
  openTools: Map<string, number>;
  /** Monotonic revision — bump on every visible change so React can memo. */
  rev: number;
}

export function createTranscriptState(): TranscriptState {
  return { entries: [], seen: new Set(), consumedBatches: new Set(), openTools: new Map(), rev: 0 };
}

/** Identify the output half of a live tool call (to be merged, not appended). */
function isLiveResultEntry(e: HqTranscriptEntry): boolean {
  return (
    (e.role === 'tool' || e.role === 'error') &&
    e.toolUseId !== undefined &&
    e.toolInput === undefined
  );
}

/** Stable content key for dedup across the fetch/stream overlap. */
export function entryKey(e: HqTranscriptEntry): string {
  if (e.toolUseId !== undefined && e.toolInput !== undefined) return `tu:${e.toolUseId}`;
  return `${e.ts}|${e.role}|${e.tool ?? ''}|${e.text}`;
}

/** Fold one entry into the state: merge result-halves, dedup, index tools. */
function foldEntry(next: TranscriptState, src: HqTranscriptEntry): void {
  const e = { ...src };
  if (isLiveResultEntry(e)) {
    const idx = e.toolUseId !== undefined ? next.openTools.get(e.toolUseId) : undefined;
    if (idx !== undefined) {
      const tgt = { ...next.entries[idx]! };
      tgt.text = e.text || '';
      if (e.durationMs !== undefined) tgt.durationMs = e.durationMs;
      if (e.isError) {
        tgt.role = 'error';
        tgt.isError = true;
      }
      next.entries[idx] = tgt;
      return;
    }
    // No open card (history was truncated) — fall through and append.
  }
  const key = entryKey(e);
  if (next.seen.has(key)) return;
  next.seen.add(key);
  if (e.role === 'tool' && e.toolUseId !== undefined && e.toolInput !== undefined) {
    next.openTools.set(e.toolUseId, next.entries.length);
  }
  next.entries.push(e);
}

/**
 * Replace all state with a freshly-fetched history. Disk-replayed histories
 * arrive pre-merged, but stream-ring histories (remote sessions) still carry
 * separate args/result halves — fold them here too so a tool call is always
 * one card regardless of source.
 */
export function applyFetch(
  state: TranscriptState,
  entries: readonly HqTranscriptEntry[],
): TranscriptState {
  const next = createTranscriptState();
  next.rev = state.rev + 1;
  for (const src of entries) foldEntry(next, src);
  return next;
}

/**
 * Fold one live `session.transcript` batch into the state. Returns the same
 * object when the batch was already consumed (no re-render), a new revision
 * otherwise. `fromSeq` may be undefined for defensive callers — the batch is
 * then keyed by its first entry's content.
 */
export function applyLiveBatch(
  state: TranscriptState,
  fromSeq: number | undefined,
  entries: readonly HqTranscriptEntry[],
): TranscriptState {
  if (entries.length === 0) return state;
  const batchKey =
    fromSeq !== undefined
      ? `${fromSeq}:${entries.length}`
      : `k:${entryKey(entries[0]!)}:${entries.length}`;
  if (state.consumedBatches.has(batchKey)) return state;

  const next: TranscriptState = {
    entries: [...state.entries],
    seen: new Set(state.seen),
    consumedBatches: new Set(state.consumedBatches),
    openTools: new Map(state.openTools),
    rev: state.rev + 1,
  };
  next.consumedBatches.add(batchKey);
  for (const src of entries) foldEntry(next, src);
  return next;
}

/** True when a tool entry has no result yet — its call is still in flight. */
export function isToolRunning(e: HqTranscriptEntry): boolean {
  return (
    e.role === 'tool' &&
    e.toolInput !== undefined &&
    e.text === '' &&
    e.durationMs === undefined &&
    e.isError !== true
  );
}
