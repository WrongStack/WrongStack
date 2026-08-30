import type { HistoryEntry } from './components/history/types.js';

/**
 * Display history is a cache, not the canonical session record. Keep enough
 * recent output for useful scrolling while the complete JSONL session remains
 * available for resume/replay.
 */
export const TUI_HISTORY_MAX_ENTRIES = 400;
export const TUI_HISTORY_MAX_BYTES = 1024 * 1024;
/** No single display entry may monopolize the aggregate history budget. */
export const TUI_HISTORY_MAX_ENTRY_BYTES = 64 * 1024;

const ENTRY_TRUNCATION_MARKER = '… [truncated for TUI history; full session remains on disk]';
const OMITTED_RE = /^… (\d+) earlier TUI entries omitted \(full session remains on disk\)\.$/;

function omittedCount(entry: HistoryEntry): number | null {
  if (entry.kind !== 'info') return null;
  const match = OMITTED_RE.exec(entry.text);
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

/**
 * Serialized size per entry, memoized on the entry object.
 *
 * `retainTuiHistory` runs on EVERY `addEntry`, `replaceHistory` and
 * `compactHistory` dispatch, and it called this twice per retained entry —
 * once from `retainTuiHistoryEntry`'s budget check and once from the
 * keep-window loop below. Measured on a saturated history (400 entries /
 * ~1 MB): 1.35 ms and ~2 MB of transient JSON string per dispatch, on the
 * render thread inside the reducer. A tool-heavy turn firing 150
 * `tool.executed` re-serialized the whole transcript 300 times.
 *
 * A `HistoryEntry` is immutable once committed, so its size is too — and a
 * WeakMap keeps no entry alive past its own retention.
 */
const entryBytesCache = new WeakMap<HistoryEntry, number>();

function entryBytes(entry: HistoryEntry): number {
  const cached = entryBytesCache.get(entry);
  if (cached !== undefined) return cached;
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
  } catch {
    // A non-serializable tool payload must never disable retention.
    bytes = TUI_HISTORY_MAX_BYTES + 1;
  }
  entryBytesCache.set(entry, bytes);
  return bytes;
}

function oversizedEntryMarker(entry: HistoryEntry): HistoryEntry {
  return {
    id: entry.id,
    kind: 'info',
    text: `… oversized ${entry.kind} entry omitted from TUI history (full session remains on disk).`,
  };
}

