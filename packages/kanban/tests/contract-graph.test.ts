import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateContractGraph, evaluateContractGraphReadiness } from '../src/contract-graph.js';
import { validateDefinitionOfDone } from '../src/manager/lifecycle.js';
import {
  addCheckToTask as addCheckToTaskDomain,
  addContractEdge as addContractEdgeDomain,
  addGoalMetricToTask as addGoalMetricToTaskDomain,
  addTask as addTaskDomain,
  configureContractGraph as configureContractGraphDomain,
  createBoard,
  duplicateBoard,
  evaluateTaskContractGraph,
  exportBoardAsMarkdown,
  getBoard,
  removeTask as removeTaskDomain,
  taskContractEndpoint,
  updateCheckOnTask as updateCheckOnTaskDomain,
  updateGoalMetricOnTask as updateGoalMetricOnTaskDomain,
  upsertContractNode as upsertContractNodeDomain,
} from './helpers/session-manager.js';

const EVENT_CONTEXT = {
  sessionId: '2026-08-26/sess_01TESTCONTRACTGRAPH00000000',
  actor: 'contract-graph-test',
};

function addTask(
  ...args: [string, string, Parameters<typeof addTaskDomain>[2]]
): ReturnType<typeof addTaskDomain> {
  return addTaskDomain(...args, EVENT_CONTEXT);
}

function addGoalMetricToTask(
  ...args: [string, string, string, Parameters<typeof addGoalMetricToTaskDomain>[3]]
): ReturnType<typeof addGoalMetricToTaskDomain> {
  return addGoalMetricToTaskDomain(...args, EVENT_CONTEXT);
}

function addCheckToTask(
  ...args: [string, string, string, Parameters<typeof addCheckToTaskDomain>[3]]
): ReturnType<typeof addCheckToTaskDomain> {
  return addCheckToTaskDomain(...args, EVENT_CONTEXT);
}

function configureContractGraph(
  ...args: [string, string, Parameters<typeof configureContractGraphDomain>[2]]
): ReturnType<typeof configureContractGraphDomain> {
  return configureContractGraphDomain(...args, EVENT_CONTEXT);
}

function upsertContractNode(
  ...args: [string, string, Parameters<typeof upsertContractNodeDomain>[2]]
): ReturnType<typeof upsertContractNodeDomain> {
  return upsertContractNodeDomain(...args, EVENT_CONTEXT);
}

function addContractEdge(
  ...args: [string, string, Parameters<typeof addContractEdgeDomain>[2]]
): ReturnType<typeof addContractEdgeDomain> {
  return addContractEdgeDomain(...args, EVENT_CONTEXT);
}

function updateGoalMetricOnTask(
  ...args: [string, string, string, string, Parameters<typeof updateGoalMetricOnTaskDomain>[4]]
): ReturnType<typeof updateGoalMetricOnTaskDomain> {
  return updateGoalMetricOnTaskDomain(...args, EVENT_CONTEXT);
}

function updateCheckOnTask(
  ...args: [string, string, string, string, Parameters<typeof updateCheckOnTaskDomain>[4]]
): ReturnType<typeof updateCheckOnTaskDomain> {
  return updateCheckOnTaskDomain(...args, EVENT_CONTEXT);
}

function removeTask(...args: [string, string, string]): ReturnType<typeof removeTaskDomain> {
  return removeTaskDomain(...args, EVENT_CONTEXT);
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-contract-graph-'));
});

async function taskWithEvidence() {
  const board = await createBoard(tmpDir, { title: 'Autonomous work' });
  const added = await addTask(tmpDir, board.id, {
    title: 'Reduce startup latency',
    description: 'Improve startup without increasing memory.',
  });
  const taskId = added!.task.id;
  await addGoalMetricToTask(tmpDir, board.id, taskId, {
    name: 'Startup p95',
    target: 1000,
    unit: 'ms',
  });
  await addCheckToTask(tmpDir, board.id, taskId, {
    description: 'RSS grows by no more than five percent',
    type: 'manual',
  });
  const current = (await getBoard(tmpDir, board.id))!;
  const task = current.tasks.find((candidate) => candidate.id === taskId)!;
  return {
    boardId: board.id,
    taskId,
    metricId: task.goalMetrics![0]!.id,
    checkId: task.successCriteria![0]!.id,
  };
}

