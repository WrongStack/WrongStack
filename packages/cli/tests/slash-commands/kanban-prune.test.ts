import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBoardObject, listBoards, writeBoard } from '@wrongstack/kanban';
import { afterEach, describe, expect, it } from 'vitest';
import { buildKanbanCommand } from '../../src/slash-commands/kanban.js';
import type { SlashCommandContext } from '../../src/slash-commands/command-context.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-prune-'));
  roots.push(root);
  return root;
}

function commandFor(projectRoot: string) {
  return buildKanbanCommand({
    projectRoot,
    onPanelOpen: { current: null },
  } as unknown as SlashCommandContext);
}

async function runPrune(root: string, argsText: string): Promise<{ message?: string | undefined }> {
  const result = await commandFor(root).run!(argsText);
  if (!result) throw new Error('expected /kanban prune to return a result');
  return result;
}

const OLD = '2026-01-01T00:00:00.000Z';

async function seedBoards(root: string): Promise<{ oldEmpty: string; oldUnfinished: string; fresh: string }> {
  const oldEmpty = createBoardObject({ title: 'Old empty run' });
  oldEmpty.updatedAt = OLD;
  await writeBoard(root, oldEmpty);

  const oldUnfinished = createBoardObject({ title: 'Old unfinished' });
  oldUnfinished.tasks = [
    {
      id: 'task-1',
      title: 'pending work',
      columnId: oldUnfinished.columns[0]?.id ?? 'backlog',
      status: 'pending',
      priority: 'medium',
      order: 0,
      createdAt: OLD,
      updatedAt: OLD,
    } as (typeof oldUnfinished.tasks)[number],
  ];
  oldUnfinished.updatedAt = OLD;
  await writeBoard(root, oldUnfinished);

  const fresh = createBoardObject({ title: 'Fresh board' });
  await writeBoard(root, fresh);

  return { oldEmpty: oldEmpty.id, oldUnfinished: oldUnfinished.id, fresh: fresh.id };
}

describe('/kanban prune', () => {
  it('is a dry run without --yes and deletes nothing', async () => {
    const root = await tempProject();
    await seedBoards(root);

    const result = await runPrune(root, 'prune 7');

    expect(result.message).toContain('Would prune 1 of 3 boards');
    expect((await listBoards(root)).length).toBe(3);
  });

  it('deletes only finished/empty stale boards with --yes', async () => {
    const root = await tempProject();
    const ids = await seedBoards(root);

    const result = await runPrune(root, 'prune 7 --yes');

    expect(result.message).toContain('Pruned 1 board');
    const remaining = (await listBoards(root)).map((b) => b.id).sort();
    expect(remaining).toEqual([ids.fresh, ids.oldUnfinished].sort());
  });

  it('includes unfinished stale boards with --all --yes', async () => {
    const root = await tempProject();
    const ids = await seedBoards(root);

    const result = await runPrune(root, 'prune 7 --all --yes');

    expect(result.message).toContain('Pruned 2 boards');
    const remaining = (await listBoards(root)).map((b) => b.id);
    expect(remaining).toEqual([ids.fresh]);
  });

  it('rejects a negative day count', async () => {
    const root = await tempProject();
    const result = await runPrune(root, 'prune -3');
    expect(result.message).toContain('Usage: /kanban prune');
  });

  it('accepts -y as a short alias for --yes', async () => {
    const root = await tempProject();
    const ids = await seedBoards(root);

    const result = await runPrune(root, 'prune 7 -y');

    expect(result.message).toContain('Pruned 1 board');
    const remaining = (await listBoards(root)).map((b) => b.id).sort();
    expect(remaining).toEqual([ids.fresh, ids.oldUnfinished].sort());
  });
});
