import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialGet, credentialList } from '../src/sqlite-mailbox-credentials.js';
import { materializeMessageRows } from '../src/sqlite-mailbox-rows.js';

const dbs: DatabaseSync[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe('SQLite mailbox corrupt JSON row resilience (F390, F391)', () => {
  it('materializeMessageRows skips rows with corrupt JSON', () => {
    const db = new DatabaseSync(':memory:');
    dbs.push(db);
    db.exec(
      'CREATE TABLE message_receipts (message_id TEXT, actor_id TEXT, read_at TEXT, completed_at TEXT, completed_by TEXT, outcome TEXT)',
    );

    const res = materializeMessageRows(db, [
      {
        id: 'm1',
        data: JSON.stringify({ id: 'm1', from: 'a', to: 'b', body: 'hi', readBy: {} }),
        legacy_global_completion: 0,
      },
      {
        id: 'm2',
        data: '{CORRUPT_ROW_JSON',
        legacy_global_completion: 0,
      },
    ] as never);

    expect(res).toHaveLength(1);
    expect(res[0]?.id).toBe('m1');
  });

  it('credentialGet returns null and credentialList skips corrupt credential rows', () => {
    const db = new DatabaseSync(':memory:');
    dbs.push(db);
    db.exec('CREATE TABLE credentials (credential_id TEXT PRIMARY KEY, status TEXT, data TEXT)');
    db.prepare('INSERT INTO credentials (credential_id, status, data) VALUES (?, ?, ?)').run(
      'good',
      'active',
      JSON.stringify({
        credentialId: 'good',
        principalId: 'p1',
        verifier: 'v1',
        status: 'active',
        issuedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2027-01-01T00:00:00.000Z',
      }),
    );
    db.prepare('INSERT INTO credentials (credential_id, status, data) VALUES (?, ?, ?)').run(
      'bad',
      'active',
      '{CORRUPT_JSON',
    );

    expect(credentialGet(db, 'bad')).toBeNull();
    const list = credentialList(db);
    expect(list).toHaveLength(1);
    expect(list[0]?.credentialId).toBe('good');
  });
});
