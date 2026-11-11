import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';
import { rejectSqliteCandidate } from '../src/sqlite-store-candidates.js';
import { upsertSqliteCandidate } from '../src/sqlite-store-upsert.js';
import type { MemoryCandidate } from '../src/types.js';

/**
 * Reject-vs-accept claim race regression.
 *
 * `acceptSqliteCandidate` and `resolveSqliteCandidate` both claim a candidate
 * with a pending-guarded CAS UPDATE; a reject used a plain
 * `INSERT OR REPLACE` upsert whose decision was made from a `SELECT` taken
 * before the write. Cross-process, a reject whose SELECT predates a
 * concurrent accept's claim could overwrite the accepted candidate (with its
 * `memoryId` link) as `rejected`, losing the accept. The reject now uses the
 * same pending-guarded CAS: it loses the race (`false`) instead of clobbering.
 *
 * The harness forces the interleave from ONE thread by parking the
 * concurrent accept inside the reject read itself: the wrapped statement
 * returns the pre-claim pending row and lands the accept's claim+annotation
 * before the reject's write runs — exactly the statement order a losing
 * multi-process race produces (SELECT snapshot → other writer commits →
 * stale-snapshot write).
 */

type StoreInternals = {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
};
const internals = (store: SqliteSageStore): StoreInternals => store as unknown as StoreInternals;

let directory: string;
let stores: SqliteSageStore[];

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-sage-reject-race-'));
  stores = [];
});

afterEach(async () => {
  for (const store of stores) store.close();
  await fs.rm(directory, { recursive: true, force: true });
});

function createStore(): SqliteSageStore {
  const store = new SqliteSageStore({ projectRoot: directory });
  stores.push(store);
  return store;
}

async function initialize(store: SqliteSageStore): Promise<void> {
  // Lazy initialize: the first store call runs initializeOnce.
  await store.getSage('__initialize__');
}

function rowOf(
  store: SqliteSageStore,
  candidateId: string,
): { status: string; memoryId?: string; reason?: string } {
  const row = internals(store)
    .stmt('SELECT data, status FROM candidates WHERE id = ?')
    .get(candidateId) as { data: string; status: string } | undefined;
  expect(row, `candidate ${candidateId} must exist`).toBeTruthy();
  const parsed = JSON.parse(row!.data) as { memoryId?: string; reason?: string };
  return {
    status: row!.status,
    ...(parsed.memoryId !== undefined ? { memoryId: parsed.memoryId } : {}),
    ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
  };
}

describe('rejectSqliteCandidate claim race', () => {
  it('loses to a concurrent accept instead of clobbering the accepted candidate', async () => {
    const store = createStore();
    await initialize(store);
    const candidate = await store.createCandidate({
      text: 'Reject race target sentence.',
      kind: 'fact',
      scope: 'project',
    });

    const realStmt = (sql: string) => internals(store).stmt(sql);
    const audits: string[] = [];
    let acceptLanded = false;
    // Land the concurrent accept the moment the reject's SELECT returns the
    // stale pending row: claim + annotate, the terminal state accept ends in.
    const landAccept = (candidateId: string): void => {
      acceptLanded = true;
      realStmt(
        "UPDATE candidates SET data = ?, status = 'accepted', updated_at = ? WHERE id = ?",
      ).run(
        JSON.stringify({
          ...candidate,
          status: 'accepted',
          memoryId: 'mem_concurrent_accept',
          updatedAt: new Date().toISOString(),
        }),
        new Date().toISOString(),
        candidateId,
      );
    };
    const racingStmt = ((sql: string) => {
      const prepared = realStmt(sql);
      if (/^SELECT[\s\S]*status = 'pending'/.test(sql)) {
        return {
          get: (...args: unknown[]) => {
            const row = (prepared.get as (...getArgs: unknown[]) => unknown)(...args);
            if (row) landAccept(args[0] as string);
            return row;
          },
          run: prepared.run.bind(prepared),
          all: prepared.all.bind(prepared),
        };
      }
      return prepared;
    }) as typeof realStmt;

    const outcome = rejectSqliteCandidate(
      {
        stmt: racingStmt,
        upsertCandidate: (c: MemoryCandidate, canonical?: string) =>
          upsertSqliteCandidate(realStmt, c, canonical),
        nowIso: () => new Date().toISOString(),
        audit: (event: string) => audits.push(event),
      },
      candidate.id,
      'race loser',
    );

    expect(acceptLanded).toBe(true); // the interleave was actually forced
    expect(outcome).toBe(false); // reject must lose the claim, not clobber
    const row = rowOf(store, candidate.id);
    expect(row.status).toBe('accepted');
    expect(row.memoryId).toBe('mem_concurrent_accept');
    expect(row.reason).toBeUndefined();
    expect(audits).toEqual([]); // no rejection audited for a lost claim
  });

  it('still rejects a pending candidate when no concurrent accept lands', async () => {
    const store = createStore();
    await initialize(store);
    const candidate = await store.createCandidate({
      text: 'Plain reject control sentence.',
      kind: 'fact',
      scope: 'project',
    });
    const realStmt = (sql: string) => internals(store).stmt(sql);
    const audits: string[] = [];
    const outcome = rejectSqliteCandidate(
      {
        stmt: realStmt,
        upsertCandidate: (c: MemoryCandidate, canonical?: string) =>
          upsertSqliteCandidate(realStmt, c, canonical),
        nowIso: () => new Date().toISOString(),
        audit: (event: string) => audits.push(event),
      },
      candidate.id,
      'operator declined',
    );
    expect(outcome).toBe(true);
    const row = rowOf(store, candidate.id);
    expect(row.status).toBe('rejected');
    expect(row.reason).toBe('operator declined');
    expect(audits).toEqual(['memory.candidate_rejected']);
  });

  it('returns false for an unknown or already-resolved candidate', async () => {
    const store = createStore();
    await initialize(store);
    const realStmt = (sql: string) => internals(store).stmt(sql);
    const ctx = {
      stmt: realStmt,
      upsertCandidate: (c: MemoryCandidate, canonical?: string) =>
        upsertSqliteCandidate(realStmt, c, canonical),
      nowIso: () => new Date().toISOString(),
      audit: () => undefined,
    };
    expect(rejectSqliteCandidate(ctx, 'candidate_missing', 'nope')).toBe(false);

    const candidate = await store.createCandidate({
      text: 'Already resolved control sentence.',
      kind: 'fact',
      scope: 'project',
    });
    internals(store)
      .stmt("UPDATE candidates SET status = 'rejected', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), candidate.id);
    expect(rejectSqliteCandidate(ctx, candidate.id, 'second try')).toBe(false);
  });
});
