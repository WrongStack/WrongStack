import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@wrongstack/contracts/types/tool';
import {
  createBoard,
  evaluateContractGraphReadiness,
  evaluateKanbanBoundaryOpaque,
  evaluateKanbanBoundaryPath,
  readBoard,
  resolveKanbanBoundaryLayers,
} from '@wrongstack/kanban';
import { addTask } from '@wrongstack/kanban/test-support';
import { afterEach, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { evaluateToolKanbanBoundary } from '../../src/security/kanban-boundary.js';
import { setKanbanGovernance } from '../../src/security/kanban-governance-port.js';

// The project root may itself be a junction/symlink. A tool path written
// through the real root names an in-project file and must be judged like the
// same file written through the lexical root, not as "absolute / outside".
setKanbanGovernance({
  readBoard,
  resolveKanbanBoundaryLayers,
  evaluateKanbanBoundaryOpaque,
  evaluateKanbanBoundaryPath,
  evaluateContractGraphReadiness,
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('treats an absolute path through the real project root as in-project', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wstack-boundary-real-root-'));
  roots.push(base);
  const real = join(base, 'real');
  const projectRoot = join(base, 'link');
  await mkdir(join(real, 'src'), { recursive: true });
  await symlink(real, projectRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const board = await createBoard(projectRoot, {
    title: 'Linked root scope',
    boundary: {
      enabled: true,
      enforcement: 'block',
      shellAccess: 'block',
      allow: [{ kind: 'directory', path: 'src', access: 'write' }],
    },
  });
  const task = (await addTask(projectRoot, board.id, { title: 'Scoped edit' }))!.task;
  const ctx = {
    projectRoot,
    workingDir: projectRoot,
    currentKanbanBoardId: board.id,
    currentKanbanTaskId: task.id,
    meta: {},
  } as Context;
  const writeTool = { name: 'write', capabilities: ['fs.write'] } as unknown as Tool;
  const realRoot = await realpath(real);

  await expect(
    evaluateToolKanbanBoundary(writeTool, { path: join(realRoot, 'src/index.ts') }, ctx),
  ).resolves.toMatchObject({ decision: 'allow' });
  await expect(
    evaluateToolKanbanBoundary(writeTool, { path: join(realRoot, 'docs/index.md') }, ctx),
  ).resolves.toMatchObject({ decision: 'block', source: 'board' });
});
