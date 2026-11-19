/**
 * Regression: ChronicleMetricsIngester transaction guards must preserve the
 * primary error when a write or COMMIT fails.
 *
 * Sibling of the canonical fixes in
 * `packages/core/src/session-catalog/store.ts` SessionCatalogStore.transaction,
 * `packages/kanban/src/server/sqlite-storage.ts`,
 * `packages/sage/src/sqlite-store-*.ts`, and
 * `packages/governance/src/{event-store,verification-ledger-store}.ts`:
 * a failing write (or COMMIT) can end the SQLite transaction (SQLITE_FULL /
 * IOERR auto-rollback), so the follow-up ROLLBACK throws
 * `cannot rollback - no transaction is active`. An unguarded
 * `catch (error) { this.db.exec('ROLLBACK'); throw error; }` lets that
 * rollback error surface and the primary disk/database error is lost —
 * the rebuild path (`refresh` -> `rebuildFromSqliteJournal` ->
 * `ingestSqliteJournal(..., propagateErrors = true)`) then reports the mask
 * to the caller instead of why the projection failed.
 *
 * The static part asserts every catch block that issues `ROLLBACK` in
 * `metrics-ingest.ts` wraps it in try/catch (the hardened shape), with an
 * embedded guarded/unguarded self-verification so the detector itself cannot
 * pass vacuously. The dynamic part drives the real `refresh()` rebuild path
 * through the real SQLite driver and injects the fault at the driver
 * boundary only (the COMMIT fault models SQLite's documented auto-rollback).
 */

import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';
import { ChronicleMetricsIngester } from '../src/metrics-ingest.js';
import {
  ensureMetricsSchema,
  isChronicleMetricsAvailable,
  loadDatabaseSync,
} from '../src/metrics-schema.js';
import { ChronicleSqliteJournal } from '../src/sqlite-journal.js';
import { ensureIncrementalVacuum } from '../src/sqlite-journal-schema.js';
import type { ChronicleEventInput } from '../src/types.js';

const SOURCE = path.resolve(__dirname, '../src/metrics-ingest.ts');

/**
 * Count the catch blocks that issue a ROLLBACK and collect the source lines of
 * those that do not wrap it in try/catch.
 */
function findUnguardedRollbackSites(source: string): {
  unguarded: number[];
  rollbackCatchCount: number;
} {
  const lines = source.split('\n');
  const unguarded: number[] = [];
  let rollbackCatchCount = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!/\}\s*catch\s*\(/.test(lines[i] ?? '')) continue;

    // Anchor at the block-opening '{' AFTER the catch keyword and count
    // braces from depth 1 (counting from the line's leading '}' goes
    // negative and mis-ends on the catch line itself).
    const rest = lines.slice(i).join('\n');
    const catchIdx = rest.indexOf('catch');
    const openIdx = rest.indexOf('{', catchIdx);
    if (openIdx === -1) continue;
    let depth = 0;
    let blockEnd = rest.length - 1;
    for (let k = openIdx; k < rest.length; k++) {
      if (rest[k] === '{') depth++;
      else if (rest[k] === '}') {
        depth--;
        if (depth === 0) {
          blockEnd = k;
          break;
        }
      }
    }

    const block = rest.slice(catchIdx, blockEnd + 1);
    if (!/\.exec\('ROLLBACK'\)/.test(block)) continue;
    rollbackCatchCount += 1;
    const hasTryCatchWrapper = /try\s*\{[^}]*\.exec\('ROLLBACK'\)[\s\S]*?\}\s*catch\s*\{/.test(
      block,
    );
    if (!hasTryCatchWrapper) unguarded.push(i + 1);
  }

  return { unguarded, rollbackCatchCount };
}

describe('ChronicleMetricsIngester transaction guards', () => {
  it('detector flags an unguarded catch-block ROLLBACK and accepts the guarded shape', () => {
    const unguardedShape = `
try {
  this.db.exec('COMMIT');
} catch (error) {
  this.db.exec('ROLLBACK');
  throw error;
}
`;
    const guardedShape = `
try {
  this.db.exec('COMMIT');
} catch (error) {
  try {
    this.db.exec('ROLLBACK');
  } catch {
    /* preserve original error */
  }
  throw error;
}
`;
    const unguarded = findUnguardedRollbackSites(unguardedShape);
    expect(unguarded.rollbackCatchCount).toBe(1);
    expect(unguarded.unguarded).toHaveLength(1);
    const guarded = findUnguardedRollbackSites(guardedShape);
    expect(guarded.rollbackCatchCount).toBe(1);
    expect(guarded.unguarded).toHaveLength(0);
  });

  it('wraps every catch-block ROLLBACK in try/catch (primary-error preservation)', () => {
    const { unguarded, rollbackCatchCount } = findUnguardedRollbackSites(
      readFileSync(SOURCE, 'utf8'),
    );
    // Guard against a vacuous pass: the ingester must still own its rollback
    // sites. If the transactions move to another module, update SOURCE.
    expect(rollbackCatchCount).toBeGreaterThan(0);

    expect(
      unguarded,
      `Found ${unguarded.length} unguarded ROLLBACK call(s) in catch blocks at lines: ${unguarded.join(', ')}. ` +
        'These mask the primary SQLite error with the rollback noise. ' +
        'Use the try/catch wrapper from SessionCatalogStore.transaction (packages/core/src/session-catalog/store.ts).',
    ).toEqual([]);
  });
});

