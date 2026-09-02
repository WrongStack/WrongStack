/**
 * Pure helper for the "Live feed" mode of {@link MailboxView}: takes the
 * same raw HQ events + snapshot counters that {@link mailbox-grouping}
 * consumes and produces a single chronologically-sorted, deduplicated
 * timeline of every message, suitable for a flat (non-grouped-by-project)
 * feed view.
 *
 * Design notes:
 *   - We reuse {@link groupMailboxEvents} as the source of truth for
 *     dedup + per-project counter resolution, then flatten its
 *     `ProjectGroup.messages` arrays into one timeline. This keeps the
 *     snapshot-vs-event counter rule (snapshot wins; never double-count)
 *     in a single place — changing it in `mailbox-grouping` automatically
 *     keeps the live feed consistent.
 *   - Optional filters: `type` (single type or set), `priority` (set),
 *     `projectId` (set), `includeCompleted`. The component composes
 *     these from UI state; the helper is pure so it's trivial to test.
 *   - Sort: newest-first by `message.timestamp`. Stable across equal
 *     timestamps (ties broken by `mailId` so deterministic output).
 *
 * Extracted as a pure helper (no React) so it can be unit-tested without
 * jsdom, matching the pattern set by `mailbox-grouping.test.ts`.
 */
import type {
  HqEventEnvelope,
  HqMailboxMessageType,
  HqMailboxPriority,
  HqSnapshot,
} from '@wrongstack/core/hq';
import { type FlatMessage, groupMailboxEvents } from './mailbox-grouping.js';

export interface LiveFeedFilters {
  /** Restrict to one or more message types. Empty/undefined = all types. */
  types?: readonly HqMailboxMessageType[] | undefined;
  /** Restrict to one or more priority levels. Empty/undefined = all. */
  priorities?: readonly HqMailboxPriority[] | undefined;
  /** Restrict to one or more projectIds. Empty/undefined = all. */
  projectIds?: readonly string[] | undefined;
  /** When false, completed messages are hidden (default: true). */
  includeCompleted?: boolean | undefined;
  /**
   * Case-insensitive substring filter applied to subject + from + to +
   * bodyPreview. Empty/undefined = no text filter.
   */
  query?: string | undefined;
  /**
   * Maximum number of timeline entries to return. The full timeline is
   * always computed and the truncation is the LAST step, so the caller
   * can pass `Infinity` to disable. Default: 500 (a comfortable "live
   * scroll" budget; virtualisation kicks in above this).
   */
  limit?: number | undefined;
}

export interface LiveTimelineEntry {
  /** Unique key for React rendering. */
  key: string;
  /** The original FlatMessage (so callers can reuse MessageRow). */
  flat: FlatMessage;
}

export interface LiveFeedResult {
  /** Total entries that matched the filters, before `limit` truncation. */
  totalMatched: number;
  /** Total entries returned (≤ limit). */
  returned: number;
  /**
   * `true` if `limit` truncated the result. The UI can show a "showing
   * N of M — refine filters" hint when this is set.
   */
  truncated: boolean;
  /** Newest-first timeline. */
  entries: LiveTimelineEntry[];
}

/**
 * Apply {@link LiveFeedFilters} to a `FlatMessage[]` and produce a sorted
 * timeline. The function is intentionally a single pass over the input
 * (filter + sort) — the message volume in a typical HQ session is in
 * the low thousands and the helper is called from `useMemo`, so a
 * `O(n log n)` sort is acceptable. Memory: a single output array,
 * no intermediate copies.
 */
export function buildLiveFeed(
  flatMessages: readonly FlatMessage[],
  filters: LiveFeedFilters = {},
): LiveFeedResult {
  const includeCompleted = filters.includeCompleted ?? true;
  const types = filters.types && filters.types.length > 0 ? new Set(filters.types) : null;
  const priorities =
    filters.priorities && filters.priorities.length > 0 ? new Set(filters.priorities) : null;
  const projectIds =
    filters.projectIds && filters.projectIds.length > 0 ? new Set(filters.projectIds) : null;
  const q = filters.query?.trim().toLowerCase() ?? '';
  const limit = filters.limit ?? 500;

  const matched: LiveTimelineEntry[] = [];
  for (const flat of flatMessages) {
    const m = flat.message;
    if (!includeCompleted && m.completed) continue;
    if (types && !types.has(m.type)) continue;
    if (priorities && !priorities.has(m.priority)) continue;
    if (projectIds) {
      // Live feed does not know projectId from the message itself (it
      // is attached to the event envelope, not the message). Callers
      // who want projectId filtering must filter BEFORE calling
      // buildLiveFeed — `groupMailboxEvents` returns a per-project
      // breakdown, so the caller is expected to either pass an
      // already-projected FlatMessage[] or pre-filter by project. Here
      // we skip the projectId check on purpose and document it.
      continue;
    }
    if (q.length > 0) {
      const hay = `${m.subject}\n${m.from}\n${m.to}\n${m.bodyPreview ?? ''}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    matched.push({ key: flat.key, flat });
  }

  // Sort newest-first; ties broken by mailId so the order is stable
  // across re-renders for the same event set.
  matched.sort((a, b) => {
    const t = b.flat.message.timestamp.localeCompare(a.flat.message.timestamp);
    if (t !== 0) return t;
    return a.flat.message.mailId.localeCompare(b.flat.message.mailId);
  });

  const totalMatched = matched.length;
  const truncated = totalMatched > limit;
  const entries = truncated ? matched.slice(0, limit) : matched;
  return {
    totalMatched,
    returned: entries.length,
    truncated,
    entries,
  };
}

/**
 * Convenience wrapper: feed a snapshot + events stream and a filters
 * object, get a {@link LiveFeedResult}. Internally delegates to
 * {@link groupMailboxEvents} for the dedup/counter resolution so the
 * two views (grouped + live) can never disagree on the underlying
 * message set.
 *
 * When the caller needs project-scoped feeds, the projectId filter
 * can be applied by pre-filtering `groupMailboxEvents`'s output to the
 * project(s) of interest before calling this helper.
 */
export function buildLiveFeedFromHq(
  snapshot: Pick<HqSnapshot, 'mailboxes'> | null,
  events: readonly HqEventEnvelope[],
  filters: LiveFeedFilters & { projectIds?: readonly string[] } = {},
): LiveFeedResult {
  const { projectIds, ...rest } = filters;
  const grouped = groupMailboxEvents(snapshot, events);
  let flat: FlatMessage[] = [];
  // Treat an explicit empty array the same as `undefined` — the caller
  // hasn't picked a project yet, so don't accidentally drop every row.
  const projectFilterActive =
    projectIds !== undefined && projectIds.length > 0 ? new Set(projectIds) : null;
  for (const g of grouped.projects) {
    if (projectFilterActive && !projectFilterActive.has(g.projectId)) continue;
    flat = flat.concat(g.messages);
  }
  return buildLiveFeed(flat, rest);
}
