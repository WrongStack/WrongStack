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
 *
 * The second load-bearing property is isolation: a broken day is quarantined,
 * not repaired and not fatal. Chains restart at 1 each day, so one day's break
 * says nothing about the next day's integrity — and aborting the whole import
 * on it left the store unable to open at all, which stopped Chronicle from
 * recording anything new.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChronicleJournal } from '../../src/chronicle/journal.js';
import { importLegacyChronicleJournal } from '../../src/chronicle/legacy-journal-import.js';
import { ChronicleMetricsStore } from '../../src/chronicle/metrics-store.js';
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

  /** Break `day`'s chain by rewriting one line so its hash no longer matches. */
  async function tamperMiddleLine(day: string): Promise<void> {
    const file = path.join(dir, `${day}.events.jsonl`);
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    const tampered = { ...(JSON.parse(lines[1] as string) as ChronicleEvent), outcome: 'failure' };
    lines[1] = JSON.stringify(tampered);
    await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  }

  it('refuses a corrupt day family and imports none of its events', async () => {
    const events = await writeLegacyDay('2026-03-02', 3);
    await tamperMiddleLine('2026-03-02');

    const journal = new ChronicleSqliteJournal({ directory: dir });
    const result = await importLegacyChronicleJournal(journal, dir);

    // The family is one transaction, so nothing from that day lands — not even
    // the events that verified before the break.
    expect(readRows()).toEqual([]);
    expect(result).toMatchObject({ families: 0, events: 0 });
    expect(events).toHaveLength(3);
    journal.close();
  });

  it('quarantines the broken day and still imports the healthy ones', async () => {
    await writeLegacyDay('2026-03-02', 3);
    const tuesday = await writeLegacyDay('2026-03-03', 2);
    await tamperMiddleLine('2026-03-02');

    const journal = new ChronicleSqliteJournal({ directory: dir });
    const result = await importLegacyChronicleJournal(journal, dir);

    // One bad day must not cost the operator every other day — nor stop the
    // store from opening, which is what left Chronicle recording nothing.
    expect(result).toMatchObject({ families: 1, events: 2 });
    expect(readRows().map((row) => row.day)).toEqual(['2026-03-03', '2026-03-03']);
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]).toMatchObject({ day: '2026-03-02', sequence: 2 });
    expect(await journal.verify()).toMatchObject({ ok: true, entries: 2 });
    expect(tuesday).toHaveLength(2);
    journal.close();
  });

  it('keeps a quarantined family out of the import boundary so its events still fold into metrics', async () => {
    const writeDay = async (day: string, count: number): Promise<void> => {
      const legacy = new ChronicleJournal({ filePath: path.join(dir, `${day}.events.jsonl`) });
      for (let index = 0; index < count; index++) {
        await legacy.append(
          input({
            occurredAt: `${day}T10:00:00.000Z`,
            attributes: {
              provider: 'provider-a',
              model: 'model-x',
              usage: { input: 10, output: 20 },
            },
          }),
        );
      }
      await legacy.flush();
    };
    await writeDay('2026-03-02', 3);
    await writeDay('2026-03-03', 2);
    await tamperMiddleLine('2026-03-02');

    const journal = new ChronicleSqliteJournal({ directory: dir });
    const result = await importLegacyChronicleJournal(journal, dir);
    expect(result.quarantined[0]).toMatchObject({ day: '2026-03-02' });

    // The broken family never reached SQLite (rolled back), so its events must
    // still reach the projection via the JSONL fold. If its files had leaked
    // into the import boundary, the ingester would treat them as
    // already-migrated and skip them: healthy 2 (SQLite) + broken 3 (JSONL).
    const metrics = ChronicleMetricsStore.open(dir);
    expect((await metrics.refresh()).ingestedEvents).toBe(5);
    metrics.close();
    journal.close();
  });

  it('names the day and sequence where the chain broke', async () => {
    await writeLegacyDay('2026-03-02', 3);
    const file = path.join(dir, '2026-03-02.events.jsonl');
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    await fs.writeFile(file, `${[lines[0], lines[2]].join('\n')}\n`, 'utf8');

    const journal = new ChronicleSqliteJournal({ directory: dir });
    const result = await importLegacyChronicleJournal(journal, dir);

    expect(result.quarantined[0]).toMatchObject({ day: '2026-03-02', sequence: 3 });
    expect(result.quarantined[0]?.reason).toMatch(/sequence gap in 2026-03-02/u);
    journal.close();
  });

  it('remembers a quarantined day so a later run still reports the hole', async () => {
    await writeLegacyDay('2026-03-02', 3);
    await tamperMiddleLine('2026-03-02');

    const journal = new ChronicleSqliteJournal({ directory: dir });
    await importLegacyChronicleJournal(journal, dir);
    journal.close();

    // The import runs once; after the marker is set nothing re-reads the JSONL,
    // so the persisted record is the only surviving evidence of the gap.
    const reopened = new ChronicleSqliteJournal({ directory: dir });
    const second = await importLegacyChronicleJournal(reopened, dir);
    expect(second.alreadyImported).toBe(true);
    expect(second.quarantined).toMatchObject([{ day: '2026-03-02' }]);
    expect(reopened.quarantinedFamilies()).toMatchObject([{ day: '2026-03-02' }]);
    reopened.close();
  });

  it('resumes at the first day it never reached when a run is cut short', async () => {
    await writeLegacyDay('2026-03-02', 2);
    await writeLegacyDay('2026-03-03', 2);

    // Simulate a daemon killed after the first family committed: that day is
    // stored, but the completion marker was never written.
    const interrupted = new ChronicleSqliteJournal({ directory: dir });
    const only = interrupted.runFamilyImport.bind(interrupted);
    let seen = 0;
    interrupted.runFamilyImport = (load) =>
      seen++ === 0 ? only(load) : Promise.reject(new Error('killed'));
    await expect(importLegacyChronicleJournal(interrupted, dir)).rejects.toThrow('killed');
    expect(interrupted.hasImportedLegacyJournal()).toBe(false);
    interrupted.close();

    const resumed = new ChronicleSqliteJournal({ directory: dir });
    const result = await importLegacyChronicleJournal(resumed, dir);

    // Only the missing day is read; re-reading the stored one would abort on
    // the (day, sequence) primary key.
    expect(result).toMatchObject({ families: 1, events: 2, quarantined: [] });
    expect(readRows().map((row) => row.day)).toEqual([
      '2026-03-02',
      '2026-03-02',
      '2026-03-03',
      '2026-03-03',
    ]);
    expect(await resumed.verify()).toMatchObject({ ok: true, entries: 4 });
    resumed.close();
  });

  it('propagates an infrastructure failure instead of quarantining the day', async () => {
    await writeLegacyDay('2026-03-02', 2);

    const journal = new ChronicleSqliteJournal({ directory: dir });
    const boom = new Error('disk is on fire');
    journal.runFamilyImport = () => Promise.reject(boom);

    // Only a broken *chain* is the operator's call. An unreadable file or a
    // failing write is a defect that must not be laundered into "day skipped".
    await expect(importLegacyChronicleJournal(journal, dir)).rejects.toBe(boom);
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
