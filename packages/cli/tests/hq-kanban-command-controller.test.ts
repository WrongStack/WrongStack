import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addTask,
  assignTask,
  createBoard,
  createManagedLifecyclePolicy,
  getBoard,
} from '@wrongstack/kanban';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProjectKanbanAssignHandler,
  createProjectKanbanTransitionHandler,
} from '../src/hq-command-controller.js';

describe('HQ Kanban command IPC adapter', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-kanban-command-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  });

  it('commits through the canonical Kanban domain transition', async () => {
    const board = await createBoard(projectRoot, {
      title: 'HQ controlled board',
      lifecycle: createManagedLifecyclePolicy(),
    });
    const added = await addTask(
      projectRoot,
      board.id,
      {
        title: 'Ship mobile HQ',
        description: 'Validate and ship the guarded HQ mobile Kanban transition path.',
        assignee: 'reviewer-1',
        successCriteria: [
          {
            id: 'mobile-hq-works',
            description: 'Guarded transition reaches the project owner.',
            type: 'manual',
            status: 'pending',
          },
        ],
      },
      { sessionId: 'seed-session', actor: 'test' },
    );
    expect(added).not.toBeNull();

    const transition = createProjectKanbanTransitionHandler(projectRoot);
    await expect(
      transition({
        boardId: board.id,
        taskId: added!.task.id,
        to: 'todo',
        comment: 'Accepted from guarded HQ mobile preview',
        sessionId: 'mobile-session',
      }),
    ).resolves.toContain('transitioned to todo');

    const updated = await getBoard(projectRoot, board.id);
    const task = updated?.tasks.find((candidate) => candidate.id === added!.task.id);
    expect(task?.lifecycle?.currentStage).toBe('todo');
    expect(task?.status).toBe('ready');
  });

  it('fails rather than reporting success for a missing task', async () => {
    const board = await createBoard(projectRoot, {
      title: 'HQ controlled board',
      lifecycle: createManagedLifecyclePolicy(),
    });
    const transition = createProjectKanbanTransitionHandler(projectRoot);

    await expect(
      transition({
        boardId: board.id,
        taskId: 'missing-task',
        to: 'todo',
        comment: 'Should fail',
      }),
    ).rejects.toThrow('kanban task not found');
  });

  it('assigns through the canonical owner but refuses to steal an active assignment', async () => {
    const board = await createBoard(projectRoot, { title: 'Assignment board' });
    const added = await addTask(
      projectRoot,
      board.id,
      { title: 'Assign safely' },
      { sessionId: 'seed-session', actor: 'test' },
    );
    const assign = createProjectKanbanAssignHandler(projectRoot);

    await expect(
      assign({
        boardId: board.id,
        taskId: added!.task.id,
        agentId: 'reviewer-1',
        assignee: 'Reviewer',
        comment: 'Initial assignment',
      }),
    ).resolves.toContain('assigned to Reviewer');
    expect((await getBoard(projectRoot, board.id))?.tasks[0]?.assignment?.agentId).toBe(
      'reviewer-1',
    );

    await assignTask(
      projectRoot,
      board.id,
      added!.task.id,
      { agentId: 'worker-live', status: 'running' },
      { sessionId: 'worker-session', actor: 'worker-live' },
    );
    await expect(
      assign({
        boardId: board.id,
        taskId: added!.task.id,
        agentId: 'reviewer-2',
        assignee: 'Another reviewer',
        comment: 'Must not steal the lease',
      }),
    ).rejects.toThrow('active running assignment');
    expect((await getBoard(projectRoot, board.id))?.tasks[0]?.assignment?.agentId).toBe(
      'worker-live',
    );
  });
});