describe('Kanban contract graph', () => {
  it('keeps every Contract Map mode off the implementation start path', async () => {
    const columns = [
      { id: 'backlog', title: 'Backlog', order: 0 },
      { id: 'todo', title: 'Todo', order: 1 },
      { id: 'in-progress', title: 'Running', order: 2 },
      { id: 'review', title: 'Review', order: 3 },
      { id: 'done', title: 'Done', order: 4 },
    ];
    const board = await createBoard(tmpDir, {
      title: 'Governed implementation',
      columns,
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
    const added = await addTask(tmpDir, board.id, {
      title: 'Safe parser change',
      description: 'Add syntax without changing existing parse behavior.',
      assignedAgent: 'agent-1',
      dueDate: '2026-08-10T00:00:00.000Z',
      labels: ['parser'],
    });
    const taskId = added!.task.id;
    const missing = evaluateContractGraphReadiness((await getBoard(tmpDir, board.id))!, taskId);
    expect(missing.ready).toBe(false);
    expect(missing.issues.map((issue) => issue.code)).toEqual(['success-criteria-missing']);
    expect(missing.issues[0]).toMatchObject({ field: 'successCriteria' });

    await addGoalMetricToTask(tmpDir, board.id, taskId, {
      name: 'New syntax parses',
      target: 'pass',
    });
    await addCheckToTask(tmpDir, board.id, taskId, {
      description: 'Parser regression suite passes',
      type: 'test',
    });

    const withoutGraph = evaluateContractGraphReadiness(
      (await getBoard(tmpDir, board.id))!,
      taskId,
    );
    expect(withoutGraph).toEqual({ taskId, ready: true, issues: [] });

    await configureContractGraph(tmpDir, board.id, 'advisory');
    const advisory = evaluateContractGraphReadiness((await getBoard(tmpDir, board.id))!, taskId);
    expect(advisory).toEqual({ taskId, ready: true, issues: [] });

    await configureContractGraph(tmpDir, board.id, 'strict');
    const strictMissing = evaluateContractGraphReadiness(
      (await getBoard(tmpDir, board.id))!,
      taskId,
    );
    expect(strictMissing).toEqual({ taskId, ready: true, issues: [] });
    expect(evaluateContractGraph((await getBoard(tmpDir, board.id))!, taskId)).toMatchObject({
      allowed: false,
      enforcement: 'strict',
    });

    const detailed = (await getBoard(tmpDir, board.id))!;
    const task = detailed.tasks.find((candidate) => candidate.id === taskId)!;
    const metricId = task.goalMetrics![0]!.id;
    const checkId = task.successCriteria![0]!.id;
    await upsertContractNode(tmpDir, board.id, {
      taskId,
      kind: 'objective',
      title: 'Support the new syntax',
      metricId,
    });
    await upsertContractNode(tmpDir, board.id, {
      taskId,
      kind: 'guardrail',
      title: 'Preserve existing syntax',
      checkId,
    });
    await upsertContractNode(tmpDir, board.id, {
      taskId,
      kind: 'risk',
      title: 'Ambiguous token precedence',
      enforcement: 'advisory',
    });
    await upsertContractNode(tmpDir, board.id, {
      taskId,
      kind: 'component',
      title: 'Parser package',
    });
    await upsertContractNode(tmpDir, board.id, {
      taskId,
      kind: 'verification',
      title: 'Parser regression suite',
      checkId,
      enforcement: 'advisory',
    });

    const ready = evaluateContractGraphReadiness((await getBoard(tmpDir, board.id))!, taskId);
    expect(ready).toEqual({ taskId, ready: true, issues: [] });
  });

  it('reports strict-map findings without holding card completion open', async () => {
    const board = await createBoard(tmpDir, { title: 'Operator audit map' });
    const added = await addTask(tmpDir, board.id, { title: 'Finish real work' });
    await addCheckToTask(tmpDir, board.id, added!.task.id, {
      description: 'Requested behavior is verified',
      type: 'test',
      status: 'passed',
    });
    await configureContractGraph(tmpDir, board.id, 'strict');
    const current = (await getBoard(tmpDir, board.id))!;
    const task = current.tasks.find((candidate) => candidate.id === added!.task.id)!;

    expect(evaluateContractGraph(current, task.id).allowed).toBe(false);
    expect(validateDefinitionOfDone(task, undefined, { board: current })).toEqual([]);
  });

  it('blocks strict completion until objective and guardrail evidence are satisfied', async () => {
    const { boardId, taskId, metricId, checkId } = await taskWithEvidence();
    await configureContractGraph(tmpDir, boardId, 'strict');
    const objective = await upsertContractNode(tmpDir, boardId, {
      taskId,
      kind: 'objective',
      title: 'Startup p95 under one second',
      metricId,
    });
    const guardrail = await upsertContractNode(tmpDir, boardId, {
      taskId,
      kind: 'guardrail',
      title: 'Memory stays within budget',
      checkId,
      baseline: 'current RSS',
      threshold: '+5%',
    });

    expect(objective?.board.contractGraph?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: taskContractEndpoint(taskId),
          to: objective?.node.id,
          type: 'targets',
        }),
      ]),
    );
    expect(guardrail?.node.enforcement).toBe('blocking');

    const pending = await evaluateTaskContractGraph(tmpDir, boardId, taskId);
    expect(pending?.evaluation.allowed).toBe(false);
    expect(pending?.evaluation.issues.some((issue) => issue.code === 'node-unresolved')).toBe(true);

    await updateGoalMetricOnTask(tmpDir, boardId, taskId, metricId, {
      status: 'met',
      current: 920,
    });
    await updateCheckOnTask(tmpDir, boardId, taskId, checkId, {
      status: 'passed',
      checkedBy: 'benchmark',
    });
    const passed = await evaluateTaskContractGraph(tmpDir, boardId, taskId);
    expect(passed?.evaluation).toMatchObject({ allowed: true, enforcement: 'strict', issues: [] });

    const task = passed!.board.tasks.find((candidate) => candidate.id === taskId)!;
    expect(validateDefinitionOfDone(task, undefined, { board: passed!.board })).toEqual([]);
    const markdown = exportBoardAsMarkdown(passed!.board);
    expect(markdown).toContain('## Contract Graph (strict)');
    expect(markdown).toContain('Memory stays within budget');
  });

  it('requires evidence links for unbound blocking outcomes', async () => {
    const board = await createBoard(tmpDir, { title: 'Evidence graph' });
    const added = await addTask(tmpDir, board.id, { title: 'Change parser' });
    await configureContractGraph(tmpDir, board.id, 'strict');
    const objective = await upsertContractNode(tmpDir, board.id, {
      taskId: added!.task.id,
      kind: 'objective',
      title: 'Parse new syntax',
      state: 'satisfied',
    });
    await upsertContractNode(tmpDir, board.id, {
      taskId: added!.task.id,
      kind: 'guardrail',
      title: 'Existing syntax remains stable',
      state: 'satisfied',
    });

    const missing = await evaluateTaskContractGraph(tmpDir, board.id, added!.task.id);
    expect(
      missing?.evaluation.issues.filter((issue) => issue.code === 'verification-missing'),
    ).toHaveLength(2);

    await addCheckToTask(tmpDir, board.id, added!.task.id, {
      description: 'Parser regression suite passes',
      type: 'manual',
      status: 'passed',
    });
    const withCheck = (await getBoard(tmpDir, board.id))!;
    const evidenceCheckId = withCheck.tasks[0]!.successCriteria![0]!.id;

    const verification = await upsertContractNode(tmpDir, board.id, {
      taskId: added!.task.id,
      kind: 'verification',
      title: 'Parser regression suite',
      state: 'satisfied',
      enforcement: 'advisory',
      checkId: evidenceCheckId,
    });
    await addContractEdge(tmpDir, board.id, {
      from: objective!.node.id,
      to: verification!.node.id,
      type: 'verified_by',
    });
    const partiallyLinked = await evaluateTaskContractGraph(tmpDir, board.id, added!.task.id);
    expect(
      partiallyLinked?.evaluation.issues.filter((issue) => issue.code === 'verification-missing'),
    ).toHaveLength(1);
  });

  it('keeps advisory findings visible without blocking completion', async () => {
    const board = await createBoard(tmpDir, { title: 'Advisory graph' });
    const added = await addTask(tmpDir, board.id, { title: 'Small docs fix' });
    await configureContractGraph(tmpDir, board.id, 'advisory');
    const evaluation = await evaluateTaskContractGraph(tmpDir, board.id, added!.task.id);
    expect(evaluation?.evaluation.allowed).toBe(true);
    expect(evaluation?.evaluation.issues.map((issue) => issue.code)).toEqual([
      'objective-missing',
      'guardrail-missing',
    ]);
  });

  it('cascades task deletion and remaps bindings when a board is duplicated', async () => {
    const { boardId, taskId, metricId, checkId } = await taskWithEvidence();
    await configureContractGraph(tmpDir, boardId, 'strict');
    await upsertContractNode(tmpDir, boardId, {
      taskId,
      kind: 'objective',
      title: 'Startup target',
      metricId,
    });
    await upsertContractNode(tmpDir, boardId, {
      taskId,
      kind: 'guardrail',
      title: 'Memory target',
      checkId,
    });

    const duplicated = await duplicateBoard(tmpDir, boardId);
    expect(duplicated?.contractGraph?.nodes).toHaveLength(2);
    const duplicatedTask = duplicated!.tasks[0]!;
    expect(
      duplicated?.contractGraph?.nodes.every((node) => node.taskId === duplicatedTask.id),
    ).toBe(true);
    expect(
      duplicated?.contractGraph?.nodes.find((node) => node.kind === 'objective')?.metricId,
    ).toBe(duplicatedTask.goalMetrics?.[0]?.id);
    expect(
      duplicated?.contractGraph?.nodes.find((node) => node.kind === 'guardrail')?.checkId,
    ).toBe(duplicatedTask.successCriteria?.[0]?.id);

    const removed = await removeTask(tmpDir, boardId, taskId);
    expect(removed?.contractGraph?.nodes).toEqual([]);
    expect(removed?.contractGraph?.edges).toEqual([]);
  });

  it('rejects self-authored empty waivers', async () => {
    const board = await createBoard(tmpDir, { title: 'Waivers' });
    const added = await addTask(tmpDir, board.id, { title: 'Risky change' });
    await expect(
      upsertContractNode(tmpDir, board.id, {
        taskId: added!.task.id,
        kind: 'guardrail',
        title: 'Do not regress security',
        state: 'waived',
      }),
    ).rejects.toThrow('requires actor, reason, and timestamp');
  });
});
