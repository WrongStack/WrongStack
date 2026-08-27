/**
 * Tests for the managed lifecycle auto-transition behavior in the kanban
 * mark_assignment tool handler.
 *
 * These verify that:
 *   mark_assignment(running)  →  auto-advances Todo → Running
 *   mark_assignment(completed) →  auto-advances Running → Review
 *
 * The Kanban package is intentionally LLM- and provider-free; these tests
 * exercise the deterministic integration between updateTaskAssignment and
 * transitionTask through the tool handler.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { createBoard, getBoard } from '@wrongstack/kanban';
import { addTask, transitionTask, updateTaskAssignment } from '@wrongstack/kanban/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kanbanTool } from '../src/kanban.js';
import { newSignal } from './fixtures.js';

/** Session that owns the board events these tests write. */
const TEST_CONTEXT_SESSION_ID = '2026-08-26/sess_01TESTTOOLSCONTEXT0000000';

function managedBoardColumns() {
  // Columns are locked to DEFAULT_COLUMNS; this helper is kept for the lifecycle
  // mapping below but the `columns` field is now ignored by createBoard. The
  // lifecycle mapping references the standard column ids (in-progress, not
  // running).
  return [
    { id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0 },
    { id: 'todo', title: 'To Do', order: 1, wipLimit: 0 },
    { id: 'in-progress', title: 'In Progress', order: 2, wipLimit: 0 },
    { id: 'review', title: 'Review', order: 3, wipLimit: 0 },
    { id: 'done', title: 'Done', order: 4, wipLimit: 0 },
  ];
}

