import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ readFile: vi.fn() }));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  io.readFile.mockImplementation(actual.readFile);
  return { ...actual, readFile: io.readFile };
});

import { appendKanbanEvent, getKanbanEventsPath } from '../src/storage.js';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-storage-io-'));
  io.readFile.mockClear();
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
});

describe('Kanban event log I/O', () => {
  it('does not rescan a large event log after every append', async () => {
    const boardId = 'io-board';
    const eventFile = getKanbanEventsPath(projectRoot, boardId);
    await fs.mkdir(path.dirname(eventFile), { recursive: true });
    const seeded = Array.from({ length: 6_000 }, (_, index) =>
      JSON.stringify({
        type: 'task.moved',
        taskId: `task-${index}`,
        fromColumn: 'todo',
        toColumn: 'doing',
        timestamp: '2026-07-21T00:00:00.000Z',
        padding: 'x'.repeat(32),
      }),
    ).join('\n');
    await fs.writeFile(eventFile, `${seeded}\n`, 'utf8');
    io.readFile.mockClear();

    const event = {
      id: 'event-latest',
      boardId,
      type: 'task.moved' as const,
      sessionId: '2026-08-26/sess_01TESTKANBAN0000000000000',
      ts: '2026-07-21T00:00:00.000Z',
      taskId: 'latest',
      fromColumn: 'todo',
      toColumn: 'doing',
      timestamp: '2026-07-21T00:00:00.000Z',
    };
    await appendKanbanEvent(projectRoot, boardId, event);
    await appendKanbanEvent(projectRoot, boardId, event);

    expect(
      io.readFile.mock.calls.filter(([file]) => String(file).endsWith(`${boardId}.events.jsonl`)),
    ).toHaveLength(1);
  });
});
