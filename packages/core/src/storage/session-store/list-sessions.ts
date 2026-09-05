import type { SessionCatalogProjectClient } from '../../session-catalog/client.js';
import type { SessionSummary } from '../../types/session.js';
import { compareSessionSummaries, matchesSessionFilter } from '../session-summary.js';

/** Upper bound for filtered-listing candidate pools (bounds pathological dirs). */
export const SESSION_FILTER_POOL_LIMIT = 10_000;

/**
 * Merge close-time index rows with directory-scan results, keyed by id.
 * Scanned entries win — their metadata is re-derived from the transcript,
 * so it reflects mid-session activity that index rows (written on close)
 * cannot know about. Indexed-only ids fill gaps; duplicates within the
 * index resolve last-wins, matching append order.
 */
export function mergeIndexWithScan(
  indexed: readonly SessionSummary[],
  scanned: readonly SessionSummary[],
  deletedIds: ReadonlySet<string>,
  limit: number,
): SessionSummary[] {
  const byId = new Map<string, SessionSummary>();
  for (const row of indexed) byId.set(row.id, row);
  // Scanned entries fill gaps and refresh known ids with live metadata;
  // tombstone filtering happens ONCE against the merged map below so a
  // stale close-time row cannot survive a concurrent deletion either
  // (asymmetric filtering would leak it).
  for (const row of scanned) byId.set(row.id, row);
  return [...byId.values()]
    .filter((row) => !deletedIds.has(row.id))
    .sort(compareSessionSummaries)
    .slice(0, limit);
}

export interface ListSessionsHost {
  catalogClient?: SessionCatalogProjectClient | undefined;
  readIndex: () => Promise<readonly SessionSummary[]>;
  listFromDirectoryScan: (limit: number) => Promise<SessionSummary[]>;
  scrubSummaries: (summaries: readonly SessionSummary[]) => SessionSummary[];
  getIndexDeletedIds: () => ReadonlySet<string>;
}

export async function executeListSessions(
  host: ListSessionsHost,
  limit = 20,
): Promise<SessionSummary[]> {
  if (host.catalogClient) {
    const records = await host.catalogClient.call('list_catalog', { limit });
    return host.scrubSummaries(records);
  }
  try {
    // Union of close-time index rows and live JSONL transcripts. A process
    // killed before close() never gets an index row, so an index-only read
    // made killed sessions invisible (or left them as create-time stubs) in
    // /resume whenever any older session had closed cleanly. Scanned
    // metadata wins per id — it is derived from the transcript itself.
    const [indexed, scanned] = await Promise.all([
      host.readIndex(),
      // Wide scan bound: mergeIndexWithScan slices to `limit`, so killed
      // sessions deep in history stay visible instead of being dropped by
      // the user-facing page size before the union runs.
      host.listFromDirectoryScan(SESSION_FILTER_POOL_LIMIT).catch(() => [] as SessionSummary[]),
    ]);
    return host.scrubSummaries(
      mergeIndexWithScan(indexed, scanned, host.getIndexDeletedIds(), limit),
    );
  } catch {
    return [];
  }
}

export async function executeListFilteredSessions(
  host: ListSessionsHost,
  criteria: {
    since?: string | undefined;
    until?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    minTokens?: number | undefined;
    titleContains?: string | undefined;
    limit?: number | undefined;
  },
): Promise<SessionSummary[]> {
  const limit = criteria.limit ?? 100;
  if (host.catalogClient) {
    const records = await host.catalogClient.call('list_catalog', {
      limit,
      ...criteria,
    });
    return host.scrubSummaries(records);
  }
  try {
    // Filter BEFORE slicing over a wide merged pool: capping the pool at
    // `limit` would silently drop matches older than the window (the old
    // index-only path filtered the entire index). The 10k bound covers any
    // realistic history while bounding pathological directories.
    const [indexed, scanned] = await Promise.all([
      host.readIndex(),
      // Same best-effort contract as list(): scan failures enrich nothing
      // but must not blank the filtered result set.
      host.listFromDirectoryScan(SESSION_FILTER_POOL_LIMIT).catch(() => [] as SessionSummary[]),
    ]);
    const pool = mergeIndexWithScan(
      indexed,
      scanned,
      host.getIndexDeletedIds(),
      SESSION_FILTER_POOL_LIMIT,
    );
    // Scrub BEFORE filtering: matchesSessionFilter compares raw titles,
    // while callers display scrubbed ones — filtering first leaked secrets
    // into match decisions (match-oracle) and desynced hit highlighting.
    return host
      .scrubSummaries(pool)
      .filter((s) => matchesSessionFilter(s, criteria))
      .slice(0, limit);
  } catch {
    return [];
  }
}
