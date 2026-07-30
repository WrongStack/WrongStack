/**
 * Tests for `readSqliteSageRow` — the helper that centralizes the
 * `SELECT data FROM memories WHERE id = ?` + `sqliteRowToMemory` cast pair.
 *
 * Covers three branches:
 * 1. Missing row → returns `null` (does not throw, does not log).
 * 2. Corrupt JSON data → returns `null` (does not throw).
 * 3. Valid row → returns the parsed `Sage` with the expected fields.
 *
 * The helper composes with the existing `SqliteStatementCache` shape, so
 * the test uses an in-memory shim that records the SQL and returns a
 * fake row. The shim models the `DatabaseSync#prepare()` return type so
 * the signature match is part of the contract.
 *
 * Also tests `legacyScopeFilterClause` — the helper that produces the
 * `(scope = ? OR legacy_scope = ?)` SQL fragment for the four legacy
 * callsites. Round-trips the modern→legacy alias mapping so a regression
 * in `legacyToSageScope` breaks the test loudly.
 */

import { describe, expect, it } from 'vitest';

import { readSqliteSageRow } from '../src/sqlite-store-codec.js';
import { legacyScopeFilterClause } from '../src/store-helpers.js';
import type { Sage } from '../src/types.js';

interface FakeRow {
  data: string;
}

// The helper's signature is `(sql: string) => ReturnType<DatabaseSync['prepare']>`,
// which is `StatementSync` — a 12-property runtime. The test only exercises
// `.get(id)`, so a partial stub is sufficient; cast to `any` keeps the test
// type-clean without dragging in `node:sqlite` types we don't exercise.
function makeStmt(plan: (sql: string, params: unknown[]) => FakeRow | undefined) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stmt: any = (sql: string) => {
    const get = (id: unknown) => plan(sql, [id]);
    return { get };
  };
  return stmt;
}

interface RecordedSql {
  sql: string;
  capture(): string[];
}

function makeRecordingStmt(plan: (sql: string, params: unknown[]) => FakeRow | undefined) {
  const seen: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stmt: any = (sql: string) => {
    seen.push(sql);
    const get = (id: unknown) => plan(sql, [id]);
    return { get };
  };
  const record: RecordedSql = {
    sql: '',
    capture: () => seen.slice(),
  };
  return { stmt, record };
}

const baseSage: Sage = {
  id: 'sage-1',
  revision: 1,
  scope: 'project',
  kind: 'fact',
  status: 'active',
  text: 'SAGE lives in SQLite.',
  importance: 0.7,
  confidence: 0.9,
  freshness: 1,
  tags: ['sage'],
  anchors: [],
  sources: [],
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
};

describe('readSqliteSageRow', () => {
  it('returns null when the row is missing', () => {
    const { stmt, record } = makeRecordingStmt(() => undefined);
    const result = readSqliteSageRow(stmt, 'missing');
    expect(result).toBeNull();
    expect(record.capture()).toEqual(['SELECT data FROM memories WHERE id = ?']);
  });

  it('returns null when the data column is unparseable JSON', () => {
    const stmt = makeStmt(() => ({ data: 'not-json{' }) as FakeRow);
    const result = readSqliteSageRow(stmt, 'broken');
    expect(result).toBeNull();
  });

  it('returns the parsed Sage when the row is valid', () => {
    const stmt = makeStmt(() => ({ data: JSON.stringify(baseSage) }) as FakeRow);
    const result = readSqliteSageRow(stmt, baseSage.id);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(baseSage.id);
    expect(result?.text).toBe(baseSage.text);
    expect(result?.tags).toEqual(['sage']);
  });
});

describe('legacyScopeFilterClause', () => {
  it('emits the dual-column predicate and the legacy→sage-mapped params', () => {
    const result = legacyScopeFilterClause('user-memory');
    expect(result.clause).toBe('(scope = ? OR legacy_scope = ?)');
    // legacyToSageScope('user-memory') === 'user'
    expect(result.params).toEqual(['user', 'user-memory']);
  });

  it('maps project-memory to the project sage scope', () => {
    const result = legacyScopeFilterClause('project-memory');
    expect(result.params).toEqual(['project', 'project-memory']);
  });

  it('does not prefix the clause with AND — callers compose the surrounding WHERE', () => {
    const result = legacyScopeFilterClause('user-memory');
    expect(result.clause.startsWith(' AND')).toBe(false);
  });
});
