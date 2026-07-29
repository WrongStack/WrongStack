/**
 * Phase 2 of `chronicle-sqlite-journal-v1`.
 *
 * Fixtures are produced by the real `ChronicleJournal` rather than hand-written
 * JSONL: the property under test is that whatever the legacy writer actually
 * emits survives the move unchanged, so a hand-rolled approximation of its
 * output would test the approximation instead.
 *
 * The load-bearing assertion is that `sequence`, `previousHash` and `hash` come
 * across identical. An import that "fixed up" a chain would still verify — and
 * would have silently destroyed the evidence the chain exists to provide.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChronicleJournal } from '../../src/chronicle/journal.js';
import {
  ChronicleImportError,
  importLegacyChronicleJournal,
} from '../../src/chronicle/legacy-journal-import.js';
import {
  CHRONICLE_SQLITE_FILE,
  ChronicleSqliteJournal,
} from '../../src/chronicle/sqlite-journal.js';
import type { ChronicleEvent, ChronicleEventInput } from '../../src/chronicle/types.js';

let dir: string;

function input(overrides: Partial<ChronicleEventInput> = {}): ChronicleEventInput {
  return {
    eventType: 'provider.attempt.completed',
    scope: { installationId: 'inst', machineId: 'mach', sessionId: 'sess-1' },
    correlation: { traceId: 'trace-1', spanId: 'span-1' },
    outcome: 'success',
    ...overrides,
  };
}

/** Write a legacy day family with the real writer and return what it recorded. */
async function writeLegacyDay(day: string, count: number): Promise<ChronicleEvent[]> {
  const journal = new ChronicleJournal({ filePath: path.join(dir, `${day}.events.jsonl`) });
  const events: ChronicleEvent[] = [];
  for (let index = 0; index < count; index++) {
    events.push(await journal.append(input({ eventType: `event.${index}` })));
  }
  await journal.flush();
  return events;
}

function readRows(): Array<{ day: string; sequence: number; hash: string; previous_hash: string }> {
  const db = new DatabaseSync(path.join(dir, CHRONICLE_SQLITE_FILE));
  const rows = db
    .prepare('SELECT day, sequence, hash, previous_hash FROM events ORDER BY day, sequence')
    .all() as Array<{ day: string; sequence: number; hash: string; previous_hash: string }>;
  db.close();
  return rows;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chronicle-import-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('importLegacyChronicleJournal', () => {
  it('carries sequence, previousHash and hash across untouched', async () => {
    const monday = await writeLegacyDay('2026-03-02', 3);
    const tuesday = await writeLegacyDay('2026-03-03', 2);

    const journal = new ChronicleSqliteJournal({ directory: dir });
    const result = await importLegacyChronicleJournal(journal, dir);

    expect(result).toMatchObject({ alreadyImported: false, families: 2, events: 5 });
    expect(await journal.verify()).toMatchObject({ ok: true, entries: 5 });

    const rows = readRows();
    const expected = [
      ...monday.map((event) => ({
        day: '2026-03-02',
        sequence: event.sequence,
        hash: event.hash,
        previous_hash: event.previousHash,
      })),
      ...tuesday.map((event) => ({
        day: '2026-03-03',
        sequence: event.sequence,
        hash: event.hash,
        previous_hash: event.previousHash,
      })),
    ];
    expect(rows).toEqual(expected);
    journal.close();
  });

  it('keeps each day family on its own chain restarting at one', async () => {
    await writeLegacyDay('2026-03-02', 2);
    await writeLegacyDay('2026-03-03', 2);

    const journal = new ChronicleSqliteJournal({ directory: dir });
    await importLegacyChronicleJournal(journal, dir);

    const rows = readRows();
    expect(rows.filter((row) => row.day === '2026-03-02').map((row) => row.sequence)).toEqual([
      1, 2,
    ]);
    expect(rows.filter((row) => row.day === '2026-03-03').map((row) => row.sequence)).toEqual([
      1, 2,
    ]);
    journal.close();
  });

  it('refuses a corrupt chain and leaves the database empty', async () => {
    const events = await writeLegacyDay('2026-03-02', 3);

    // Tamper with the middle line: valid JSON, wrong content for its hash.
    const file = path.join(dir, '2026-03-02.events.jsonl');
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    const tampered = { ...(JSON.parse(lines[1] as string) as ChronicleEvent), outcome: 'failure' };
    lines[1] = JSON.stringify(tampered);
    await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');

    const journal = new ChronicleSqliteJournal({ directory: dir });
    await expect(importLegacyChronicleJournal(journal, dir)).rejects.toBeInstanceOf(
      ChronicleImportError,
    );

    // The whole import is one transaction, so nothing lands — not even the
    // events that verified before the break.
    expect(readRows()).toEqual([]);
    expect(journal.hasImportedLegacyJournal()).toBe(false);
    expect(events).toHaveLength(3);
    journal.close();
  });

  it('names the day and sequence where the chain broke', async () => {
    await writeLegacyDay('2026-03-02', 3);
    const file = path.join(dir, '2026-03-02.events.jsonl');
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    await fs.writeFile(file, `${[lines[0], lines[2]].join('\n')}\n`, 'utf8');

    const journal = new ChronicleSqliteJournal({ directory: dir });
    await expect(importLegacyChronicleJournal(journal, dir)).rejects.toMatchObject({
      day: '2026-03-02',
      sequence: 3,
    });
    journal.close();
  });

  it('is idempotent: a second run reads nothing', async () => {
    await writeLegacyDay('2026-03-02', 2);

    const journal = new ChronicleSqliteJournal({ directory: dir });
    expect(await importLegacyChronicleJournal(journal, dir)).toMatchObject({ events: 2 });
    expect(await importLegacyChronicleJournal(journal, dir)).toMatchObject({
      alreadyImported: true,
      events: 0,
    });
    expect(readRows()).toHaveLength(2);
    journal.close();
  });

  it('continues the imported chain when new events are appended', async () => {
    const legacy = await writeLegacyDay('2026-03-02', 2);

    const journal = new ChronicleSqliteJournal({
      directory: dir,
      now: () => new Date('2026-03-02T23:00:00.000Z'),
    });
    await importLegacyChronicleJournal(journal, dir);
    const next = await journal.append(input());

    expect(next.sequence).toBe(3);
    expect(next.previousHash).toBe(legacy[1]?.hash);
    expect(await journal.verify()).toMatchObject({ ok: true, entries: 3 });
    journal.close();
  });

  it('does nothing when there is no legacy journal', async () => {
    const journal = new ChronicleSqliteJournal({ directory: dir });
    expect(await importLegacyChronicleJournal(journal, dir)).toMatchObject({
      families: 0,
      events: 0,
    });
    expect(journal.hasImportedLegacyJournal()).toBe(true);
    journal.close();
  });
});
