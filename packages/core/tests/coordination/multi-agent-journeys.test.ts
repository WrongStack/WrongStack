import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Director } from '../../src/coordination/director.js';
import { makeQualityGateTool } from '../../src/coordination/director-tools.js';
import { SqliteMailbox } from '../../src/coordination/sqlite-mailbox.js';
import type {
  MultiAgentConfig,
  SubagentRunner,
  TaskResult,
  TaskSpec,
} from '../../src/types/multi-agent.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

const tempRoots: string[] = [];
const openStores: SqliteMailbox[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) await store.close().catch(() => undefined);
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })),
  );
});

describe('multi-agent outcome journeys', () => {
  it('spawns, assigns, awaits, and cleans up a completed worker', async () => {
    const director = makeDirector(async (task) => success(task, `delivered: ${task.description}`));

    const subagentId = await director.spawn({ name: 'implementer', role: 'implementer' });
    const taskId = await director.assign({
      id: 'journey-task',
      subagentId,
      description: 'add the visible account banner',
    });
    const [result] = await director.awaitTasks([taskId]);

    expect(result).toMatchObject({
      status: 'success',
      result: 'delivered: add the visible account banner',
    });
    await director.terminateAll();
    expect(director.status().subagents.every((agent) => agent.status !== 'running')).toBe(true);
  });

  it('repairs a failed quality gate and returns an accepted outcome', async () => {
    let gateAttempt = 0;
    const director = makeDirector(async (task) => {
      if (task.description.startsWith('Repair the implementation')) {
        return success(task, 'fixed the null guard and added its regression test');
      }
      const isVerifier = task.description.startsWith('Run the independent verification gate');
      if (isVerifier) gateAttempt++;
      const passed = gateAttempt > 1;
      if (isVerifier) {
        return success(
          task,
          passed
            ? '## Verdict\npass\n\n## Commands Run\npnpm test: ok'
            : '## Verdict\nfail\n\n## Failures\nnull-guard test failed',
        );
      }
      return success(
        task,
        passed
          ? '## Verdict\napprove\n\n## Must Fix\nnone'
          : '## Verdict\nrequest changes\n\n## Must Fix\nadd a null guard',
      );
    });
    const implementerId = await director.spawn({ name: 'implementer', role: 'implementer' });
    const gate = makeQualityGateTool(director, {
      reviewer: { name: 'reviewer', role: 'reviewer', worktree: 'off' },
      verifier: { name: 'verifier', role: 'verifier', worktree: 'off' },
    });

    const outcome = await gate.execute(
      {
        task: 'make account lookup null-safe',
        repairSubagentId: implementerId,
        maxRepairAttempts: 1,
        reviewerWorktree: 'off',
        verifierWorktree: 'off',
      },
      {} as never,
      {} as never,
    );

    expect(outcome).toMatchObject({
      verdict: 'pass',
      passed: true,
      repairAttemptsUsed: 1,
      nextAction: 'accept',
    });
    await director.terminateAll();
  });

  it('assembles collaborative bug, plan, and critic output into one report', async () => {
    let director: Director;
    director = makeDirector(async (task) => {
      const subagentId = task.subagentId ?? 'unknown';
      if (subagentId.includes('bug-hunter')) {
        director.fleet.emit({
          subagentId,
          taskId: task.id,
          ts: Date.now(),
          type: 'bug.found',
          payload: {
            finding: {
              id: 'bug-1',
              type: 'null-deref',
              severity: 'high',
              location: { file: 'src/account.ts', line: 42 },
              description: 'Account can be null before name access.',
            },
          },
        });
      } else if (subagentId.includes('refactor-planner')) {
        director.fleet.emit({
          subagentId,
          taskId: task.id,
          ts: Date.now(),
          type: 'refactor.plan',
          payload: {
            plan: {
              id: 'plan-1',
              basedOnBugIds: ['bug-1'],
              phases: [
                { number: 1, title: 'Guard lookup', tasks: ['add null check'], risk: 'low' },
              ],
              riskScore: 'low',
              estimatedChangeCount: 1,
              rollbackStrategy: 'revert the guard commit',
            },
          },
        });
      } else if (subagentId.includes('critic')) {
        director.fleet.emit({
          subagentId,
          taskId: task.id,
          ts: Date.now(),
          type: 'critic.evaluation',
          payload: {
            evaluation: {
              id: 'evaluation-1',
              subjectType: 'refactor_plan',
              subjectId: 'plan-1',
              score: 9,
              verdict: 'approve',
              strengths: ['small and testable'],
              weaknesses: [],
              concerns: [],
            },
          },
        });
      }
      return success(task, `completed ${subagentId}`);
    });

    const report = await director.spawnCollab({
      targetPaths: ['src/account.ts'],
      timeoutMs: 2_000,
    });

    expect(report).toMatchObject({
      overallVerdict: 'approve',
      disposition: 'completed',
      bugs: [{ id: 'bug-1', severity: 'high' }],
      refactorPlans: [{ id: 'plan-1' }],
      evaluations: [{ id: 'evaluation-1', verdict: 'approve' }],
    });
    expect(report.summary).toContain('Bugs Found');
    await director.terminateAll();
  });

  it('propagates a coordinated task result through the project mailbox', async () => {
    const root = await makeTempRoot();
    const mailbox = new SqliteMailbox(root);
    // SQLite holds the store open for the life of the connection; the shared
    // afterEach `fs.rm` hits EBUSY on Windows unless it is closed first.
    openStores.push(mailbox);
    const director = makeDirector(async (task) => {
      await mailbox.send({
        from: task.subagentId ?? 'worker',
        to: 'leader',
        type: 'result',
        subject: `Completed ${task.id}`,
        body: 'Account audit passed with no blocking findings.',
      });
      return success(task, 'mailbox result published');
    });
    const subagentId = await director.spawn({ name: 'auditor', role: 'reviewer' });
    const taskId = await director.assign({
      id: 'mailbox-task',
      subagentId,
      description: 'audit account access',
    });

    const [taskResult] = await director.awaitTasks([taskId]);
    const [message] = await mailbox.query({ to: 'leader', type: 'result' });

    expect(taskResult).toMatchObject({ status: 'success', result: 'mailbox result published' });
    expect(message).toMatchObject({
      from: subagentId,
      subject: 'Completed mailbox-task',
      body: 'Account audit passed with no blocking findings.',
    });
    await director.terminateAll();
  });
});

function makeDirector(runner: SubagentRunner): Director {
  return new Director({
    sessionId: TEST_SESSION_ID,
    config: makeConfig(),
    runner,
    maxSpawns: 16,
    maxSpawnDepth: 2,
    spawnDepth: 0,
    directorBudget: {
      maxCostUsd: Number.POSITIVE_INFINITY,
      maxTokens: Number.POSITIVE_INFINITY,
    },
  });
}

function makeConfig(): MultiAgentConfig {
  return {
    coordinatorId: 'journey-director',
    maxConcurrent: 4,
    doneCondition: { type: 'all_tasks_done' },
  };
}

function success(task: TaskSpec, result: string): TaskResult {
  return {
    taskId: task.id,
    subagentId: task.subagentId ?? 'unknown',
    status: 'success',
    result,
    iterations: 1,
    toolCalls: 0,
    durationMs: 1,
  };
}

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-multi-agent-journey-'));
  tempRoots.push(root);
  return root;
}
