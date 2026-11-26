import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { compactSessionMirrorBoard } from '../src/manager/prune.js';
import { mutateBoard } from '../src/storage.js';
import { addTask, createBoard, getBoard } from './helpers/session-manager.js';

it.each(['completed', 'open', 'unrelated'] as const)(
  'keeps only the required card graph during compaction (%s)',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-compact-dependencies-'));
    try {
      const board = await createBoard(root, { title: 'Mirror', tags: ['session', 'session-work'] });
      const first = await addTask(root, board.id, { title: 'First', status: 'completed' });
      if (!first) throw new Error('Missing first prerequisite');
      const second = await addTask(root, board.id, {
        title: 'Second',
        status: 'completed',
        dependsOn: [first.task.id],
      });
      const spare = await addTask(root, board.id, { title: 'Unrelated', status: 'completed' });
      if (!second || !spare) throw new Error('Missing terminal cards');
      const kept = await addTask(root, board.id, {
        title: 'Newest',
        status: mode === 'open' ? 'ready' : 'completed',
        dependsOn: mode === 'unrelated' ? [] : [second.task.id],
      });
      if (!kept) throw new Error('Missing retained card');
      // Fix the age order in storage rather than depending on wall-clock ticks.
      const timestamps = new Map([
        [first.task.id, '2025-01-01T00:00:00.000Z'],
        [second.task.id, '2025-01-02T00:00:00.000Z'],
        [spare.task.id, '2025-01-03T00:00:00.000Z'],
        [kept.task.id, '2025-01-04T00:00:00.000Z'],
      ]);
      await mutateBoard(root, board.id, (draft) => {
        for (const task of draft.tasks) task.updatedAt = timestamps.get(task.id) ?? task.updatedAt;
      });

      const limit = mode === 'open' ? 0 : 1;
      const result = await compactSessionMirrorBoard(root, board.id, { limit });
      const saved = await getBoard(root, board.id);
      const dependencies = (id: string) => saved?.tasks.find((task) => task.id === id)?.dependsOn;
      expect(
        result?.removedTaskIds.map((id) => {
          if (id === first.task.id) return 'first';
          if (id === second.task.id) return 'second';
          return id === spare.task.id ? 'spare' : id;
        }),
      ).toEqual(mode === 'unrelated' ? ['first', 'second', 'spare'] : ['spare']);
      expect(saved?.tasks.some((task) => task.id === kept.task.id)).toBe(true);
      if (mode !== 'unrelated') {
        expect(dependencies(kept.task.id)).toEqual([second.task.id]);
        expect(dependencies(second.task.id)).toEqual([first.task.id]);
        expect(saved?.tasks.some((task) => task.id === first.task.id)).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