function retainTextWithinEntryBudget(
  value: string,
  maxBytes: number,
  createEntry: (text: string) => HistoryEntry,
  original: HistoryEntry,
): HistoryEntry {
  if (entryBytes(createEntry(value)) <= maxBytes) return createEntry(value);
  if (entryBytes(createEntry(ENTRY_TRUNCATION_MARKER)) > maxBytes) {
    return oversizedEntryMarker(original);
  }

  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${value.slice(0, middle)}${ENTRY_TRUNCATION_MARKER}`;
    if (entryBytes(createEntry(candidate)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return createEntry(`${value.slice(0, end)}${ENTRY_TRUNCATION_MARKER}`);
}

/**
 * Enforce the per-entry display budget before aggregate history retention.
 * Common text entries keep a readable prefix; unusual oversized structured
 * entries degrade to a small marker rather than retaining an unbounded graph.
 */
function retainTuiHistoryEntry(
  entry: HistoryEntry,
  maxBytes = TUI_HISTORY_MAX_ENTRY_BYTES,
): HistoryEntry {
  if (entryBytes(entry) <= maxBytes) return entry;

  switch (entry.kind) {
    case 'user':
      return retainTextWithinEntryBudget(
        entry.text,
        maxBytes,
        (text) => ({ ...entry, text, pasteContent: undefined }),
        entry,
      );
    case 'assistant':
    case 'thinking':
    case 'info':
    case 'warn':
    case 'error':
    case 'turn-summary':
      return retainTextWithinEntryBudget(
        entry.text,
        maxBytes,
        (text) => ({ ...entry, text }),
        entry,
      );
    case 'subagent':
      return retainTextWithinEntryBudget(
        entry.text,
        maxBytes,
        (text) => ({ ...entry, text, detail: undefined }),
        entry,
      );
    case 'tool': {
      const name = entry.name.length > 1024 ? `${entry.name.slice(0, 1024)}…` : entry.name;
      const output = entry.output ?? '';
      return retainTextWithinEntryBudget(
        output,
        maxBytes,
        (text) => ({ ...entry, name, input: undefined, output: text }),
        entry,
      );
    }
    case 'banner': {
      const truncate = (value: string): string =>
        value.length > 1024 ? `${value.slice(0, 1024)}…` : value;
      const compact: HistoryEntry = {
        id: entry.id,
        kind: 'banner',
        version: truncate(entry.version),
        provider: truncate(entry.provider),
        model: truncate(entry.model),
        cwd: truncate(entry.cwd),
      };
      return entryBytes(compact) <= maxBytes ? compact : oversizedEntryMarker(entry);
    }
    default:
      return oversizedEntryMarker(entry);
  }
}

export interface TuiHistoryBudget {
  maxEntries?: number | undefined;
  maxBytes?: number | undefined;
  maxEntryBytes?: number | undefined;
}

/**
 * Retention budget for a session the user explicitly resumed.
 *
 * The live budget (400 entries / 1 MB) sizes a scrollback window that grows a
 * few entries at a time and is backed by a journal the user can always reopen.
 * A resume is the opposite: the whole conversation arrives at once and IS what
 * was asked for. Measured on this corpus, a 131 MB journal replays to 740
 * entries / 1.28 MB — under the live budget it lost 340 of them to the count
 * cap before the user saw anything, which reads as "resume did not load".
 *
 * These caps still bound the window (a resume cannot make history unbounded)
 * but with roughly 5x headroom over the largest session observed here. The
 * per-entry cap is deliberately NOT raised: one pathological tool payload
 * should never be allowed to consume the whole budget.
 */
export const TUI_RESUME_HISTORY_BUDGET: TuiHistoryBudget = {
  maxEntries: 2000,
  maxBytes: 6 * 1024 * 1024,
};

/**
 * Retain the newest display entries within both a count and serialized-byte
 * budget. The first banner that still fits after per-entry compaction is
 * preserved separately; later banners are discarded. If a banner cannot fit
 * even in compact form, it degrades to the same bounded transcript marker as
 * any other oversized structured entry. An omission marker replaces a
 * discarded transcript prefix. Returns the original array when no work is
 * needed so reducer callers can bail out without scheduling another render.
 */
export function retainTuiHistory(
  entries: HistoryEntry[],
  budget: TuiHistoryBudget = {},
): HistoryEntry[] {
  const maxEntries = Math.max(1, Math.floor(budget.maxEntries ?? TUI_HISTORY_MAX_ENTRIES));
  const maxBytes = Math.max(1, Math.floor(budget.maxBytes ?? TUI_HISTORY_MAX_BYTES));
  const maxEntryBytes = Math.min(
    maxBytes,
    Math.max(1, Math.floor(budget.maxEntryBytes ?? TUI_HISTORY_MAX_ENTRY_BYTES)),
  );
  let banner: HistoryEntry | undefined;
  let previouslyOmitted = 0;
  let markerCount = 0;
  let bannerCount = 0;
  let entryWasTruncated = false;
  const transcript: HistoryEntry[] = [];

  for (const entry of entries) {
    const retainedEntry = retainTuiHistoryEntry(entry, maxEntryBytes);
    if (retainedEntry !== entry) entryWasTruncated = true;
    if (retainedEntry.kind === 'banner') {
      bannerCount += 1;
      banner ??= retainedEntry;
      continue;
    }
    const count = omittedCount(retainedEntry);
    if (count !== null) {
      previouslyOmitted += count;
      markerCount += 1;
      continue;
    }
    transcript.push(retainedEntry);
  }

  let keepFrom = transcript.length;
  let retainedBytes = 0;
  let retainedCount = 0;
  while (keepFrom > 0 && retainedCount < maxEntries) {
    const next = transcript[keepFrom - 1];
    if (!next) break;
    const bytes = entryBytes(next);
    if (retainedCount > 0 && retainedBytes + bytes > maxBytes) break;
    retainedBytes += bytes;
    retainedCount += 1;
    keepFrom -= 1;
  }

  const newlyOmitted = keepFrom;
  if (
    !entryWasTruncated &&
    newlyOmitted === 0 &&
    ((previouslyOmitted === 0 && markerCount === 0) ||
      (previouslyOmitted > 0 && markerCount === 1)) &&
    bannerCount <= 1
  ) {
    return entries;
  }

  const kept = transcript.slice(keepFrom);
  const totalOmitted = previouslyOmitted + newlyOmitted;
  const retained: HistoryEntry[] = [];
  if (banner) retained.push(banner);
  if (totalOmitted > 0) {
    retained.push({
      id: -(totalOmitted + 1),
      kind: 'info',
      text: `… ${totalOmitted} earlier TUI entries omitted (full session remains on disk).`,
    });
  }
  retained.push(...kept);
  return retained;
}
