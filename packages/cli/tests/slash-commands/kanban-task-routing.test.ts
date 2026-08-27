/**
 * Integration coverage for `/kanban task done | block | move`.
 *
 * These commands historically short-circuited the managed lifecycle by writing
 * `status`/`columnId` directly through `updateTask` / `moveTask`. That worked on
 * plain boards but failed silently on managed ones (the lifecycle guard raises
 * `KanbanLifecycleError`, and `updateTask` returns false → "Task not found").
 *
 * The post-refactor contract:
 *   • `task done` on a managed board routes through `transitionTask({to:'done'})`
 *     and surfaces a clear diagnostic when the lifecycle guard rejects.
 *   • `task block` on a managed board is a no-op with a clear diagnostic
 *     ("blocked is not a managed stage"); on a plain board it falls back to
 *     `updateTask` for backward compatibility.
 *   • `task move` on a managed board routes through `transitionTask` using the
 *     lifecycle column mapping; on a plain board it falls back to `moveTask`.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createManagedLifecyclePolicy,
  getBoard,
  type KanbanBoard,
  type KanbanTask,
  listBoards,
  writeBoard,
} from '@wrongstack/kanban';
import { createBoardObject } from '@wrongstack/kanban/test-support';
import { afterEach, describe, expect, it } from 'vitest';
import type { SlashCommandContext } from '../../src/slash-commands/command-context.js';
import { buildKanbanCommand } from '../../src/slash-commands/kanban.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-slash-routing-'));
  roots.push(root);
  return root;
}

function commandFor(projectRoot: string) {
  return buildKanbanCommand({
    projectRoot,
    onPanelOpen: { current: null },
    // /kanban writes durable board events; they belong to the session running
    // the command.
    context: { eventSessionId: () => '2026-08-26/sess_01TESTKANBANSLASH0000000' },
  } as unknown as SlashCommandContext);
}

async function runKanban(
  root: string,
  argsText: string,
): Promise<{ message?: string | undefined }> {
  const result = await commandFor(root).run!(argsText);
  if (!result) throw new Error(`expected /kanban ${argsText} to return a result`);
  return result;
}

function managedBoardFixture(): KanbanBoard {
  const board = createBoardObject({ title: 'Managed routing board' });
  // Default columns: backlog, todo, in-progress, review, done — matches
  // createManagedLifecyclePolicy defaults.
  const policy = createManagedLifecyclePolicy();
  board.lifecycle = {
    mode: 'managed',
    columns: { ...policy.columns },
    adoptedAt: new Date().toISOString(),
    adoptedBy: 'test-fixture',
    adoptionComment: 'seed for slash-command routing tests',
  };
  return board;
}

function plainBoardFixture(): KanbanBoard {
  const board = createBoardObject({ title: 'Plain routing board' });
  // Plain boards leave lifecycle undefined (default createBoardObject behaviour).
  return board;
}

function findTask(board: KanbanBoard, title: string): KanbanTask {
  const task = board.tasks.find((entry) => entry.title === title);
  if (!task) throw new Error(`fixture task not seeded: ${title}`);
  return task;
}

async function seedRunningTask(
  root: string,
  board: KanbanBoard,
  title: string,
): Promise<{ boardId: string; taskId: string }> {
  // Managed boards require persistence through `writeBoard` to be read back
  // by the storage layer. Mark the card as in-progress so `task done` can
  // attempt the Review→Done transition without complaining about evidence.
  const lifecycle = board.lifecycle;
  const runningColumnId = lifecycle?.columns.running;
  if (!runningColumnId) throw new Error('fixture is not a managed board');
  board.tasks = [
    {
      id: 'task-routing-1',
      title,
      columnId: runningColumnId,
      status: 'in_progress',
      priority: 'medium',
      order: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      description: 'seeded for routing tests',
      dueDate: '2099-12-31',
      labels: ['test'],
      assignee: 'test-agent',
      assignment: {
        agentId: 'test-agent',
        name: 'test-agent',
        status: 'running',
        leaseId: 'lease-fixture-1',
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        lastResult: 'fixture-seeded completion result for evidence validation',
      },
      successCriteria: [
        {
          id: 'crit-1',
          description: 'trivial check',
          type: 'manual',
          status: 'passed',
          checkedBy: 'system',
        },
      ],
      verificationReport: {
        taskId: 'task-routing-1',
        taskTitle: title,
        boardId: board.id,
        verdict: 'passed',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        checks: [],
        markdownSummary: 'Fixture verification passed.',
        attachments: [],
      },
    } as KanbanTask,
  ];
  await writeBoard(root, board);
  return { boardId: board.id, taskId: 'task-routing-1' };
}

describe('/kanban task done — managed routing', () => {
  it('routes through transitionTask and surfaces lifecycle guard diagnostics', async () => {
    const root = await tempProject();
    const board = managedBoardFixture();
    const { boardId, taskId } = await seedRunningTask(root, board, 'auto-done card');

    const result = await runKanban(root, `task done ${boardId} ${taskId}`);

    // Managed cards in `running` cannot jump straight to `done`; the lifecycle
    // guard requires the Review stage first. The refactor must surface this as
    // a readable message rather than the old generic "Task not found".
    expect(result.message).toBeDefined();
    expect(result.message).toMatch(/Review|lifecycle|Done/i);

    // The card must still be in `running` — failed transitions must not mutate.
    const after = await getBoard(root, boardId);
    expect(after).not.toBeNull();
    const card = findTask(after!, 'auto-done card');
    expect(card.status).toBe('in_progress');
    expect(card.columnId).toBe(board.lifecycle!.columns.running);
  });
});

describe('/kanban task done — managed non-atomic happy path', () => {
  it('routes through transitionTask and advances to Done with --attachment --note', async () => {
    const root = await tempProject();
    const board = managedBoardFixture();
    const reviewColumnId = board.lifecycle!.columns.review;
    // Park the card in review so done only needs reviewer evidence — no
    // additional lifecycle hops, no extra evidence required on the way up.
    board.tasks = [
      {
        id: 'task-done-evidence-1',
        title: 'evidence-backed card',
        columnId: reviewColumnId,
        status: 'review',
        priority: 'medium',
        order: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        description: 'non-atomic card ready for done with evidence',
        dueDate: '2099-12-31',
        labels: ['test'],
        assignee: 'test-agent',
        assignment: {
          agentId: 'test-agent',
          name: 'test-agent',
          status: 'running',
          leaseId: 'lease-fixture-done',
          claimedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          lastResult: 'fixture-seeded review evidence',
        },
        successCriteria: [
          {
            id: 'crit-done-1',
            description: 'trivial check',
            type: 'manual',
            status: 'passed',
            checkedBy: 'system',
          },
        ],
      } as KanbanTask,
    ];
    await writeBoard(root, board);

    const result = await runKanban(
      root,
      `task done ${board.id} task-done-evidence-1 --attachment https://example.test/review --note "ran and verified"`,
    );

    // Non-atomic managed cards only need reviewer evidence + action; the slash
    // command forwards --attachment and --note to the transition input, so the
    // lifecycle guard must accept the call and the card must end up in Done.
    expect(result.message).toBeDefined();
    expect(result.message).not.toMatch(/needs? (an )?assignee|verify_completion/i);

    const after = await getBoard(root, board.id);
    expect(after).not.toBeNull();
    const card = findTask(after!, 'evidence-backed card');
    expect(card.columnId).toBe(board.lifecycle!.columns.done);
    expect(card.status).toBe('completed');
  });
});

describe('/kanban task done — managed atomic happy path', () => {
  it('advances to Done once verify_completion has produced a passing verificationReport', async () => {
    const root = await tempProject();
    const board = managedBoardFixture();
    const reviewColumnId = board.lifecycle!.columns.review;
    board.tasks = [
      {
        id: 'task-parent-1',
        title: 'atomic parent card',
        columnId: reviewColumnId,
        status: 'review',
        priority: 'medium',
        order: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        description: 'atomic parent referencing one child',
        dueDate: '2099-12-31',
        labels: ['test'],
        assignee: 'test-agent',
        atomic: true,
        childTaskIds: ['task-done-atomic-1'],
        successCriteria: [
          {
            id: 'crit-parent-1',
            description: 'parent check',
            type: 'manual',
            status: 'passed',
            checkedBy: 'system',
          },
        ],
        verificationReport: {
          taskId: 'task-parent-1',
          taskTitle: 'atomic parent card',
          boardId: board.id,
          verdict: 'passed',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          checks: [],
          markdownSummary: 'Parent verification passed.',
          attachments: [],
        },
      },
      {
        id: 'task-done-atomic-1',
        title: 'atomic evidence-backed card',
        columnId: reviewColumnId,
        status: 'review',
        priority: 'medium',
        order: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        description: 'atomic card with passing verification report',
        dueDate: '2099-12-31',
        labels: ['test'],
        assignee: 'test-agent',
        atomic: true,
        assignment: {
          agentId: 'test-agent',
          name: 'test-agent',
          status: 'running',
          leaseId: 'lease-fixture-atomic-done',
          claimedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          lastResult: 'fixture-seeded review evidence',
        },
        successCriteria: [
          {
            id: 'crit-atomic-1',
            description: 'trivial check',
            type: 'manual',
            status: 'passed',
            checkedBy: 'system',
          },
        ],
        verificationReport: {
          taskId: 'task-done-atomic-1',
          taskTitle: 'atomic evidence-backed card',
          boardId: board.id,
          verdict: 'passed',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          checks: [],
          markdownSummary: 'Atomic verification passed.',
          attachments: [],
        },
        childTaskIds: ['task-stub-leaf-1'],
      } as KanbanTask,
      {
        id: 'task-stub-leaf-1',
        title: 'atomic child leaf (already completed)',
        columnId: board.lifecycle!.columns.done,
        status: 'completed',
        priority: 'medium',
        order: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        description: 'decomposed leaf with passing criteria',
        successCriteria: [
          {
            id: 'crit-leaf-1',
            description: 'trivial check',
            type: 'manual',
            status: 'passed',
            checkedBy: 'system',
          },
        ],
      } as KanbanTask,
    ];
    await writeBoard(root, board);

    const result = await runKanban(
      root,
      `task done ${board.id} task-done-atomic-1 --attachment https://example.test/review --note "ran and verified"`,
    );

    // Atomic cards additionally need a passing verificationReport; the
    // reviewer-evidence flags alone are not enough. With the report seeded
    // (the equivalent of running verify_completion first), Done must succeed.
    expect(result.message).toBeDefined();
    expect(result.message).not.toMatch(/needs? (an )?assignee/i);
    expect(result.message).not.toMatch(/verify_completion/i);

    const after = await getBoard(root, board.id);
    expect(after).not.toBeNull();
    const card = findTask(after!, 'atomic evidence-backed card');
    expect(card.columnId).toBe(board.lifecycle!.columns.done);
    expect(card.status).toBe('completed');
  });
});

describe('/kanban task done — atomic parent / pending child gate', () => {
  it('rejects done when a child leaf is still pending (validateParentChildGate)', async () => {
    const root = await tempProject();
    const board = managedBoardFixture();
    const OLD = '2026-01-01T00:00:00.000Z';
    const reviewColumnId = board.lifecycle!.columns.review;
    board.tasks = [
      {
        id: 'task-atomic-parent-pending',
        title: 'atomic parent with pending child',
        description: 'atomic parent with pending child',
        dueDate: '2099-12-31',
        labels: ['test'],
        assignee: 'agent-exec',
        assignedAgent: 'agent-exec',
        columnId: reviewColumnId,
        status: 'pending',
        priority: 'medium',
        order: 0,
        createdAt: OLD,
        updatedAt: OLD,
        atomic: true,
        childTaskIds: ['task-stub-pending-leaf'],
        successCriteria: [
          { id: 'crit-1', description: 'verified', type: 'manual', status: 'passed' },
        ],
        verificationReport: {
          boardId: board.id,
          taskId: 'task-atomic-parent-pending',
          taskTitle: 'atomic parent with pending child',
          verdict: 'passed',
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:00.000Z',
          checks: [],
          markdownSummary: 'Fixture verification passed.',
          attachments: [],
        },
        assignment: {
          agentId: 'agent-exec',
          name: 'agent-exec',
          status: 'running',
          leaseId: 'lease-1',
          claimedAt: '2026-01-01T00:00:00.000Z',
          heartbeatAt: '2026-01-01T00:00:00.000Z',
          leaseExpiresAt: '2026-01-01T00:10:00.000Z',
          lastResult: 'implemented feature',
        },
      },
      {
        id: 'task-stub-pending-leaf',
        title: 'pending stub leaf',
        columnId: board.columns.find((c) => c.id !== reviewColumnId)?.id ?? reviewColumnId,
        status: 'pending',
        priority: 'medium',
        order: 1,
        createdAt: OLD,
        updatedAt: OLD,
      },
    ];
    await writeBoard(root, board);
    const boardId = board.id;
    const taskId = 'task-atomic-parent-pending';

    const result = await runKanban(
      root,
      `task done ${boardId} ${taskId} --attachment https://example.test/review --note "ran and verified"`,
    );

    expect(result.message).toBeDefined();
    expect(result.message).toMatch(/children|leaf|completed/i);
    expect(result.message).not.toMatch(/completed successfully/i);

    const after = await getBoard(root, boardId);
    const card = findTask(after!, 'atomic parent with pending child');
    expect(card.columnId).toBe(reviewColumnId);
    expect(card.status).not.toBe('completed');
  });
});

describe('/kanban task block — managed diagnosis', () => {
  it('returns a clear diagnostic instead of letting updateTask fail on managed boards', async () => {
    const root = await tempProject();
    const board = managedBoardFixture();
    const { boardId, taskId } = await seedRunningTask(root, board, 'do-not-block card');

    const result = await runKanban(root, `task block ${boardId} ${taskId}`);

    expect(result.message).toMatch(/not supported on managed boards/);
    expect(result.message).toMatch(/release/);
    // Card must remain in its original state.
    const after = await getBoard(root, boardId);
    const card = findTask(after!, 'do-not-block card');
    expect(card.status).toBe('in_progress');
  });
});

describe('/kanban task move — managed routing', () => {
  it('routes through transitionTask using the lifecycle column mapping', async () => {
    const root = await tempProject();
    const board = managedBoardFixture();
    const { boardId, taskId } = await seedRunningTask(root, board, 'move-me card');

    // Review no longer demands an evidence URL: real work often has no
    // artifact to link, and requiring one made Review a dead end whose only
    // remedy was a field on the transition call itself. The substantive
    // requirement — a recorded implementation result — still applies, and
    // `seedRunningTask` persists one, so the move routes through
    // `transitionTask` and lands on the mapped review column.
    const reviewColumnId = board.lifecycle!.columns.review;
    const result = await runKanban(root, `task move ${boardId} ${taskId} ${reviewColumnId}`);

    expect(result.message).toBeDefined();

    const after = await getBoard(root, boardId);
    const card = findTask(after!, 'move-me card');
    expect(card.status).toBe('review');
    expect(card.columnId).toBe(reviewColumnId);
  });

  it('forwards --attachment + --note through transitionTask for managed move', async () => {
    const root = await tempProject();
    const board = managedBoardFixture();
    const { boardId, taskId } = await seedRunningTask(root, board, 'move-evidence card');

    // Attach a reviewer URL + note; the lifecycle `validateReviewEvidence`
    // gate requires both `task.assignment.lastResult` and `input.attachment.url`,
    // so a non-empty attachment flips the move from "rejected" to "accepted".
    const reviewColumnId = board.lifecycle!.columns.review;
    const result = await runKanban(
      root,
      `task move ${boardId} ${taskId} ${reviewColumnId} --attachment https://example.test/review --note "ran and verified"`,
    );

    expect(result.message).toBeDefined();
    expect(result.message).toMatch(/moved|Marked|Move/i);
    expect(result.message).not.toMatch(/needs? (an? )?attention|verify_completion/i);

    const after = await getBoard(root, boardId);
    const card = findTask(after!, 'move-evidence card');
    expect(card.columnId).toBe(reviewColumnId);
  });

  it('falls back to updateTask on plain boards (legacy compatibility)', async () => {
    const root = await tempProject();
    const board = plainBoardFixture();
    const firstColumnId = board.columns[0]?.id;
    const secondColumnId = board.columns[1]?.id;
    expect(firstColumnId).toBeDefined();
    expect(secondColumnId).toBeDefined();
    board.tasks = [
      {
        id: 'plain-task-1',
        title: 'plain board card',
        columnId: firstColumnId!,
        status: 'pending',
        priority: 'medium',
        order: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as KanbanTask,
    ];
    await writeBoard(root, board);

    const result = await runKanban(root, `task move ${board.id} plain-task-1 ${secondColumnId}`);

    // Plain boards keep the legacy "✅ Task moved." UX. The board was already
    // loaded, so the command must not regress the legacy path.
    expect(result.message).toMatch(/moved/i);
  });
});

describe('kanban slash coverage smoke', () => {
  it('seeds at least one board for downstream coverage to keep its list non-empty', async () => {
    const root = await tempProject();
    const board = plainBoardFixture();
    await writeBoard(root, board);
    const boards = await listBoards(root);
    expect(boards.length).toBeGreaterThanOrEqual(1);
  });
});

describe('/kanban task done — managed preflight on todo stage', () => {
  // Helper: park a card in `todo` without assignment lease metadata. The
  // preflight must catch the missing lease before any transition runs, so
  // the card stays in `todo` and no audit history is corrupted.
  async function seedTodoCardWithoutLease(
    root: string,
    board: KanbanBoard,
    title: string,
  ): Promise<{ boardId: string; taskId: string }> {
    const lifecycle = board.lifecycle;
    const todoColumnId = lifecycle?.columns.todo;
    if (!todoColumnId) throw new Error('fixture is not a managed board');
    board.tasks = [
      {
        id: 'task-preflight-1',
        title,
        columnId: todoColumnId,
        status: 'pending',
        priority: 'medium',
        order: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        description: 'todo-stage card missing lease metadata',
        dueDate: '2099-12-31',
        labels: ['test'],
        assignee: 'test-agent',
        successCriteria: [
          {
            id: 'crit-preflight-1',
            description: 'trivial check',
            type: 'manual',
            status: 'passed',
            checkedBy: 'system',
          },
        ],
      } as KanbanTask,
    ];
    await writeBoard(root, board);
    return { boardId: board.id, taskId: 'task-preflight-1' };
  }

  it('reports the missing-lease diagnostic and leaves the card in todo (no intermediate transition)', async () => {
    const root = await tempProject();
    const board = managedBoardFixture();
    const { boardId, taskId } = await seedTodoCardWithoutLease(root, board, 'todo-stuck card');

    const result = await runKanban(
      root,
      `task done ${boardId} ${taskId} --attachment https://example.test/review --note "ran and verified"`,
    );

    expect(result.message).toBeDefined();
    expect(result.message).toMatch(/lease|Running/i);
    expect(result.message).toMatch(/needs? attention/);

    // Card must remain in `todo` — the preflight must short-circuit before
    // any transitionTask call runs, otherwise the card could end up parked
    // mid-flow with a corrupt audit history.
    const after = await getBoard(root, boardId);
    expect(after).not.toBeNull();
    const card = findTask(after!, 'todo-stuck card');
    expect(card.columnId).toBe(board.lifecycle!.columns.todo);
    expect(card.status).toBe('pending');
  });

  it('walks the card todo → running → review → done when preflight passes', async () => {
    const root = await tempProject();
    const board = managedBoardFixture();
    const todoColumnId = board.lifecycle!.columns.todo;
    const runningColumnId = board.lifecycle!.columns.running;
    const reviewColumnId = board.lifecycle!.columns.review;
    const doneColumnId = board.lifecycle!.columns.done;
    const taskId = 'task-preflight-happy-1';
    const stamp = '2026-02-01T00:00:00.000Z';
    board.tasks = [
      {
        id: taskId,
        title: 'todo-with-lease card',
        columnId: todoColumnId,
        status: 'pending',
        priority: 'medium',
        order: 0,
        createdAt: stamp,
        updatedAt: stamp,
        description: 'card parked in todo with full preflight metadata',
        dueDate: '2099-12-31',
        labels: ['test'],
        assignee: 'test-agent',
        assignedAgent: 'test-agent',
        successCriteria: [
          {
            id: 'crit-preflight-happy-1',
            description: 'trivial check',
            type: 'manual',
            status: 'passed',
            checkedBy: 'system',
          },
        ],
        // Lease metadata is what the running-stage preflight checks; even
        // though the card is parked in `todo`, the preflight still expects
        // an active worker lease because the sequential path will move it
        // through `running` before settling on `done`.
        assignment: {
          status: 'running',
          agentId: 'test-agent',
          name: 'Test Agent',
          leaseId: 'lease-happy-1',
          claimedAt: stamp,
          heartbeatAt: stamp,
          leaseExpiresAt: '2099-12-31T00:00:00.000Z',
          lastResult: 'implemented feature X and verified end-to-end',
        },
      } as KanbanTask,
    ];
    await writeBoard(root, board);

    const result = await runKanban(
      root,
      `task done ${board.id} ${taskId} --attachment https://example.test/review --note "ran and verified"`,
    );

    expect(result.message).toMatch(/completed/i);

    // Sequential path: todo → running → review → done. After the call the
    // card should be parked in the `done` column with `completed` status.
    // Intermediate columns must NOT contain the card — if the preflight or
    // transition chain leaked the card mid-flow, the assertions below would
    // catch the corruption.
    const after = await getBoard(root, board.id);
    expect(after).not.toBeNull();
    const card = findTask(after!, 'todo-with-lease card');
    expect(card.columnId).toBe(doneColumnId);
    expect(card.columnId).not.toBe(todoColumnId);
    expect(card.columnId).not.toBe(runningColumnId);
    expect(card.columnId).not.toBe(reviewColumnId);
  });

  it('walks the card backlog → todo → running → review → done when preflight passes', async () => {
    const root = await tempProject();
    const board = managedBoardFixture();
    const backlogColumnId = board.lifecycle!.columns.backlog;
    const todoColumnId = board.lifecycle!.columns.todo;
    const runningColumnId = board.lifecycle!.columns.running;
    const reviewColumnId = board.lifecycle!.columns.review;
    const doneColumnId = board.lifecycle!.columns.done;
    const taskId = 'task-preflight-backlog-happy-1';
    const stamp = '2026-02-01T00:00:00.000Z';
    board.tasks = [
      {
        id: taskId,
        title: 'backlog-with-lease card',
        columnId: backlogColumnId,
        status: 'pending',
        priority: 'medium',
        order: 0,
        createdAt: stamp,
        updatedAt: stamp,
        description: 'card parked in backlog with full preflight metadata',
        dueDate: '2099-12-31',
        labels: ['test'],
        assignee: 'test-agent',
        assignedAgent: 'test-agent',
        successCriteria: [
          {
            id: 'crit-backlog-1',
            description: 'trivial check',
            type: 'manual',
            status: 'passed',
            checkedBy: 'system',
          },
        ],
        assignment: {
          agentId: 'test-agent',
          name: 'test-agent',
          status: 'running',
          leaseId: 'lease-fixture-backlog-done',
          claimedAt: stamp,
          heartbeatAt: stamp,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          lastResult: 'fixture-seeded review evidence',
        },
      } as KanbanTask,
    ];
    await writeBoard(root, board);

    const result = await runKanban(
      root,
      `task done ${board.id} ${taskId} --attachment https://example.test/review --note "ran and verified"`,
    );

    expect(result.message).toMatch(/completed/i);
    const after = await getBoard(root, board.id);
    expect(after).not.toBeNull();
    const card = findTask(after!, 'backlog-with-lease card');
    expect(card.columnId).toBe(doneColumnId);
    expect(card.columnId).not.toBe(backlogColumnId);
    expect(card.columnId).not.toBe(todoColumnId);
    expect(card.columnId).not.toBe(runningColumnId);
    expect(card.columnId).not.toBe(reviewColumnId);
  });

  it('completes without --attachment (the evidence URL is optional) and records no fabricated attachment', async () => {
    const root = await tempProject();
    const board = managedBoardFixture();
    const runningColumnId = board.lifecycle!.columns.running;
    const doneColumnId = board.lifecycle!.columns.done;
    const taskId = 'task-preflight-no-attachment-1';
    const stamp = '2026-02-01T00:00:00.000Z';
    board.tasks = [
      {
        id: taskId,
        title: 'running-without-evidence card',
        columnId: runningColumnId,
        status: 'in_progress',
        priority: 'medium',
        order: 0,
        createdAt: stamp,
        updatedAt: stamp,
        description: 'card parked in running, lease and lastResult present',
        dueDate: '2099-12-31',
        labels: ['test'],
        assignee: 'test-agent',
        assignedAgent: 'test-agent',
        successCriteria: [
          {
            id: 'crit-preflight-no-attachment-1',
            description: 'trivial check',
            type: 'manual',
            status: 'passed',
            checkedBy: 'system',
          },
        ],
        assignment: {
          status: 'running',
          agentId: 'test-agent',
          name: 'Test Agent',
          leaseId: 'lease-no-attachment-1',
          claimedAt: stamp,
          heartbeatAt: stamp,
          leaseExpiresAt: '2099-12-31T00:00:00.000Z',
          lastResult: 'implemented feature Y, awaiting review',
        },
      } as KanbanTask,
    ];
    await writeBoard(root, board);

    // No --attachment flag. `validateReviewEvidence`/`validateDoneEvidence`
    // treat the evidence URL as OPTIONAL — they require a recorded
    // `assignment.lastResult` and reviewer action text, both of which are
    // present here. The preflight must mirror that: refusing the transition
    // would reject a card the live gate accepts, which is the drift
    // `preflightManagedTransition` exists to prevent. What must NOT happen is
    // the audit ledger gaining an attachment the operator never supplied.
    const result = await runKanban(
      root,
      `task done ${board.id} ${taskId} --note "ran and verified"`,
    );

    expect(result.message).toBeDefined();
    expect(result.message).toMatch(/completed/i);
    expect(result.message).not.toMatch(/needs? attention/);

    const after = await getBoard(root, board.id);
    expect(after).not.toBeNull();
    const card = findTask(after!, 'running-without-evidence card');
    expect(card.columnId).toBe(doneColumnId);
    expect(card.columnId).not.toBe(runningColumnId);
    const history = card.lifecycle?.history ?? [];
    expect(history.map((entry) => entry.to)).toEqual(expect.arrayContaining(['review', 'done']));
    expect(history.every((entry) => entry.attachment === undefined)).toBe(true);
  });
});
