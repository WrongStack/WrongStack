import { loadRuntimeDatabaseSync as loadTestDatabaseSync } from '@wrongstack/persistence';

const DatabaseSync = loadTestDatabaseSync();

import { initializeSchema } from '../src/verification-ledger-schema.js';

const cases = [
  [
    'governance_verification_runs',
    ['r1', 'task', 'draft', 'client', '{}', 'hash', 'issued', 'expires', 'recorded'],
    ['r2', 'task', 'draft', 'client', '{}', 'hash', 'issued', 'expires', 'recorded'],
  ],
  [
    'governance_verification_leases',
    ['l1', 'r1', 'task', 'client', 'hash', 'issued', 'expires'],
    ['l2', 'r2', 'task', 'client', 'hash', 'issued', 'expires'],
  ],
  [
    'governance_verification_lease_consumptions',
    [1, 'l1', 'r1', 'client', 'hash', 'consumed'],
    [2, 'l2', 'r2', 'client', 'hash', 'consumed'],
  ],
  [
    'governance_workspace_snapshots',
    ['s1', 'project', 1, 'hash', 'captured'],
    ['s2', 'project', 2, 'hash', 'captured'],
  ],
] as const;
function attempt(table: string, conflict: 'primary' | 'unique' = 'primary') {
  const db = new DatabaseSync(':memory:');
  initializeSchema({ db });
  db.exec('PRAGMA foreign_keys = ON');
  try {
    for (const [name, first, second] of cases) {
      const sql = `INSERT INTO ${name} VALUES (${first.map(() => '?').join(',')})`;
      db.prepare(sql).run(...first);
      db.prepare(sql).run(...second);
    }
    const before = db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
    const selected = cases.find(([name]) => name === table);
    if (!selected) throw new Error('invalid fixture');
    const row: Array<string | number> = [...selected[1]];
    if (conflict === 'unique') row[0] = typeof row[0] === 'number' ? 3 : 'replacement-id';
    row[row.length - 1] = 'replacement';
    let error: unknown;
    try {
      db.prepare(`INSERT OR REPLACE INTO ${table} VALUES (${row.map(() => '?').join(',')})`).run(
        ...row,
      );
    } catch (e) {
      error = e;
    }
    const after = db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
    return { before, after, error };
  } finally {
    db.close();
  }
}

import { expect, it } from 'vitest';

it('verifies primary and alternate unique conflicts plus repeated schema initialization', () => {
  for (const [table] of cases) {
    for (const conflict of table === 'governance_verification_runs'
      ? (['primary'] as const)
      : (['primary', 'unique'] as const)) {
      const actual = attempt(table, conflict);
      expect(actual.error).toBeInstanceOf(Error);
      expect(String(actual.error)).toContain('append-only');
      expect(actual.after).toEqual(actual.before);
    }
  }
  const db = new DatabaseSync(':memory:');
  try {
    initializeSchema({ db });
    initializeSchema({ db });
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM governance_workspace_snapshots').get()?.['count'],
    ).toBe(0);
  } finally {
    db.close();
  }
});
