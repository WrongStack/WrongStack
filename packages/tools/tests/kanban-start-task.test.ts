import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { createBoard, getBoard } from '@wrongstack/kanban';
import {
  addCheckToTask,
  addDependency,
  addGoalMetricToTask,
  addTask,
  configureContractGraph,
  updateTask,
  upsertContractNode,
} from '@wrongstack/kanban/test-support';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kanbanTool } from '../src/kanban.js';
import { newSignal } from './fixtures.js';

/** Session that owns the board events these tests write. */
const TEST_CONTEXT_SESSION_ID = '2026-08-26/sess_01TESTTOOLSCONTEXT0000000';

describe('kanban tool — start_task governance binding', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-start-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function seedReadyTask(options: { strictGraph?: 'complete' | 'empty' } = {}) {
    const board = await createBoard(dir, {
      title: 'Governed work',
      columns: [
        { id: 'backlog', title: 'Backlog', order: 0 },
        { id: 'todo', title: 'Todo', order: 1 },
        { id: 'in-progress', title: 'Running', order: 2 },
        { id: 'review', title: 'Review', order: 3 },
        { id: 'done', title: 'Done', order: 4 },
      ],
      lifecycle: {
        mode: 'managed',
        columns: {
          backlog: 'backlog',
          todo: 'todo',
          running: 'in-progress',
          review: 'review',
          done: 'done',
        },
      },
    });
    const added = await addTask(dir, board.id, {
      title: 'Implement safely',
      description: 'Change the parser while preserving existing behavior.',
      assignedAgent: 'agent-1',
      dueDate: '2026-08-10T00:00:00.000Z',
      labels: ['parser'],
    });
    const taskId = added!.task.id;
    await addGoalMetricToTask(dir, board.id, taskId, {
      name: 'New syntax parses',
      target: 'pass',
    });
    await addCheckToTask(dir, board.id, taskId, {
      description: 'Regression suite passes',
      type: 'test',
    });
    if (!options.strictGraph) return { boardId: board.id, taskId };

    await configureContractGraph(dir, board.id, 'strict');
    if (options.strictGraph === 'empty') return { boardId: board.id, taskId };

    const task = (await getBoard(dir, board.id))!.tasks.find((item) => item.id === taskId)!;
    const metricId = task.goalMetrics![0]!.id;
    const checkId = task.successCriteria![0]!.id;
    await upsertContractNode(dir, board.id, {
      taskId,
      kind: 'objective',
      title: 'Support new syntax',
      metricId,
    });
    await upsertContractNode(dir, board.id, {
      taskId,
      kind: 'guardrail',
      title: 'Preserve existing syntax',
      checkId,
    });
    await upsertContractNode(dir, board.id, {
      taskId,
      kind: 'risk',
      title: 'Token ambiguity',
      enforcement: 'advisory',
    });
    await upsertContractNode(dir, board.id, {
      taskId,
      kind: 'component',
      title: 'Parser package',
    });
    await upsertContractNode(dir, board.id, {
      taskId,
      kind: 'verification',
      title: 'Regression suite',
      checkId,
      enforcement: 'advisory',
    });
    return { boardId: board.id, taskId };
  }

  it('starts a detailed card without making Contract Map setup a prerequisite', async () => {
    const { boardId, taskId } = await seedReadyTask();
    const setCurrentKanbanTask = vi.fn();
    const ctx = {
      eventSessionId: () => TEST_CONTEXT_SESSION_ID,
      projectRoot: dir,
      setCurrentKanbanTask,
    } as unknown as Context;

    const result = await kanbanTool.execute(
      {
        action: 'start_task',
        boardId,
        taskId,
        author: 'agent-1',
        transitionComment: 'Contract reviewed; implementation starting.',
      },
      ctx,
      { signal: newSignal() },
    );

    expect(result.ok).toBe(true);
    expect(result.task?.lifecycle?.currentStage).toBe('running');
    expect(result.task?.assignment?.status).toBe('running');
    expect(result.task?.assignment?.leaseId).toBeTruthy();
    expect(setCurrentKanbanTask).toHaveBeenCalledWith(taskId, boardId);
  });

  it('still accepts a complete operator-owned strict Contract Map', async () => {
    const { boardId, taskId } = await seedReadyTask({ strictGraph: 'complete' });
    const setCurrentKanbanTask = vi.fn();

    const result = await kanbanTool.execute(
      {
        action: 'start_task',
        boardId,
        taskId,
        author: 'agent-1',
        transitionComment: 'Operator policy is satisfied; implementation starting.',
      },
      {
        eventSessionId: () => TEST_CONTEXT_SESSION_ID,
        projectRoot: dir,
        setCurrentKanbanTask,
      } as unknown as Context,
      { signal: newSignal() },
    );

    expect(result.ok).toBe(true);
    expect(result.task?.lifecycle?.currentStage).toBe('running');
  });

  it('does not make the model repair an incomplete strict map before starting', async () => {
    const { boardId, taskId } = await seedReadyTask({ strictGraph: 'empty' });
    const setCurrentKanbanTask = vi.fn();

    const result = await kanbanTool.execute(
      {
        action: 'start_task',
        boardId,
        taskId,
        author: 'agent-1',
        transitionComment: 'Starting from the real card contract.',
      },
      {
        eventSessionId: () => TEST_CONTEXT_SESSION_ID,
        projectRoot: dir,
        setCurrentKanbanTask,
      } as unknown as Context,
      { signal: newSignal() },
    );

    expect(result.ok).toBe(true);
    expect(result.task?.lifecycle?.currentStage).toBe('running');
  });

  it('restarts a Review card as a repair run instead of trapping continuation', async () => {
    const { boardId, taskId } = await seedReadyTask();
    const setCurrentKanbanTask = vi.fn();
    const ctx = {
      eventSessionId: () => TEST_CONTEXT_SESSION_ID,
      projectRoot: dir,
      agentId: 'agent-1',
      setCurrentKanbanTask,
    } as unknown as Context;

    await kanbanTool.execute(
      {
        action: 'start_task',
        boardId,
        taskId,
        author: 'agent-1',
        transitionComment: 'Starting implementation.',
      },
      ctx,
      { signal: newSignal() },
    );
    const completed = await kanbanTool.execute(
      {
        action: 'mark_assignment',
        boardId,
        taskId,
        assignmentStatus: 'completed',
        agentId: 'agent-1',
        lastResult: 'Implementation needs another verification pass.',
      },
      ctx,
      { signal: newSignal() },
    );
    expect(completed.task?.lifecycle?.currentStage).toBe('review');

    const restarted = await kanbanTool.execute(
      {
        action: 'start_task',
        boardId,
        taskId,
        author: 'agent-1',
        transitionComment: 'Addressing review findings.',
      },
      ctx,
      { signal: newSignal() },
    );

    expect(restarted.ok, restarted.message).toBe(true);
    expect(restarted.task?.lifecycle?.currentStage).toBe('running');
    expect(restarted.task?.assignment?.status).toBe('running');
  });

  it('starts a sparse card on an ordinary board and says governance is not bound', async () => {
    // The card contract (owner, acceptance criteria, contract graph) is a
    // managed-board construct. On an ordinary board nothing enforces it, so
    // refusing the card here withheld work for a demand no card could satisfy.
    // Starting succeeds; the message reports that governance was not bound
    // rather than pretending the card was governed.
    const board = await createBoard(dir, { title: 'Incomplete' });
    const added = await addTask(dir, board.id, { title: 'Unsafe change' });
    const setCurrentKanbanTask = vi.fn();

    const result = await kanbanTool.execute(
      {
        action: 'start_task',
        boardId: board.id,
        taskId: added!.task.id,
        author: 'agent-1',
        transitionComment: 'Start.',
      },
      {
        eventSessionId: () => TEST_CONTEXT_SESSION_ID,
        projectRoot: dir,
        setCurrentKanbanTask,
      } as unknown as Context,
      { signal: newSignal() },
    );

    expect(result.ok, result.message).toBe(true);
    expect(result.message).toContain('not in managed lifecycle mode');
    expect(result.task?.status).toBe('in_progress');
    expect(result.task?.assignment?.status).toBe('running');
  });

  it('still refuses an incomplete card on a managed board', async () => {
    // The relaxation above is scoped to ordinary boards. Where the lifecycle
    // is actually enforced, an unowned card with no acceptance criterion is
    // still not implementation-ready.
    const board = await createBoard(dir, {
      title: 'Governed but incomplete',
      columns: [
        { id: 'backlog', title: 'Backlog', order: 0 },
        { id: 'todo', title: 'Todo', order: 1 },
        { id: 'in-progress', title: 'Running', order: 2 },
        { id: 'review', title: 'Review', order: 3 },
        { id: 'done', title: 'Done', order: 4 },
      ],
      lifecycle: {
        mode: 'managed',
        columns: {
          backlog: 'backlog',
          todo: 'todo',
          running: 'in-progress',
          review: 'review',
          done: 'done',
        },
      },
    });
    // A managed board validates the card at creation, so the card has to be
    // well-formed enough to exist. What it still lacks is an owner and an
    // acceptance criterion — the two things start_task is meant to insist on.
    const added = await addTask(dir, board.id, {
      title: 'Unsafe change',
      description: 'Change the parser while preserving existing behavior.',
    });
    const setCurrentKanbanTask = vi.fn();

    const result = await kanbanTool.execute(
      {
        action: 'start_task',
        boardId: board.id,
        taskId: added!.task.id,
        author: 'agent-1',
        transitionComment: 'Start.',
      },
      {
        eventSessionId: () => TEST_CONTEXT_SESSION_ID,
        projectRoot: dir,
        setCurrentKanbanTask,
      } as unknown as Context,
      { signal: newSignal() },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('not implementation-ready');
    expect(setCurrentKanbanTask).not.toHaveBeenCalled();
  });

  it('names the blocking card in the refusal instead of a bare id', async () => {
    // The refusal is read by an agent deciding what to do next. A UUID does
    // not say what the work is waiting for, so it cannot act on the answer.
    const board = await createBoard(dir, { title: 'Ordered work' });
    const blocker = await addTask(dir, board.id, { title: 'Backfill rows' });
    const dependent = await addTask(dir, board.id, { title: 'Ship release' });
    await addDependency(dir, board.id, dependent!.task.id, blocker!.task.id);

    const result = await kanbanTool.execute(
      {
        action: 'start_task',
        boardId: board.id,
        taskId: dependent!.task.id,
        author: 'agent-1',
        transitionComment: 'Start.',
      },
      {
        eventSessionId: () => TEST_CONTEXT_SESSION_ID,
        projectRoot: dir,
        setCurrentKanbanTask: vi.fn(),
      } as unknown as Context,
      { signal: newSignal() },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Backfill rows');
    expect(result.message).not.toContain(blocker!.task.id);
    // The IPC envelope is a transport detail and must never reach the model.
    expect(result.message).not.toContain('LIFECYCLE_ISSUES');
  });

  it('refuses a dependency-blocked card without leaving a running assignment behind', async () => {
    const { boardId, taskId } = await seedReadyTask();
    const dependency = await addTask(dir, boardId, {
      title: 'Required predecessor',
      description: 'Must finish before the implementation task.',
    });
    await updateTask(dir, boardId, taskId, { dependsOn: [dependency!.task.id] });
    const setCurrentKanbanTask = vi.fn();

    const result = await kanbanTool.execute(
      {
        action: 'start_task',
        boardId,
        taskId,
        author: 'agent-1',
        transitionComment: 'Trying to start too early.',
      },
      {
        eventSessionId: () => TEST_CONTEXT_SESSION_ID,
        projectRoot: dir,
        setCurrentKanbanTask,
      } as unknown as Context,
      { signal: newSignal() },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('every dependency');
    expect(setCurrentKanbanTask).not.toHaveBeenCalled();
    const persisted = await getBoard(dir, boardId);
    expect(persisted!.tasks.find((task) => task.id === taskId)?.assignment).toBeUndefined();
  });

  it('binds a plain-board card for attribution, without claiming governance', async () => {
    // Attribution and governance are two decisions, and one call used to make
    // both: withholding the binding on a non-managed board (the default) left
    // `currentKanbanTaskId` undefined for the whole session, so every
    // `recordFileEvent()` wrote `scope: 'session'` and no edit was ever
    // attributed to the card the board showed as `in_progress`.
    //
    // Binding is safe: the boundary reads governance from the BOARD's
    // lifecycle mode, not from the presence of a binding.
    const board = await createBoard(dir, {
      title: 'Plain project board',
      columns: [{ id: 'todo', title: 'Todo', order: 0 }],
    });
    const added = await addTask(dir, board.id, { title: 'Ordinary work' });
    const setCurrentKanbanTask = vi.fn();

    const result = await kanbanTool.execute(
      {
        action: 'start_task',
        boardId: board.id,
        taskId: added!.task.id,
        author: 'agent-1',
        transitionComment: 'Starting ordinary work on a plain board.',
      },
      {
        eventSessionId: () => TEST_CONTEXT_SESSION_ID,
        projectRoot: dir,
        setCurrentKanbanTask,
      } as unknown as Context,
      { signal: newSignal() },
    );

    expect(result.ok).toBe(true);
    expect(setCurrentKanbanTask).toHaveBeenCalledWith(added!.task.id, board.id);
    // The message must still be honest about which of the two happened.
    expect(result.message).toContain('not in managed lifecycle mode');
    expect(result.message).toContain('attribution');
  });
});

describe('kanban tool — one board per line of work', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-boards-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const ctx = () =>
    ({
      eventSessionId: () => TEST_CONTEXT_SESSION_ID,
      projectRoot: dir,
      setCurrentKanbanTask: vi.fn(),
    }) as unknown as Context;

  it('names the boards that already exist when a second one is created', async () => {
    // Work fragmenting across boards is the reported symptom: the same card in
    // two places, or a board holding a single task. The create still succeeds —
    // the caller is told what exists so it can continue instead.
    await kanbanTool.execute({ action: 'create_board', title: 'Project work' }, ctx(), {
      signal: newSignal(),
    });
    await addTask(
      dir,
      (await kanbanTool.execute({ action: 'list_boards' }, ctx(), { signal: newSignal() }))
        .boards![0]!.id,
      { title: 'First card' },
    );

    const second = await kanbanTool.execute(
      { action: 'create_board', title: 'Another board' },
      ctx(),
      { signal: newSignal() },
    );

    expect(second.ok).toBe(true);
    expect(second.message).toContain('Project work');
    expect(second.message).toContain('add_task there instead');
  });

  it('says nothing extra when this is the first board', async () => {
    const first = await kanbanTool.execute({ action: 'create_board', title: 'Only board' }, ctx(), {
      signal: newSignal(),
    });

    expect(first.ok).toBe(true);
    expect(first.message).toBe('Board created: Only board.');
  });
});
