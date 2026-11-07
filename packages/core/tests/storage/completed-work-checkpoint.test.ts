import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CompletedWorkEvidence } from '@wrongstack/contracts/types/context-evidence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadCompletedWorkCheckpoint,
  saveCompletedWorkCheckpoint,
} from '../../src/storage/completed-work-checkpoint.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-completed-work-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('completed-work-checkpoint', () => {
  it('round-trips completed work through save and load', async () => {
    const fp = path.join(dir, 'completed-work.json');
    const items: CompletedWorkEvidence[] = [
      {
        key: 'todo:t1',
        source: 'todo',
        summary: 'Finish ledger',
        evidence: 'unit test',
        completedAt: 1,
      },
    ];

    await saveCompletedWorkCheckpoint(fp, 'sess', items);
    expect(await loadCompletedWorkCheckpoint(fp)).toEqual(items);
  });

  it('filters invalid entries and emits storage events', async () => {
    const events = { emit: vi.fn() };
    const fp = path.join(dir, 'completed-work.json');
    await fs.writeFile(
      fp,
      JSON.stringify({
        version: 1,
        sessionId: 'sess',
        updatedAt: new Date().toISOString(),
        completedWork: [
          { key: 'task:t1', source: 'task', summary: 'Done', completedAt: 2 },
          { key: 'bad', source: 'nonsense', summary: 'Bad', completedAt: 3 },
        ],
      }),
      'utf8',
    );

    const loaded = await loadCompletedWorkCheckpoint(fp, events as never, 'trace-1');
    expect(loaded).toEqual([{ key: 'task:t1', source: 'task', summary: 'Done', completedAt: 2 }]);
    expect(
      events.emit.mock.calls.some(
        (c) =>
          c[0] === 'storage.read' &&
          (c[1] as { store?: string; outcome?: string }).store === 'completed-work' &&
          (c[1] as { outcome?: string }).outcome === 'success',
      ),
    ).toBe(true);
  });

  it('returns null for missing or invalid files', async () => {
    expect(await loadCompletedWorkCheckpoint(path.join(dir, 'missing.json'))).toBeNull();
    const fp = path.join(dir, 'invalid.json');
    await fs.writeFile(fp, JSON.stringify({ version: 1, completedWork: {} }), 'utf8');
    expect(await loadCompletedWorkCheckpoint(fp)).toBeNull();
  });

  it('strips UTF-8 BOM, filters non-finite completedAt, and preserves sessionId alongside traceId on save (F93)', async () => {
    const fp = path.join(dir, 'bom-checkpoint.json');
    const bomPayload =
      '\uFEFF' +
      JSON.stringify({
        version: 1,
        sessionId: 'sess-real',
        updatedAt: new Date().toISOString(),
        completedWork: [
          { key: 'k1', source: 'todo', summary: 'valid', completedAt: 1700000000000 },
          { key: 'k2', source: 'todo', summary: 'infinite', completedAt: null },
        ],
      }).replace('"completedAt":null', '"completedAt":1e500');
    await fs.writeFile(fp, bomPayload, 'utf8');
    const loaded = await loadCompletedWorkCheckpoint(fp);
    expect(loaded).toEqual([
      { key: 'k1', source: 'todo', summary: 'valid', completedAt: 1700000000000 },
    ]);

    const events = { emit: vi.fn() };
    await saveCompletedWorkCheckpoint(
      fp,
      'sess-owner-42',
      loaded ?? [],
      events as never,
      'trace-abc',
    );
    expect(events.emit).toHaveBeenCalledWith(
      'storage.write',
      expect.objectContaining({
        sessionId: 'sess-owner-42',
        traceId: 'trace-abc',
        store: 'completed-work',
      }),
    );
  });
});
