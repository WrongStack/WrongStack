import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  rebuildCatalogIndex,
  summarizeTranscriptFile,
} from '../../src/session-catalog/store-rebuild.js';
import {
  configureCatalogDatabase,
  initializeCatalogSchema,
} from '../../src/session-catalog/store-schema.js';
import { summarizeSessionEvents } from '../../src/storage/session-store/summary-builder.js';
import { loadDatabaseSync } from '../../src/utils/sqlite-database.js';

const ts = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;
const counterShape = (summary: {
  messageCount?: number | undefined;
  iterationCount?: number | undefined;
  toolCallCount?: number | undefined;
}) => ({
  messageCount: summary.messageCount ?? 0,
  iterationCount: summary.iterationCount ?? 0,
  toolCallCount: summary.toolCallCount ?? 0,
});

type Event = Record<string, unknown>;

const legacyEvents: Event[] = [
  { type: 'session_start', ts: ts(0), model: 'm', provider: 'p' },
  { type: 'user_input', ts: ts(1), content: 'first' },
  { type: 'in_flight_start', ts: ts(2) },
  { type: 'tool_call_start', ts: ts(3), id: 't1', name: 'read' },
  { type: 'tool_call_end', ts: ts(4), id: 't1', name: 'read', ok: true },
  { type: 'llm_response', ts: ts(5), content: [], usage: { input: 4, output: 2 } },
];
const modernEvents: Event[] = [
  { type: 'session_start', ts: ts(0), model: 'm', provider: 'p' },
  {
    type: 'message_appended',
    ts: ts(1),
    version: 1,
    message: { role: 'user', content: 'first' },
  },
  {
    type: 'message_appended',
    ts: ts(2),
    version: 1,
    message: { role: 'system', content: 'system' },
  },
  {
    type: 'message_appended',
    ts: ts(3),
    version: 1,
    message: { role: 'assistant', content: 'answer' },
  },
  { type: 'in_flight_start', ts: ts(4) },
  { type: 'tool_call_start', ts: ts(5), id: 't1', name: 'read' },
  { type: 'tool_call_start', ts: ts(6), id: 't2', name: 'grep' },
  { type: 'tool_call_end', ts: ts(7), id: 't1', name: 'read', ok: true },
];
const enhanceEvents: Event[] = [
  ...legacyEvents,
  { type: 'enhance_usage', ts: ts(6), usage: { input: 7, output: 3 } },
];
const emptyEvents: Event[] = [
  { type: 'session_start', ts: ts(0), model: 'm', provider: 'p' },
  { type: 'tool_call_end', ts: ts(1), id: 't9', name: 'read', ok: true },
];
const journals: Array<[string, Event[]]> = [
  ['legacy', legacyEvents],
  ['modern', modernEvents],
  ['enhance', enhanceEvents],
  ['empty', emptyEvents],
];

async function writeJournal(dir: string, id: string, events: Event[]): Promise<string> {
  const file = path.join(dir, `${id}.jsonl`);
  await fsp.writeFile(file, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  return file;
}

describe('catalog rebuild summary parity', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-rebuild-'));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('matches the canonical counters for legacy, modern, and enhance journals (F916)', async () => {
    for (const [id, events] of journals) {
      const file = await writeJournal(dir, id, events);
      const rebuild = summarizeTranscriptFile(file, id);
      const canonical = await summarizeSessionEvents({
        id,
        events: events as never,
        mtime: ts(59),
      });
      expect(counterShape(rebuild), id).toEqual(counterShape(canonical));
      expect(rebuild.tokenTotal, `${id} tokens`).toBe(canonical.tokenTotal);
    }
  });

  it('stores the canonical counters during a real rebuild without a summary sidecar (F916)', async () => {
    for (const [id, events] of journals) await writeJournal(dir, id, events);
    const DatabaseSync = loadDatabaseSync();
    const db = new DatabaseSync(':memory:');
    try {
      configureCatalogDatabase(db);
      initializeCatalogSchema(db);
      const result = rebuildCatalogIndex(
        db,
        dir,
        (relative) => path.join(dir, relative),
        (run) => {
          db.exec('BEGIN IMMEDIATE');
          try {
            const value = run();
            db.exec('COMMIT');
            return value;
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        },
        () => {
          db.prepare(
            "UPDATE catalog_meta SET value=CAST(value AS INTEGER)+1 WHERE key='generation'",
          ).run();
          return 1;
        },
      );
      expect(result).toEqual({ indexed: journals.length, damaged: 0 });
      for (const [id, events] of journals) {
        const row = db.prepare('SELECT summary_json FROM sessions WHERE session_id=?').get(id) as {
          summary_json: string;
        };
        const stored = JSON.parse(row.summary_json) as Event;
        const canonical = await summarizeSessionEvents({
          id,
          events: events as never,
          mtime: ts(59),
        });
        expect(counterShape(stored as never), id).toEqual(counterShape(canonical));
      }
    } finally {
      db.close();
    }
  });
});