const dirs: string[] = [];
const realDbs: DatabaseSync[] = [];
const journals: ChronicleSqliteJournal[] = [];

afterEach(async () => {
  for (const db of realDbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const journal of journals.splice(0)) {
    try {
      journal.close();
    } catch {
      /* already closed */
    }
  }
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) => removeProjectFixtureDirectory(dir, { maxRetries: 5, retryDelay: 200 })),
  );
});

const scope = { installationId: 'i', machineId: 'm', projectId: 'p', sessionId: 'sess-1' };
const correlation = { traceId: 't', spanId: 'sp' };
const runtime = { providerId: 'openai', modelId: 'model-a' };

const attempt = (): ChronicleEventInput[] => [
  { scope, correlation, eventType: 'provider.attempt.started', runtime, outcome: 'started' },
  {
    scope,
    correlation,
    eventType: 'provider.attempt.completed',
    runtime,
    outcome: 'success',
    durationNs: '2000000000',
    attributes: { inputTokens: 10, outputTokens: 5 },
  },
];

type FaultMode = 'none' | 'commit-fault' | 'write-fault';
const FULL_ERROR = 'SQLITE_FULL: database or disk is full';

/**
 * Delegating DatabaseSync wrapper: injects only the named fault at the driver
 * boundary. The COMMIT fault models SQLite's documented auto-rollback on a
 * failed COMMIT (SQLITE_FULL/IOERR); the write fault leaves the transaction
 * active, as a statement-level FULL does.
 */
function makeFaultDb(real: DatabaseSync, mode: FaultMode): DatabaseSync {
  let commitFired = false;
  const writeFiredStatements = new Set<unknown>();
  const wrapper = {
    exec(sql: string): void {
      if (mode === 'commit-fault' && /^COMMIT/.test(sql) && !commitFired) {
        commitFired = true;
        real.exec('ROLLBACK');
        throw new Error(FULL_ERROR);
      }
      real.exec(sql);
    },
    prepare(sql: string): unknown {
      const statement = real.prepare(sql) as unknown as {
        run: (...args: unknown[]) => unknown;
        get: (...args: unknown[]) => unknown;
        all: (...args: unknown[]) => unknown;
      };
      if (mode === 'write-fault' && sql.includes('INSERT INTO ingest_state')) {
        const run = statement.run.bind(statement);
        statement.run = (...args: unknown[]) => {
          if (!writeFiredStatements.has(statement)) {
            writeFiredStatements.add(statement);
            throw new Error(FULL_ERROR);
          }
          return run(...args);
        };
      }
      return statement;
    },
    close(): void {
      real.close();
    },
  };
  return wrapper as unknown as DatabaseSync;
}

/**
 * Refresh() must take the rebuild path: a migrated journal (no boundary row,
 * no partition files) plus a pre-migration JSONL offset in ingest_state makes
 * `needsSqliteRebuild` true, so `rebuildFromSqliteJournal` runs with
 * `propagateErrors = true` and a transaction failure reaches the caller.
 */
async function buildRebuildFixture(): Promise<{ dir: string; realDb: DatabaseSync }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-rollback-mask-'));
  dirs.push(dir);

  const journal = new ChronicleSqliteJournal({ directory: dir });
  journals.push(journal);
  await journal.appendBatch(attempt());
  journal.markLegacyJournalImported();

  const Database = loadDatabaseSync();
  const realDb = new Database(path.join(dir, 'metrics.db'));
  realDbs.push(realDb);
  ensureIncrementalVacuum(realDb);
  realDb.exec('PRAGMA journal_mode = WAL');
  realDb.exec('PRAGMA synchronous = NORMAL');
  realDb.exec('PRAGMA busy_timeout = 5000');
  ensureMetricsSchema(realDb);
  realDb
    .prepare('INSERT INTO ingest_state (file, bytes) VALUES (?, ?)')
    .run('2026-08-13.events.jsonl', 123);
  return { dir, realDb };
}

describe.skipIf(!isChronicleMetricsAvailable())(
  'ChronicleMetricsIngester rollback-mask behavior',
  () => {
    it('preserves the primary error when COMMIT fails (SQLite auto-rollback)', async () => {
      const { dir, realDb } = await buildRebuildFixture();
      const ingester = new ChronicleMetricsIngester(
        makeFaultDb(realDb, 'commit-fault'),
        dir,
        path.join(dir, 'metrics.db'),
      );

      let caught: Error | undefined;
      try {
        await ingester.refresh();
      } catch (error) {
        caught = error as Error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught?.message).toContain('database or disk is full');
      expect(caught?.message).not.toContain('cannot rollback');
    });

    it('CONTROL: propagates the primary error when a mid-transaction write fails while the transaction stays active', async () => {
      const { dir, realDb } = await buildRebuildFixture();
      const ingester = new ChronicleMetricsIngester(
        makeFaultDb(realDb, 'write-fault'),
        dir,
        path.join(dir, 'metrics.db'),
      );

      let caught: Error | undefined;
      try {
        await ingester.refresh();
      } catch (error) {
        caught = error as Error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught?.message).toContain('database or disk is full');
      expect(caught?.message).not.toContain('cannot rollback');
    });
  },
);
