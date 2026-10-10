/**
 * Regression: session-GC tombstones must not clobber concurrent writes that
 * land between the hygiene listing snapshot and the queued tombstone mutation.
 *
 * The tombstone used to spread the LISTING-TIME snapshot
 * (`{ ...m, status: 'deleted', ... }`). Hygiene runs as a composite op parked
 * off the mutation chain between its reads and mutations, so a real concurrent
 * `updateSage` issued in that window commits before the tombstone mutation —
 * and was then silently reverted by the stale spread:
 *   - an aged-out session memory whose concurrent update refreshed
 *     `updatedAt` (a genuine rescue under the GC's own predicate) was
 *     tombstoned anyway, update and all;
 *   - an `expiresAt`-expired memory was still tombstoned, but with the
 *     concurrent field changes reverted inside the tombstone — recovery
 *     returned the pre-update state.
 *
 * The fix applies the file's in-mutation re-read convention (the purge,
 * verification and reactivation passes): re-read each target, re-evaluate the
 * expiry predicate on the CURRENT row, and build the tombstone from current.
 *
 * Deterministic gap control (the purge-TOCTOU regression's technique, no
 * mocks): the hygiene facade delegates `ctx.listMemories` to the instance
 * method, so an instance-level wrapper performs the REAL concurrent writes
 * exactly between the listing snapshot and the tombstone mutation.
 *
 * Harness notes encoded here: the seeds are anchorless on purpose — the deep
 * verification pass stamps (and refreshes `updatedAt` on) every active
 * memory WITH anchors, which would age-reset the aged-out arm; the status
 * walk passes `includeAllSessions` because owned session-scoped rows are
 * invisible to unscoped listings.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadRuntimeDatabaseSync as loadTestDatabaseSync } from '@wrongstack/persistence';

const DatabaseSync = loadTestDatabaseSync();

import { afterAll, describe, expect, it } from 'vitest';
import { SqliteMemoryPort } from '../src/memory-port.js';

const DAY_MS = 86_400_000;

let port: SqliteMemoryPort | undefined;
let dir: string | undefined;

afterAll(async () => {
  try {
    await port?.dispose?.();
  } catch {
    /* disposal failures must not mask test results */
  }
  if (dir) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      /* locked temp dirs are OS-cleaned */
    }
  }
});

async function stateById(): Promise<
  Map<string, { status: string; confidence: number; importance: number }>
> {
  const map = new Map<string, { status: string; confidence: number; importance: number }>();
  for (const status of ['active', 'stale', 'deleted'] as const) {
    let cursor: string | undefined;
    for (;;) {
      const page = await port!.listSagePage({
        statuses: [status],
        limit: 200,
        includeAllSessions: true,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const mem of page.memories ?? []) {
        map.set(mem.id, {
          status: mem.status,
          confidence: mem.confidence,
          importance: mem.importance,
        });
      }
      if (!page.nextCursor || (page.memories ?? []).length === 0) break;
      cursor = page.nextCursor;
    }
  }
  return map;
}

describe('hygiene session-GC tombstone TOCTOU', () => {
  it('rescues a gap-updated aged-out session memory and preserves gap updates in expired tombstones', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-session-gc-toctou-'));
    let store = new SqliteMemoryPort({ projectRoot: dir });

    const v1 = await store.rememberSage({
      text: 'Aged-out session note that a concurrent update will rescue from GC.',
      scope: 'session',
      ownerSessionId: 'sess-toctou',
      kind: 'fact',
      importance: 0.5,
      confidence: 0.5,
    });
    const v2 = await store.rememberSage({
      text: 'Expired session note whose concurrent field change must survive the tombstone.',
      scope: 'session',
      ownerSessionId: 'sess-toctou',
      kind: 'fact',
      importance: 0.5,
      confidence: 0.5,
      expiresAt: new Date(Date.now() - DAY_MS).toISOString(),
    });
    const c1 = await store.rememberSage({
      text: 'Aged-out session note that nobody rescues; GC must collect it.',
      scope: 'session',
      ownerSessionId: 'sess-toctou',
      kind: 'fact',
      importance: 0.5,
      confidence: 0.5,
    });
    const c2 = await store.rememberSage({
      text: 'Fresh session note well inside the retention window.',
      scope: 'session',
      ownerSessionId: 'sess-toctou',
      kind: 'fact',
      importance: 0.5,
      confidence: 0.5,
    });
    const c3 = await store.rememberSage({
      text: 'Project-scoped expired note that session GC must not touch.',
      kind: 'fact',
      importance: 0.5,
      confidence: 0.5,
      expiresAt: new Date(Date.now() - DAY_MS).toISOString(),
    });

    // Backdate the aged-out pair (column + JSON payload).
    await store.dispose?.();
    const dbPath = path.join(dir, '.wrongstack', 'memories', 'sage.db');
    const backdated = new Date(Date.now() - 3 * DAY_MS).toISOString();
    const raw = new DatabaseSync(dbPath);
    for (const id of [v1.id, c1.id]) {
      raw
        .prepare(
          `UPDATE memories SET updated_at = ?, data = json_set(data, '$.updatedAt', ?) WHERE id = ?`,
        )
        .run(backdated, backdated, id);
    }
    raw.close();

    // Reopen and wrap the listing seam with the real concurrent gap writes.
    store = new SqliteMemoryPort({ projectRoot: dir });
    port = store;
    const realList = store.listMemories.bind(store);
    let gapFired = false;
    (store as unknown as { listMemories: typeof store.listMemories }).listMemories = async (
      opts: Parameters<typeof store.listMemories>[0],
    ) => {
      const rows = await realList(opts);
      if (opts?.status === 'all' && !gapFired) {
        gapFired = true;
        await store.updateSage(v1.id, { confidence: 0.8 }); // rescue via updatedAt refresh
        await store.updateSage(v2.id, { importance: 0.9 }); // content change, still eligible
      }
      return rows;
    };

    const report = await store.hygiene({ sessionRetentionDays: 1 });
    expect(gapFired).toBe(true);
    expect(report.deleted).toBe(2); // v2 + c1 only; v1 was rescued

    const state = await stateById();
    expect(state.get(v1.id)?.status).toBe('active');
    expect(state.get(v1.id)?.confidence).toBe(0.8);
    expect(state.get(v2.id)?.status).toBe('deleted');
    expect(state.get(v2.id)?.importance).toBe(0.9);
    expect(state.get(c1.id)?.status).toBe('deleted');
    expect(state.get(c2.id)?.status).toBe('active');
    expect(state.get(c3.id)?.status).toBe('active');
  });
});
