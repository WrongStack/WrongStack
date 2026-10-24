import { EventBus } from '@wrongstack/contracts/kernel';
import type { TaskGraph } from '@wrongstack/contracts/types';
import { ObservableBrainArbiter } from '@wrongstack/core/coordination';
import { TaskGraphStore } from '@wrongstack/sdd';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const startSddRun = vi.hoisted(() => vi.fn());
vi.mock('@wrongstack/sdd', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/sdd')>()),
  startSddRun,
}));

import { buildSddWizardDeps, startSddRunFromGraph } from '../src/server/sdd-wizard-wiring.js';

beforeEach(() => startSddRun.mockReset());

describe('WebUI SDD failure supervisor session ownership', () => {
  it.each([false, true])(
    'keeps a tab-3 decision addressed to tab 3 after tab 1 takes focus (splitter=%s)',
    async (withSplitter) => {
      startSddRun.mockReturnValue({ runId: 'run-3', completion: Promise.resolve({}) });
      const events = new EventBus();
      const emitted: Array<{ event: string; sessionId: unknown }> = [];
      const off = events.onPattern('brain.*', (event, payload) => {
        emitted.push({ event, sessionId: (payload as { sessionId?: string }).sessionId });
      });
      const agent = { ctx: { session: { id: 'tab-3' } } };
      const brain = new ObservableBrainArbiter(
        { decide: async () => ({ type: 'answer', optionId: 'retry', text: 'Retry task 3' }) },
        events,
      );

      try {
        await startSddRunFromGraph(
          { id: 'graph-3', nodes: new Map() } as TaskGraph,
          {
            agent: agent as never,
            events,
            projectRoot: '.',
            subagentFactory: vi.fn() as never,
            brain,
            projectSddBoards: '.temp_files/boards',
            ...(withSplitter ? { runIsolatedTurn: async () => '' } : {}),
          },
          { sessionId: 'tab-3', worktrees: false },
          {} as never,
        );
        agent.ctx.session.id = 'tab-1';
        const runOptions = startSddRun.mock.calls[0]?.[0] as {
          sessionId?: string | (() => string | undefined);
          superviseFailure?: (input: {
            task: { id: string; title: string };
            error: string;
            attempts: number;
          }) => Promise<unknown>;
        };
        expect(runOptions.sessionId).toBe('tab-3');
        await runOptions.superviseFailure?.({
          task: { id: 'task-3', title: 'Failed task' },
          error: 'failed',
          attempts: 1,
        });
        expect(emitted).toEqual([
          { event: 'brain.decision_requested', sessionId: 'tab-3' },
          { event: 'brain.decision_answered', sessionId: 'tab-3' },
        ]);
      } finally {
        off();
      }
    },
  );

  it('forwards the initiating session through the project graph launcher', async () => {
    startSddRun.mockReturnValue({ runId: 'run-3', completion: Promise.resolve({}) });
    const graph = { id: 'graph-3', nodes: new Map() } as TaskGraph;
    const load = vi.spyOn(TaskGraphStore.prototype, 'load').mockResolvedValue(graph);
    const events = new EventBus();
    const brain = new ObservableBrainArbiter(
      { decide: async () => ({ type: 'answer', optionId: 'retry', text: 'Retry' }) },
      events,
    );
    const paths = {
      projectDir: '.temp_files/sdd-owner-test',
      projectSpecs: '.temp_files/sdd-owner-test/specs',
      projectTaskGraphs: '.temp_files/sdd-owner-test/graphs',
      projectSddBoards: '.temp_files/sdd-owner-test/boards',
    };
    const deps = buildSddWizardDeps({
      agent: { ctx: { session: { id: 'tab-1' } } } as never,
      events,
      projectRoot: paths.projectDir,
      subagentFactory: vi.fn() as never,
      brain,
      paths,
    });

    try {
      await deps.startRunFromGraphId?.('graph-3', { sessionId: 'tab-3', worktrees: false });
      expect(startSddRun.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'tab-3' });
      const superviseFailure = startSddRun.mock.calls[0]?.[0]?.superviseFailure as
        | ((input: {
            task: { id: string; title: string };
            error: string;
            attempts: number;
          }) => Promise<unknown>)
        | undefined;
      const emitted: Array<{ event: string; sessionId: unknown }> = [];
      const off = events.onPattern('brain.*', (event, payload) => {
        emitted.push({ event, sessionId: (payload as { sessionId?: string }).sessionId });
      });
      try {
        await superviseFailure?.({
          task: { id: 'task-3', title: 'Failed task' },
          error: 'failed',
          attempts: 1,
        });
        expect(emitted.map(({ sessionId }) => sessionId)).toEqual(['tab-3', 'tab-3']);
      } finally {
        off();
      }
    } finally {
      load.mockRestore();
      await deps.ensureReady?.();
    }
  });
});