describe('kanban mark_assignment — managed lifecycle auto-transition', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-auto-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const ctx = () =>
    ({
      eventSessionId: () => TEST_CONTEXT_SESSION_ID,
      projectRoot: dir,
      agentId: 'test-agent',
    }) as unknown as Context;

  async function createManagedBoard() {
    const board = await createBoard(dir, {
      title: 'Managed board',
      columns: managedBoardColumns(),
      lifecycle: {
        mode: 'managed' as const,
        columns: {
          backlog: 'backlog',
          todo: 'todo',
          running: 'in-progress',
          review: 'review',
          done: 'done',
        },
      },
    });
    return board;
  }

  /** Advance a card through lifecycle stages to prepare for mark_assignment. */
  async function cardInStage(stage: 'backlog' | 'todo' | 'running' | 'review') {
    const board = await createManagedBoard();
    // addTask on a managed board creates the card in Backlog. Managed lifecycle
    // requires every forward transition to have required details populated.
    const result = await addTask(dir, board.id, {
      title: 'Managed task',
      description: 'A fully-described task with criteria and subtask.',
      dueDate: '2026-12-31',
      assignee: 'test-agent',
      labels: ['testing'],
      childTaskIds: ['sub'],
      successCriteria: [
        { id: 'c1', description: 'Test passes', type: 'manual', status: 'pending' },
      ],
    });
    const task = result!.task;
    const ALL_STAGES = ['backlog', 'todo', 'running', 'review'] as const;
    const targetIdx = ALL_STAGES.indexOf(stage);
    const needed = ALL_STAGES.slice(1, targetIdx + 1); // skip backlog, go up to and including target
    for (const s of needed) {
      // Before transitioning to 'running', seed an active assignment with
      // lease metadata so that validateRunningOwnership passes.
      if (s === 'running') {
        await updateTaskAssignment(dir, board.id, task.id, {
          status: 'running',
          agentId: 'test-worker',
          leaseId: `lease-${Date.now()}`,
          claimedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        });
      }
      await transitionTask(dir, board.id, task.id, {
        to: s,
        actor: 'test-agent',
        comment: 'Setup for test',
      });
    }
    return { board, task };
  }

  it('runs: auto-advances todo card to running on mark_assignment(running)', async () => {
    const { board, task } = await cardInStage('todo');

    const result = await kanbanTool.execute(
      {
        action: 'mark_assignment',
        boardId: board.id,
        taskId: task.id,
        assignmentStatus: 'running',
        agentId: 'test-worker',
        leaseId: 'lease-1',
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      },
      ctx(),
      { signal: newSignal() },
    );

    expect(result.ok).toBe(true);
    expect(result.task?.lifecycle?.currentStage).toBe('running');
    // Confirm the transition is persisted
    const reloaded = await getBoard(dir, board.id);
    const reloadedTask = reloaded?.tasks.find((t) => t.id === task.id);
    expect(reloadedTask?.lifecycle?.currentStage).toBe('running');
    expect(reloadedTask?.assignment?.status).toBe('running');
  });

  it('warns: leaves todo card when mark_assignment(running) has no lease metadata', async () => {
    const { board, task } = await cardInStage('todo');

    const result = await kanbanTool.execute(
      {
        action: 'mark_assignment',
        boardId: board.id,
        taskId: task.id,
        assignmentStatus: 'running',
      },
      ctx(),
      { signal: newSignal() },
    );

    expect(result.ok).toBe(true);
    expect(result.task?.lifecycle?.currentStage).toBe('todo');
    expect(result.message).toContain('Warning');
    expect(result.message).toContain('Running deferred');
  });

  it('runs: auto-advances running card to review on mark_assignment(completed)', async () => {
    const { board, task } = await cardInStage('running');

    const result = await kanbanTool.execute(
      {
        action: 'mark_assignment',
        boardId: board.id,
        taskId: task.id,
        assignmentStatus: 'completed',
        lastResult: 'All tests pass. Implementation verified.',
        agentId: 'test-worker',
        leaseId: 'lease-2',
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      },
      ctx(),
      { signal: newSignal() },
    );

    expect(result.ok).toBe(true);
    // Card advances to Review. Auto-verify runs because the task has
    // criteria, but auto-accept defers because they are still 'pending'.
    expect(result.task?.lifecycle?.currentStage).toBe('review');
    expect(result.message).toContain('Card advanced to review');
    expect(result.message).toContain('Auto-accept to Done deferred');
  });

  it('safe: does not advance completed card when stage is not running', async () => {
    const { board, task } = await cardInStage('todo');

    const result = await kanbanTool.execute(
      {
        action: 'mark_assignment',
        boardId: board.id,
        taskId: task.id,
        assignmentStatus: 'completed',
        lastResult: 'Done, but was never running.',
      },
      ctx(),
      { signal: newSignal() },
    );

    expect(result.ok).toBe(true);
    expect(result.task?.lifecycle?.currentStage).toBe('todo');
  });

  it('safe: does not overwrite card description with lastResult', async () => {
    const { board, task } = await cardInStage('running');

    const result = await kanbanTool.execute(
      {
        action: 'mark_assignment',
        boardId: board.id,
        taskId: task.id,
        assignmentStatus: 'completed',
        lastResult: 'Potential description overwrite attempt!',
        agentId: 'test-worker',
        leaseId: 'lease-3',
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      },
      ctx(),
      { signal: newSignal() },
    );

    expect(result.ok).toBe(true);
    const reloaded = await getBoard(dir, board.id);
    const reloadedTask = reloaded?.tasks.find((t) => t.id === task.id);
    expect(reloadedTask?.description).toBe('A fully-described task with criteria and subtask.');
  });

  /**
   * Auto-acceptance is a board policy, not a hard-wired behavior.
   *
   * The code accepted a verified card into Done on its own while the system
   * prompt and the bundled skill both said a reviewer must accept it — three
   * places, three contracts. `lifecycle.autoAccept` makes the board the single
   * authority; `undefined` keeps the historical behavior so no existing board
   * changes.
   *
   * These use a `file_exists` criterion because it is the cheapest check a
   * deterministic verifier can actually PASS — the `manual` criterion the other
   * fixtures use resolves to `skipped`, which never satisfies Definition of Done.
   */
  describe('lifecycle.autoAccept', () => {
    async function verifiableCardInRunning(autoAccept?: boolean) {
      const evidence = path.join(dir, 'evidence.txt');
      await fs.writeFile(evidence, 'verified', 'utf8');

      const board = await createBoard(dir, {
        title: 'Managed board',
        columns: managedBoardColumns(),
        lifecycle: {
          mode: 'managed' as const,
          columns: {
            backlog: 'backlog',
            todo: 'todo',
            running: 'in-progress',
            review: 'review',
            done: 'done',
          },
          ...(autoAccept !== undefined ? { autoAccept } : {}),
        },
      });
      const created = await addTask(dir, board.id, {
        title: 'Verifiable task',
        description: 'Produces a file the verifier can actually see.',
        assignee: 'test-agent',
        successCriteria: [
          {
            id: 'c1',
            description: 'evidence.txt exists',
            type: 'file_exists',
            status: 'pending',
            notes: 'evidence.txt',
          },
        ],
      });
      const task = created!.task;

      await transitionTask(dir, board.id, task.id, {
        to: 'todo',
        actor: 'test-agent',
        comment: 'Setup',
      });
      await updateTaskAssignment(dir, board.id, task.id, {
        status: 'running',
        agentId: 'test-worker',
        leaseId: 'lease-auto',
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      await transitionTask(dir, board.id, task.id, {
        to: 'running',
        actor: 'test-agent',
        comment: 'Setup',
      });
      return { board, task };
    }

    async function complete(boardId: string, taskId: string) {
      return kanbanTool.execute(
        {
          action: 'mark_assignment',
          boardId,
          taskId,
          assignmentStatus: 'completed',
          lastResult: 'Wrote the evidence file.',
          agentId: 'test-worker',
        },
        ctx(),
        { signal: newSignal() },
      );
    }

    it('accepts a verified card into Done by default', async () => {
      const { board, task } = await verifiableCardInRunning();

      const result = await complete(board.id, task.id);

      expect(result.ok).toBe(true);
      const reloaded = await getBoard(dir, board.id);
      const card = reloaded?.tasks.find((t) => t.id === task.id);
      expect(card?.lifecycle?.currentStage).toBe('done');
      expect(card?.verificationReport?.verdict).toBe('passed');
    });

    it('holds a verified card in Review when the board opts out', async () => {
      const { board, task } = await verifiableCardInRunning(false);

      const result = await complete(board.id, task.id);

      expect(result.ok).toBe(true);
      const reloaded = await getBoard(dir, board.id);
      const card = reloaded?.tasks.find((t) => t.id === task.id);
      expect(card?.lifecycle?.currentStage).toBe('review');
      // Verification still ran and still persisted — opting out withholds
      // acceptance, it does not skip the gate.
      expect(card?.verificationReport?.verdict).toBe('passed');
      // The message must not read as a verification failure.
      expect(result.message).toContain('does not auto-accept');
    });
  });
});
