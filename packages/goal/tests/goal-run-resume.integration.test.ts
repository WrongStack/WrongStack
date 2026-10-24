import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { prepareGoalGraphForResume } from '../src/goal-run-lifecycle.js';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';
import { PhaseOrchestrator } from '../src/phase-orchestrator.js';
import { GoalRunLeaseBusyError, PhaseStore } from '../src/phase-store.js';
import { WorktreeManager } from '@wrongstack/core/worktree';

import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';

const git = promisify(execFile);

it('resumes stopped work in its original checkout and verifies the merged result', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-goal-resume-'));
  const store = new PhaseStore({ baseDir: path.join(projectRoot, '.wrongstack', 'autophase') });
  let releaseFirst: (() => Promise<void>) | undefined;
  let releaseSecond: (() => Promise<void>) | undefined;
  try {
    const gitRun = (args: string[], cwd = projectRoot) =>
      git('git', args, {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Goal Test',
          GIT_AUTHOR_EMAIL: 'goal@test.invalid',
          GIT_COMMITTER_NAME: 'Goal Test',
          GIT_COMMITTER_EMAIL: 'goal@test.invalid',
        },
      });
    await gitRun(['init', '-q']);
    await fs.writeFile(path.join(projectRoot, 'base.txt'), 'base\n');
    await gitRun(['add', '.']);
    await gitRun(['commit', '-q', '-m', 'base']);

    const graph = await new PhaseGraphBuilder({
      title: 'Resume across hosts',
      phases: [
        {
          name: 'Build',
          description: 'finish feature',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            {
              title: 'Feature',
              description: 'work',
              type: 'feature',
              priority: 'high',
              estimateHours: 1,
            },
          ],
        },
      ],
    }).build();
    graph.worktrees = true;
    releaseFirst = await store.acquireRunLease('first-host');
    const firstManager = new WorktreeManager({ projectRoot });
    let started!: (cwd: string) => void;
    const taskStarted = new Promise<string>((resolve) => {
      started = resolve;
    });
    const first = new PhaseOrchestrator({
      graph,
      worktrees: firstManager,
      ctx: {
        executeTask: async (_task, _phaseId, env, signal) => {
          const cwd = env?.cwd;
          if (!cwd) throw new Error('phase worktree missing');
          await fs.writeFile(path.join(cwd, 'feature.txt'), 'part one\n');
          started(cwd);
          await new Promise<void>((resolve) =>
            signal?.addEventListener('abort', () => resolve(), { once: true }),
          );
          throw new Error('stopped');
        },
      },
    });
    const firstRun = first.start();
    const originalCwd = await taskStarted;
    await expect(store.acquireRunLease('second-host')).rejects.toBeInstanceOf(
      GoalRunLeaseBusyError,
    );
    first.stop();
    await firstRun;
    await store.save(graph);
    await releaseFirst();
    releaseFirst = undefined;

    const restartedStore = new PhaseStore({ baseDir: store.baseDir });
    releaseSecond = await restartedStore.acquireRunLease('second-host');
    const loaded = await restartedStore.load(graph.id);
    expect(loaded).not.toBeNull();
    const phase = Array.from(loaded!.phases.values())[0]!;
    expect(phase.status).toBe('paused');
    expect(phase.metadata?.['worktreeResume']).toMatchObject({ dir: originalCwd });
    const secondManager = new WorktreeManager({ projectRoot });
    await prepareGoalGraphForResume(loaded!, secondManager);
    const resumedTask = vi.fn(
      async (
        _task: unknown,
        _phaseId: string,
        env?: { cwd?: string | undefined; branch?: string | undefined },
      ) => {
        expect(env?.cwd).toBe(originalCwd);
        expect(await fs.readFile(path.join(originalCwd, 'feature.txt'), 'utf8')).toBe('part one\n');
        await fs.appendFile(path.join(originalCwd, 'feature.txt'), 'part two\n');
      },
    );
    const second = new PhaseOrchestrator({
      graph: loaded!,
      worktrees: secondManager,
      ctx: {
        executeTask: resumedTask,
        verifyPhase: async (_phase, env) => ({
          ok: (await fs.readFile(path.join(env?.cwd ?? '', 'feature.txt'), 'utf8')).includes(
            'part two',
          ),
        }),
        verifyGoal: async () => {
          const output = await fs.readFile(path.join(projectRoot, 'feature.txt'), 'utf8');
          return { ok: output.replace(/\r\n/g, '\n') === 'part one\npart two\n', output };
        },
      },
    });
    await second.start();
    await restartedStore.save(loaded!);
    await releaseSecond();
    releaseSecond = undefined;

    expect(resumedTask).toHaveBeenCalledOnce();
    expect(
      loaded!.completedAt,
      JSON.stringify({
        status: phase.status,
        metadata: phase.metadata,
        failedPhaseIds: loaded!.failedPhaseIds,
        finalVerification: loaded!.finalVerification,
      }),
    ).toEqual(expect.any(Number));
    expect(loaded!.finalVerification?.status).toBe('passed');
    expect((await restartedStore.load(graph.id))?.completedAt).toEqual(expect.any(Number));
    expect(
      (await fs.readFile(path.join(projectRoot, 'feature.txt'), 'utf8')).replace(/\r\n/g, '\n'),
    ).toBe('part one\npart two\n');
  } finally {
    await releaseFirst?.();
    await releaseSecond?.();
    await removeProjectFixtureDirectory(projectRoot, { maxRetries: 5, retryDelay: 50 });
  }
}, 60_000);
