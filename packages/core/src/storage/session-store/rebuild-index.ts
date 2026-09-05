import type { SessionCatalogProjectClient } from '../../session-catalog/client.js';
import type { SessionSummary } from '../../types/session.js';
import { atomicWrite, withFileLock } from '../../utils/atomic-write.js';

export interface RebuildIndexHost {
  catalogClient?: SessionCatalogProjectClient | undefined;
  indexFile: string;
  dir: string;
  readIndex: () => Promise<readonly SessionSummary[]>;
  collectSessionIds: (dir: string) => Promise<string[]>;
  summaryFor: (id: string) => Promise<SessionSummary>;
  getIndexDeletedIds: () => ReadonlySet<string>;
  clearIndexCache: () => void;
}

/**
 * Rebuild the index from what is actually on disk.
 *
 * @returns the number of healthy, live entries in the rebuilt index. Both
 * backends report that same quantity: ids whose summary could not be derived
 * are excluded (the catalog counts them as `damaged`; the local scan drops
 * them when `summaryFor` rejects), and ids carrying a surviving tombstone are
 * excluded (the catalog rebuilds only from live files; the local branch skips
 * them explicitly). It is NOT a count of rows written to the file — tombstone
 * rows are persisted but never counted.
 */
export async function executeRebuildIndex(host: RebuildIndexHost): Promise<number> {
  if (host.catalogClient) {
    const result = await host.catalogClient.call('rebuild_catalog', {}, { timeoutMs: 120_000 });
    return result.indexed;
  }
  // Snapshot + write under the same lock so a concurrent writeTombstone
  // or create-row cannot land between the read and the atomic replace
  // (that hole resurrected deleted ids or dropped a just-created row).
  return withFileLock(host.indexFile, async () => {
    await host.readIndex();
    const ids = await host.collectSessionIds(host.dir);
    const summaries = await Promise.all(ids.map((id) => host.summaryFor(id).catch(() => null)));
    const valid = summaries.filter((s): s is SessionSummary => s !== null);
    const parts: string[] = [];
    // Scanned-but-tombstoned ids: their files still exist so the scan finds
    // them, but writing a summary row would undelete them. Counted only to
    // subtract from the documented return value.
    let tombstoned = 0;
    const deletedIds = host.getIndexDeletedIds();
    for (const s of valid) {
      if (deletedIds.has(s.id)) {
        tombstoned++;
        continue;
      }
      parts.push(JSON.stringify(s));
    }
    for (const id of deletedIds) {
      parts.push(JSON.stringify({ action: 'delete', id }));
    }
    const lines = parts.join('\n') + '\n';
    await atomicWrite(host.indexFile, lines, { mode: 0o600 });
    host.clearIndexCache();
    return valid.length - tombstoned;
  });
}
