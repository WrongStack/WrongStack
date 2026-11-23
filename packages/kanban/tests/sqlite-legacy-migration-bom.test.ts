import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBoardObject } from '../src/board-normalize.js';
import { SqliteKanbanStorage } from '../src/server/sqlite-storage.js';

const BOM = String.fromCharCode(0xfeff);

/**
 * F1480: the legacy JSON readers in storage.ts drop a leading UTF-8 BOM, so the
 * one-time migration into SQLite must accept the same files. A BOM-prefixed
 * board, event log or `.hq-sync.json` used to make `SqliteKanbanStorage.open`
 * throw, which kept the project's Kanban store from opening at all.
 */
describe('legacy Kanban migration with BOM-prefixed files (F1480)', () => {
  it('imports BOM-prefixed board, event and HQ sync files and stores the sync state without the BOM', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-legacy-bom-'));
    try {
      const dir = path.join(root, '.wrongstack', 'kanbans');
      await fs.mkdir(dir, { recursive: true });
      const board = createBoardObject({ title: 'BOM board' });
      const boardPath = path.join(dir, `${board.id}.json`);
      const eventsPath = path.join(dir, `${board.id}.events.jsonl`);
      const hqSyncPath = path.join(dir, '.hq-sync.json');
      await fs.writeFile(boardPath, `${BOM}${JSON.stringify(board, null, 2)}\n`, 'utf8');
      await fs.writeFile(
        eventsPath,
        `${BOM}${JSON.stringify({
          id: 'bom-event',
          boardId: board.id,
          type: 'task.activity',
          ts: new Date().toISOString(),
          actor: 'test',
        })}\r\n`,
        'utf8',
      );
      await fs.writeFile(
        hqSyncPath,
        `${BOM}${JSON.stringify({ boards: { [board.id]: { revision: 0 } }, tombstones: {} })}`,
        'utf8',
      );

      const storage = await SqliteKanbanStorage.open(root);
      try {
        expect((await storage.readBoard(board.id))?.title).toBe('BOM board');
        expect((await storage.readEvents(board.id)).map((event) => event.id)).toEqual([
          'bom-event',
        ]);
        const hqState = await storage.readMetadata('hq-sync-state-v1');
        expect(hqState?.charCodeAt(0)).not.toBe(0xfeff);
        expect(JSON.parse(hqState ?? 'null')).toMatchObject({
          boards: { [board.id]: { revision: 0 } },
        });
      } finally {
        storage.close();
      }
      await expect(fs.stat(boardPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(eventsPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(hqSyncPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  });
});
