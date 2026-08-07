/**
 * Phase 1 of `chronicle-sqlite-journal-v1`.
 *
 * The load-bearing property is not "events round-trip" — it is that the chain
 * stays tamper-evident. Three failures have to be distinguishable: a hole in
 * `sequence`, a broken `previousHash` link, and an in-place payload edit that
 * left both intact. A store that only checked the links would call the third
 * one healthy.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENESIS_HASH } from '../../src/chronicle/event-hash.js';
import {
  CHRONICLE_SQLITE_FILE,
  ChronicleSqliteJournal,
  ChronicleStorageQuotaError,
} from '../../src/chronicle/sqlite-journal.js';
import type { ChronicleEventInput } from '../../src/chronicle/types.js';

let dir: string;
let journal: ChronicleSqliteJournal;

function input(overrides: Partial<ChronicleEventInput> = {}): ChronicleEventInput {
  return {
    eventType: 'tool.completed',
    scope: { installationId: 'inst', machineId: 'mach', sessionId: 'sess-1' },
    correlation: { traceId: 'trace-1', spanId: 'span-1' },
    outcome: 'success',
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chronicle-sqlite-'));
  journal = new ChronicleSqliteJournal({ directory: dir });
});

afterEach(async () => {
  journal.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ChronicleSqliteJournal', () => {
  it('anchors the first event at genesis and chains subsequent ones', async () => {
    const first = await journal.append(input());
    const second = await journal.append(input({ eventType: 'tool.started' }));

    expect(first.sequence).toBe(1);
    expect(first.previousHash).toBe(GENESIS_HASH);
    expect(second.sequence).toBe(2);
    expect(second.previousHash).toBe(first.hash);
    expect(await journal.verify()).toMatchObject({ ok: true, entries: 2, lastSequence: 2 });
  });

  it('writes a batch as one transaction with a dense sequence', async () => {
    const events = await journal.appendBatch([input(), input(), input()]);

    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events[1]?.previousHash).toBe(events[0]?.hash);
    expect(events[2]?.previousHash).toBe(events[1]?.hash);
    expect(await journal.verify()).toMatchObject({ ok: true, entries: 3 });
  });

  it('rebuilds the chain anchor from the database after a reopen', async () => {
    await journal.appendBatch([input(), input()]);
    journal.close();

    journal = new ChronicleSqliteJournal({ directory: dir });
    const third = await journal.append(input());

    expect(third.sequence).toBe(3);
    expect(await journal.verify()).toMatchObject({ ok: true, entries: 3 });
  });

  it('starts a fresh chain each day, mirroring the JSONL partition families', async () => {
    // `ChronicleJournal` anchors every `<day>.events.jsonl` family at genesis
    // independently, so `sequence` restarts daily. The SQLite store has to
    // reproduce that rather than impose one global chain, or imported history
    // would need re-hashing — which would destroy its tamper evidence.
    const monday = new ChronicleSqliteJournal({
      directory: dir,
      now: () => new Date('2026-03-02T10:00:00.000Z'),
    });
    await monday.appendBatch([input(), input()]);
    monday.close();

    const tuesday = new ChronicleSqliteJournal({
      directory: dir,
      now: () => new Date('2026-03-03T10:00:00.000Z'),
    });
    const first = await tuesday.append(input());
    tuesday.close();

    expect(first.sequence).toBe(1);
    expect(first.previousHash).toBe(GENESIS_HASH);

    journal.close();
    journal = new ChronicleSqliteJournal({ directory: dir });
    expect(await journal.verify()).toMatchObject({ ok: true, entries: 3 });
  });

  it('detects an in-place payload edit that leaves the links intact', async () => {
    await journal.appendBatch([input(), input(), input()]);

    // Rewrite one event's body without touching `hash`, `previous_hash` or
    // `sequence` — the shape of a tampered audit record.
    const db = openRaw(dir);
    const row = db.prepare('SELECT payload FROM events WHERE sequence = 2').get() as {
      payload: string;
    };
    const tampered = { ...(JSON.parse(row.payload) as Record<string, unknown>), outcome: 'failure' };
    db.prepare('UPDATE events SET payload = ? WHERE sequence = 2').run(JSON.stringify(tampered));
    db.close();

    journal.close();
    journal = new ChronicleSqliteJournal({ directory: dir });

    expect(await journal.verify()).toMatchObject({ ok: false, reason: 'entry hash mismatch' });
  });

  it('detects a hole punched in the middle of the chain', async () => {
    await journal.appendBatch([input(), input(), input()]);

    const db = openRaw(dir);
    db.prepare('DELETE FROM events WHERE sequence = 2').run();
    db.close();

    journal.close();
    journal = new ChronicleSqliteJournal({ directory: dir });

    const result = await journal.verify();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/sequence gap/u);
  });

  it('keeps the surviving events verifiable after a retention purge', async () => {
    const old = new Date('2026-01-01T00:00:00.000Z');
    const past = new ChronicleSqliteJournal({ directory: dir, now: () => old });
    await past.appendBatch([input(), input()]);
    past.close();

    journal.close();
    journal = new ChronicleSqliteJournal({ directory: dir });
    const kept = await journal.append(input());

    const result = await journal.purge({ retentionDays: 30 });
    expect(result.deletedCount).toBe(2);

    // Purging removes whole day-chains, so the surviving day is untouched and
    // still starts at its own sequence 1 — there is no truncated prefix to
    // anchor and therefore no gap to report.
    expect(kept.sequence).toBe(1);
    const verified = await journal.verify();
    expect(verified).toMatchObject({ ok: true, entries: 1, lastSequence: 1 });
  });

  it('reports purge candidates without deleting in dry-run mode', async () => {
    const old = new Date('2026-01-01T00:00:00.000Z');
    const past = new ChronicleSqliteJournal({ directory: dir, now: () => old });
    await past.appendBatch([input(), input()]);
    past.close();

    journal.close();
    journal = new ChronicleSqliteJournal({ directory: dir });

    expect(await journal.purge({ retentionDays: 30, dryRun: true })).toMatchObject({
      deletedCount: 2,
    });
    expect(await journal.verify()).toMatchObject({ ok: true, entries: 2 });
  });

  it('enforces configured retention no more than once per interval', async () => {
    const retentionNow = new Date('2026-02-01T00:00:00.000Z');
    const oldJournal = new ChronicleSqliteJournal({
      directory: dir,
      now: () => new Date('2025-12-01T00:00:00.000Z'),
    });
    await oldJournal.append(input({ correlation: { traceId: 'old', spanId: 'old' } }));
    oldJournal.close();

    journal.close();
    journal = new ChronicleSqliteJournal({
      directory: dir,
      retentionDays: 30,
      retentionCheckIntervalMs: 60 * 60 * 1_000,
      maxEvents: 2,
      now: () => retentionNow,
    });
    const purge = vi.spyOn(journal, 'purge');

    await journal.append(input({ correlation: { traceId: 'recent-1', spanId: 'recent-1' } }));
    await journal.append(input({ correlation: { traceId: 'recent-2', spanId: 'recent-2' } }));

    expect(purge).toHaveBeenCalledTimes(1);
    expect(await journal.verify()).toMatchObject({ ok: true, entries: 2 });

    retentionNow.setTime(retentionNow.getTime() + 60 * 60 * 1_000);
    await journal.append(input({ correlation: { traceId: 'recent-3', spanId: 'recent-3' } }));
    expect(purge).toHaveBeenCalledTimes(2);
    expect(await journal.verify()).toMatchObject({ ok: true, entries: 2 });
  });

  it('does not reject ingestion when best-effort retention fails', async () => {
    journal.close();
    journal = new ChronicleSqliteJournal({ directory: dir, retentionDays: 30 });
    vi.spyOn(journal, 'purge').mockRejectedValueOnce(new Error('maintenance failed'));

    await expect(journal.append(input())).resolves.toMatchObject({ sequence: 1 });
  });

  it('rejects invalid event ceilings', () => {
    journal.close();

    expect(
      () =>
        new ChronicleSqliteJournal({
          directory: dir,
          maxEvents: 0,
        }),
    ).toThrowError('maxEvents must be a positive integer');
    journal = new ChronicleSqliteJournal({ directory: dir });
  });

  it('caps retained events while preserving the newest verifiable chain', async () => {
    journal.close();
    journal = new ChronicleSqliteJournal({
      directory: dir,
      maxEvents: 3,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    await journal.appendBatch([input(), input(), input(), input(), input()]);

    expect(await journal.verify()).toMatchObject({ ok: true, entries: 3 });
    const db = new DatabaseSync(path.join(dir, CHRONICLE_SQLITE_FILE));
    const rows = db.prepare('SELECT sequence FROM events ORDER BY day, sequence').all() as Array<{
      sequence: number;
    }>;
    db.close();
    expect(rows.map((row) => row.sequence)).toEqual([3, 4, 5]);
  });

  it('enforces the event ceiling when reopening an oversized database', async () => {
    await journal.appendBatch([input(), input(), input(), input()]);
    journal.close();
    journal = new ChronicleSqliteJournal({ directory: dir, maxEvents: 2 });

    expect(await journal.verify()).toMatchObject({ ok: true, entries: 2 });
  });

  it('keeps the event ceiling counter synchronized after a public purge', async () => {
    journal.close();
    journal = new ChronicleSqliteJournal({ directory: dir, maxEvents: 3 });
    await journal.appendBatch([input(), input(), input()]);

    await journal.purge({ before: new Date(Date.now() + 60_000), dryRun: false });
    await journal.appendBatch([input(), input(), input()]);

    expect(await journal.verify()).toMatchObject({ ok: true, entries: 3 });
  });

  it('rejects invalid byte-retention policy configuration', () => {
    expect(
      () =>
        new ChronicleSqliteJournal({
          directory: path.join(dir, 'invalid-bytes'),
          maxBytes: 1024,
        }),
    ).toThrow(/maxBytes/);
    expect(
      () =>
        new ChronicleSqliteJournal({
          directory: path.join(dir, 'invalid-retention'),
          retentionDays: 1,
          retentionCheckIntervalMs: 0,
        }),
    ).toThrow(/retentionCheckIntervalMs/);
  });

  it('rolls back atomically with a typed error when the byte quota is exhausted', async () => {
    journal.close();
    journal = new ChronicleSqliteJournal({
      directory: dir,
      maxBytes: 17 * 1024 * 1024,
    });

    const payload = 'x'.repeat(64 * 1024);
    let rejected = false;
    for (let index = 0; index < 512; index += 1) {
      const before = await journal.verify();
      try {
        await journal.append(input({ metadata: { payload, index } }));
      } catch (error) {
        expect(error).toBeInstanceOf(ChronicleStorageQuotaError);
        expect(await journal.verify()).toEqual(before);
        rejected = true;
        break;
      }
    }

    expect(rejected).toBe(true);
  });

  it('projects only values that remain recoverable from the payload', async () => {
    await journal.append(
      input({
        scope: {
          installationId: 'inst',
          machineId: 'mach',
          sessionId: 'sess-9',
          agentId: 'agent-3',
        },
        resource: { kind: 'file', id: 'f1', path: 'src/a.ts' },
      }),
    );

    const db = openRaw(dir);
    const row = db
      .prepare('SELECT session_id, agent_id, resource_path, payload FROM events WHERE sequence = 1')
      .get() as {
      session_id: string;
      agent_id: string;
      resource_path: string;
      payload: string;
    };
    db.close();

    const event = JSON.parse(row.payload) as {
      scope: { sessionId: string; agentId: string };
      resource: { path: string };
    };
    expect(row.session_id).toBe(event.scope.sessionId);
    expect(row.agent_id).toBe(event.scope.agentId);
    expect(row.resource_path).toBe(event.resource.path);
  });

  it('tracks the legacy import marker across reopens', async () => {
    expect(journal.hasImportedLegacyJournal()).toBe(false);
    journal.markLegacyJournalImported();
    journal.close();

    journal = new ChronicleSqliteJournal({ directory: dir });
    expect(journal.hasImportedLegacyJournal()).toBe(true);
  });
});

/** Direct handle used only to simulate tampering the journal API forbids. */
function openRaw(directory: string): DatabaseSync {
  return new DatabaseSync(path.join(directory, CHRONICLE_SQLITE_FILE));
}
