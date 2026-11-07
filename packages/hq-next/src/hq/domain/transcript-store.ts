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
import type { HqTranscriptEntry } from '@wrongstack/hq';

export interface TranscriptState {
  entries: HqTranscriptEntry[];
  /** Content keys of every entry already represented (dedup). */
  seen: Set<string>;
  /** Ordered content keys of streamed-text entries from the latest fetch, for contiguous overlap dedup. */
  fetchedStreamedKeys?: string[];
  /** Batch keys (`fromSeq:length`) already folded in (exactly-once). */
  consumedBatches: Set<string>;
  /** Index of open tool cards by toolUseId, for live result merging. */
  openTools: Map<string, number>;
  /** Monotonic revision — bump on every visible change so React can memo. */
  rev: number;
}

export function createTranscriptState(): TranscriptState {
  return {
    entries: [],
    seen: new Set(),
    fetchedStreamedKeys: [],
    consumedBatches: new Set(),
    openTools: new Map(),
    rev: 0,
  };
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

/**
 * True for a plain streamed-text entry — the shape the agent monitor emits one
 * of per `provider.text_delta` / `thinking_delta`.
 */
function isStreamedText(e: HqTranscriptEntry): boolean {
  return (
    (e.role === 'assistant' || e.role === 'thinking') &&
    e.tool === undefined &&
    e.toolUseId === undefined
  );
}

/**
 * Fold one entry into the state: merge result-halves, dedup, index tools.
 *
 * `recordSeen` controls whether the entry JOINS the content-key set, as
 * opposed to merely being checked against it. The set exists for one job: the
 * fetch/stream overlap (see the module header). The fetch records, so live
 * entries it already delivered are dropped. Live streamed TEXT must not
 * record, because a delta stream legitimately repeats itself — dozens of
 * one-word entries share a timestamp and recur (' the', a comma, a newline) —
 * and recording them made every repeat after the first vanish from the
 * rendered message. Live non-text entries still record, so a re-delivered
 * batch is not left entirely unguarded.
 */
function foldEntry(next: TranscriptState, src: HqTranscriptEntry, isFromFetch: boolean): void {
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
  const streamed = isStreamedText(e);
  if (!streamed) {
    if (next.seen.has(key)) {
      if (e.toolUseId !== undefined && e.toolInput !== undefined && !isToolRunning(e)) {
        const idx = next.openTools.get(e.toolUseId);
        if (idx !== undefined && isToolRunning(next.entries[idx]!)) {
          const tgt = { ...next.entries[idx]! };
          tgt.text = e.text || '';
          if (e.durationMs !== undefined) tgt.durationMs = e.durationMs;
          if (e.isError) {
            tgt.role = 'error';
            tgt.isError = true;
          }
          next.entries[idx] = tgt;
        }
      }
      return;
    }
    next.seen.add(key);
  } else if (isFromFetch) {
    next.fetchedStreamedKeys = next.fetchedStreamedKeys ?? [];
    next.fetchedStreamedKeys.push(key);
  }
  if (
    (e.role === 'tool' || e.role === 'error') &&
    e.toolUseId !== undefined &&
    e.toolInput !== undefined
  ) {
    next.openTools.set(e.toolUseId, next.entries.length);
  }
  next.entries.push(e);
}

function foldLiveSequence(next: TranscriptState, entries: readonly HqTranscriptEntry[]): void {
  const tail = next.fetchedStreamedKeys ?? [];
  const incomingStreamedKeys = entries.filter(isStreamedText).map(entryKey);
  let skipStreamed = 0;

  if (tail.length > 0 && incomingStreamedKeys.length > 0) {
    // 1. Check if the entire incoming streamed-text sequence is a contiguous slice of `tail`.
    let fullMatchEnd = -1;
    if (incomingStreamedKeys.length <= tail.length) {
      for (let i = 0; i <= tail.length - incomingStreamedKeys.length; i++) {
        let matches = true;
        for (let j = 0; j < incomingStreamedKeys.length; j++) {
          if (tail[i + j] !== incomingStreamedKeys[j]) {
            matches = false;
            break;
          }
        }
        if (matches) {
          fullMatchEnd = i + incomingStreamedKeys.length;
          break;
        }
      }
    }

    if (fullMatchEnd !== -1) {
      skipStreamed = incomingStreamedKeys.length;
      next.fetchedStreamedKeys = tail.slice(fullMatchEnd);
    } else {
      // 2. Otherwise find the longest suffix of `tail` matching a prefix of `incomingStreamedKeys`.
      const maxOverlap = Math.min(tail.length, incomingStreamedKeys.length);
      for (let k = maxOverlap; k >= 1; k--) {
        let matches = true;
        for (let j = 0; j < k; j++) {
          if (tail[tail.length - k + j] !== incomingStreamedKeys[j]) {
            matches = false;
            break;
          }
        }
        if (matches) {
          skipStreamed = k;
          break;
        }
      }
      next.fetchedStreamedKeys = [];
    }
  }

  for (const src of entries) {
    if (isStreamedText(src) && skipStreamed > 0) {
      skipStreamed -= 1;
      continue;
    }
    foldEntry(next, src, false);
  }
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
  next.consumedBatches = new Set(state.consumedBatches);
  for (const src of entries) foldEntry(next, src, true);
  foldLiveSequence(next, state.entries);
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
    fetchedStreamedKeys: [...(state.fetchedStreamedKeys ?? [])],
    consumedBatches: new Set(state.consumedBatches),
    openTools: new Map(state.openTools),
    rev: state.rev + 1,
  };
  next.consumedBatches.add(batchKey);
  foldLiveSequence(next, entries);
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
