import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import { PhaseStore } from '@wrongstack/goal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';
import { createGoalHost, type GoalHostDeps } from '../src/goal-host.js';

const PLAN = [
  {
    name: 'Phase A',
    description: 'do A',
    priority: 'high',
    estimateHours: 1,
    parallelizable: false,
    tasks: [
      { title: 'task one', description: '', type: 'feature', priority: 'high', estimateHours: 1 },
    ],
  },
];

function fakeHost(taskGate: Promise<void>): GoalHostDeps['multiAgentHost'] {
  const factory = async () => ({
    agent: {
      run: async (prompt: string) => {
        if (prompt.includes('You are executing one task')) {
          await taskGate;
          return { status: 'done', finalText: 'did the task' };
        }
        return { status: 'done', finalText: JSON.stringify(PLAN) };
      },
    },
    dispose: async () => {},
  });
  return { makeSubagentFactory: () => factory } as never as GoalHostDeps['multiAgentHost'];
}

async function waitForRunLeaseRelease(storeDir: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const locked = await fs
        .access(path.join(storeDir, '.active-run.lock'))
        .then(() => true)
        .catch(() => false);
      expect(locked).toBe(false);
    },
    { timeout: 30_000 },
  );
}

// Regression: `/goal pause|resume|stop` wrote `graph.runState` unconditionally.
// One landing after the orchestrator reported completion — while the host was
// still finalizing the run — overwrote 'completed', and finalize then persisted
// the finished Goal as paused/running/stopped.
describe('createGoalHost run state after completion', () => {
  let storeDir: string;
  let projectRoot: string;
  const prevVerify = process.env['WRONGSTACK_GOAL_VERIFY'];

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-run-state-store-'));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-run-state-root-'));
    process.env['WRONGSTACK_GOAL_VERIFY'] = '0';
  });

  afterEach(async () => {
    await waitForRunLeaseRelease(storeDir);
    if (prevVerify === undefined) delete process.env['WRONGSTACK_GOAL_VERIFY'];
    else process.env['WRONGSTACK_GOAL_VERIFY'] = prevVerify;
    const rmOpts = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
    await removeProjectFixtureDirectory(storeDir, rmOpts);
    await removeProjectFixtureDirectory(projectRoot, rmOpts);
  });

  it.each([
    ['pause', 'onGoalPause'],
    ['resume', 'onGoalResume'],
    ['stop', 'onGoalStop'],
  ] as const)(
    'a %s that lands while the run finalizes keeps it completed',
    async (_label, command) => {
      let release!: () => void;
      const taskGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const events = new EventBus();
      const host = createGoalHost({
        multiAgentHost: fakeHost(taskGate),
        getConfig: () => ({}) as never,
        events,
        storeDir,
        projectRoot,
        worktrees: false,
      });

      const result = await host.onGoalStart({ goal: 'finish then get poked' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Registered after the host's own completion listener, so it runs right
      // after the host marked the graph completed and before finalize persists.
      const poked = new Promise<void>((resolve) => {
        (events as unknown as { on(e: string, h: () => void): void }).on('graph.completed', () => {
          host[command]();
          resolve();
        });
      });
      release();
      await poked;
      await waitForRunLeaseRelease(storeDir);

      expect(result.graph.runState).toBe('completed');
      const saved = await new PhaseStore({ baseDir: storeDir }).load(result.graph.id);
      expect(saved?.runState).toBe('completed');
    },
  );
});
