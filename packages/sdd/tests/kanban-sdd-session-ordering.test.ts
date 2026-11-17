import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeKanbanServerConnections,
  getKanbanServerConnection,
  kanbanWorkflowId,
  readKanbanWorkflowState,
} from '@wrongstack/kanban';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { main, stopInProcess } from '../../kanban/src/server/project-server.js';
import { createKanbanSddSessionPersistence } from '../src/kanban-sdd-session.js';
import type { AISpecSession } from '../src/sdd-session-types.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const readFile = vi.mocked(fs.readFile).getMockImplementation()!;
const workflowId = kanbanWorkflowId('sdd', 'session');
const session: AISpecSession = {
  id: 's1',
  phase: 'questioning',
  title: 'Fixture',
  userIntent: 'Test ordering',
  projectContext: '',
  answers: [],
  questionCount: 0,
  approved: false,
  createdAt: 1,
  updatedAt: 1,
};
let root = '';
let legacy = '';

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'session-ordering-'));
  legacy = join(root, 'legacy.json');
  await main(['--project-root', root]);
  await getKanbanServerConnection(root);
});

beforeEach(async () => {
  await createKanbanSddSessionPersistence(root, legacy).delete();
  await fs.writeFile(legacy, JSON.stringify(session));
});

afterAll(async () => {
  closeKanbanServerConnections();
  await stopInProcess();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it('imports a legacy session once for concurrent loads on one adapter', async () => {
  const persistence = createKanbanSddSessionPersistence(root, legacy);
  const loaded = await Promise.all(Array.from({ length: 6 }, () => persistence.load()));
  expect(loaded).toEqual(Array.from({ length: 6 }, () => session));
  const state = await readKanbanWorkflowState(root, workflowId);
  expect(state?.revision).toBe(1);
  expect(state?.value).toEqual(session);
  loaded[0]!.title = 'changed only in caller';
  expect(loaded[1]?.title).toBe(session.title);
  expect((await persistence.load())?.title).toBe(session.title);
});

it.each(['delete', 'save'] as const)(
  'orders a %s requested while a legacy import is suspended',
  async (operation) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.mocked(fs.readFile).mockImplementation(async (...args) => {
      const value = await readFile(...args);
      if (String(args[0]) === legacy) {
        entered.resolve();
        await release.promise;
      }
      return value;
    });
    const persistence = createKanbanSddSessionPersistence(root, legacy);
    const latest = { ...session, title: 'Latest', updatedAt: 2 };
    const loading = persistence.load();
    void loading.catch(() => undefined);
    let mutation: Promise<void> | undefined;
    try {
      await entered.promise;
      mutation = operation === 'delete' ? persistence.delete() : persistence.save(latest);
      void mutation.catch(() => undefined);
      release.resolve();
      await expect(loading).resolves.toEqual(session);
      await mutation;
      const state = await readKanbanWorkflowState(root, workflowId);
      expect(state?.value ?? null).toEqual(operation === 'delete' ? null : latest);
      await expect(fs.stat(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
      await persistence.save({ ...latest, updatedAt: 3 });
      expect((await persistence.load())?.updatedAt).toBe(3);
    } finally {
      release.resolve();
      await Promise.allSettled([loading, ...(mutation ? [mutation] : [])]);
      vi.mocked(fs.readFile).mockImplementation(readFile);
    }
  },
);

it('recovers the operation queue after a stale write and refreshes its revision', async () => {
  const first = createKanbanSddSessionPersistence(root, legacy);
  await first.load();
  const stale = createKanbanSddSessionPersistence(root);
  await stale.load();
  await first.save({ ...session, title: 'Other writer', updatedAt: 2 });
  await expect(stale.save(session)).rejects.toMatchObject({ code: 'STALE_WRITE' });
  const loaded = await stale.load();
  expect(loaded?.title).toBe('Other writer');
  await stale.save({ ...session, title: 'Recovered', updatedAt: 3 });
  expect((await first.load())?.title).toBe('Recovered');
});
