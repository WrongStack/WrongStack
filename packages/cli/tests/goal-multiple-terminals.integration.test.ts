import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PhaseStore } from '@wrongstack/core/goal';
import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, expect, it, vi } from 'vitest';
import { deferred, goalGitFixture } from '../../core/tests/goal/helpers/goal-git-fixture.js';
import { createGoalHost } from '../src/goal-host.js';

// Measured under a loaded full-suite run: the squash-merge after a goal's phase
// completed took ~28s, just missing a 30s window. Two sequential waits use this,
// so the test timeout below must cover both with room to spare.
const GIT_SETTLE_MS = 60_000;

afterEach(() => vi.unstubAllEnvs());
it('two terminal goals run independently and integrate only into their own goal branches', async () => {
  vi.stubEnv('WRONGSTACK_GOAL_VERIFY', '0');
  const fixture = await goalGitFixture();
  const events = new EventBus();
  const firstEntered = deferred();
  const secondEntered = deferred();
  const firstRelease = deferred();
  const secondRelease = deferred();
  const factory = (
    entered: ReturnType<typeof deferred>,
    release: ReturnType<typeof deferred>,
    marker: string,
  ) => ({
    makeSubagentFactory: () => async (opts: { name: string; cwd?: string }) => ({
      agent: {
        run: async () => {
          if (opts.name === 'goal-planner')
            return {
              status: 'done',
              finalText: JSON.stringify([
                {
                  name: 'Build',
                  description: '',
                  priority: 'high',
                  estimateHours: 1,
                  parallelizable: false,
                  taskTemplates: [
                    {
                      title: marker,
                      description: '',
                      type: 'chore',
                      priority: 'high',
                      estimateHours: 1,
                    },
                  ],
                },
              ]),
            };
          expect(opts.cwd).toBeTruthy();
          await fs.writeFile(path.join(opts.cwd!, `${marker}.txt`), marker);
          entered.resolve();
          await release.promise;
          return { status: 'done', finalText: marker };
        },
      },
    }),
  });
  const first = createGoalHost({
    ...fixture,
    events,
    getConfig: () => ({}) as never,
    getSessionId: () => 'terminal-one',
    multiAgentHost: factory(firstEntered, firstRelease, 'first') as never,
  });
  const second = createGoalHost({
    ...fixture,
    events,
    getConfig: () => ({}) as never,
    getSessionId: () => 'terminal-two',
    multiAgentHost: factory(secondEntered, secondRelease, 'second') as never,
  });
  try {
    const [a, b] = await Promise.all([
      first.onGoalStart({ goal: 'First goal' }),
      second.onGoalStart({ goal: 'Second goal' }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('Goal did not start');
    await Promise.all([firstEntered.promise, secondEntered.promise]);
    expect(a.graph.id).not.toBe(b.graph.id);
    expect(a.graph.workspace?.dir).not.toBe(b.graph.workspace?.dir);
    const store = new PhaseStore({ baseDir: fixture.storeDir });
    expect((await store.listGoals()).map((goal) => goal.status)).toEqual(['running', 'running']);
    firstRelease.resolve();
    // The runner clears only after drainMerges() — real git commit, squash-merge
    // and worktree cleanup. Under a saturated release:check run those git
    // spawns stretched past 10s (phase completed, graph.completed not yet out).
    await vi.waitFor(() => expect(first.getGoalRunner()).toBeNull(), { timeout: GIT_SETTLE_MS });
    expect(second.getGoalRunner()).not.toBeNull();
    expect(await fs.readFile(path.join(a.graph.workspace!.dir, 'first.txt'), 'utf8')).toBe('first');
    secondRelease.resolve();
    await vi.waitFor(() => expect(second.getGoalRunner()).toBeNull(), { timeout: GIT_SETTLE_MS });
    expect(await fixture.git('rev-parse', 'HEAD')).toBe(fixture.baseline);
    expect(await fixture.git('status', '--porcelain')).toBe('');
    const summaries = await store.listGoals();
    expect(summaries.map((goal) => goal.status)).toEqual(['completed', 'completed']);
    expect(summaries.map((goal) => goal.percentComplete)).toEqual([100, 100]);
    expect(summaries.map((goal) => goal.reachability)).toEqual(['unknown', 'unknown']);
    expect(summaries.map((goal) => goal.sessionId).sort()).toEqual([
      'terminal-one',
      'terminal-two',
    ]);
  } finally {
    firstRelease.resolve();
    secondRelease.resolve();
    first.onGoalStop();
    second.onGoalStop();
    await vi.waitFor(() => expect(first.getGoalRunner() || second.getGoalRunner()).toBeNull(), {
      timeout: GIT_SETTLE_MS,
    });
    await fixture.dispose();
  }
}, 240_000);
