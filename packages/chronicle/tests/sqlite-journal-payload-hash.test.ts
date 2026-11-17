import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRuntimeDatabaseSync } from '@wrongstack/persistence';
import { expect, it } from 'vitest';
import {
  decodeChroniclePayload,
  encodeChroniclePayload,
  type StoredChroniclePayload,
} from '../src/payload-codec.js';
import { CHRONICLE_SQLITE_FILE, ChronicleSqliteJournal } from '../src/sqlite-journal.js';

it.each(['changed', 'missing', 'non-string'] as const)(
  'rejects a %s payload hash even when the indexed hash and links remain intact',
  async (mutation) => {
    const dir = await mkdtemp(join(tmpdir(), 'chronicle-payload-hash-'));
    let journal = new ChronicleSqliteJournal({ directory: dir });
    try {
      await journal.append({
        eventType: 'tool.completed',
        scope: { installationId: 'fixture', machineId: 'fixture', sessionId: 'fixture' },
        correlation: { traceId: 'fixture', spanId: 'fixture' },
      });
      expect(await journal.verify()).toMatchObject({ ok: true, entries: 1 });
      const dbPath = join(dir, CHRONICLE_SQLITE_FILE);
      journal.close();
      const Database = loadRuntimeDatabaseSync();
      const db = new Database(dbPath);
      try {
        const row = db.prepare('SELECT payload FROM events').get() as {
          payload: StoredChroniclePayload;
        };
        const event = JSON.parse(decodeChroniclePayload(row.payload)) as Record<string, unknown>;
        if (mutation === 'missing') delete event['hash'];
        else event['hash'] = mutation === 'changed' ? 'f'.repeat(64) : 123;
        db.prepare('UPDATE events SET payload=?').run(
          encodeChroniclePayload(JSON.stringify(event)),
        );
      } finally {
        db.close();
      }
      journal = new ChronicleSqliteJournal({ directory: dir });
      expect(await journal.verify()).toMatchObject({
        ok: false,
        brokenAt: 0,
        reason: 'entry hash mismatch',
      });
    } finally {
      journal.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
