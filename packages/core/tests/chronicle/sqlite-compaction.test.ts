import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ChronicleCompactionBusyError,
  chronicleSqliteAllocatedBytes,
  compactChronicleSqlite,
} from '../../src/chronicle/sqlite-compaction.js';

describe('Chronicle SQLite compaction', () => {
  let dir = '';
  let dbPath = '';
  let endpointMetadataPath = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'chronicle-compact-'));
    dbPath = path.join(dir, 'chronicle.sqlite');
    endpointMetadataPath = path.join(dir, 'server.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses compaction while the recorded project server is alive', async () => {
    await writeFile(endpointMetadataPath, JSON.stringify({ pid: process.pid }), 'utf8');

    expect(() => compactChronicleSqlite({ dbPath, endpointMetadataPath })).toThrow(
      ChronicleCompactionBusyError,
    );
  });

  it('reclaims free pages offline and preserves retained rows', () => {
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO events(payload) VALUES (?)');
    const payload = 'x'.repeat(32 * 1024);
    for (let index = 0; index < 128; index += 1) insert.run(`${index}:${payload}`);
    db.exec('DELETE FROM events WHERE id <= 96');
    db.close();

    const beforeBytes = chronicleSqliteAllocatedBytes(dbPath);
    const result = compactChronicleSqlite({ dbPath, endpointMetadataPath });

    expect(result.beforeBytes).toBe(beforeBytes);
    expect(result.afterBytes).toBe(chronicleSqliteAllocatedBytes(dbPath));
    expect(result.reclaimedBytes).toBe(result.beforeBytes - result.afterBytes);
    expect(result.reclaimedBytes).toBeGreaterThan(0);

    const reopened = new DatabaseSync(dbPath, { readOnly: true });
    const count = reopened.prepare('SELECT COUNT(*) AS count FROM events').get() as {
      count: number;
    };
    reopened.close();
    expect(count.count).toBe(32);
  });
});
