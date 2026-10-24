import { EventBus } from '@wrongstack/contracts/kernel';
import type {
  FleetConfig,
  SubagentConfig,
  TaskResult,
  TaskSpec,
} from '@wrongstack/contracts/types';
import {
  Director,
  type ExploreCompanion,
  FLEET_ROSTER,
  getSharedProjectMailbox,
  postSessionNote,
} from '@wrongstack/core/coordination';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostExploreCompanion } from '../../src/fleet/host-explore-companion.js';

vi.mock('@wrongstack/core/coordination', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/core/coordination')>()),
  getSharedProjectMailbox: vi.fn(() => ({ query: vi.fn(async () => []), ack: vi.fn() })),
  postSessionNote: vi.fn(),
}));

const instances: ExploreCompanion[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.stop();
  vi.useRealTimers();
  vi.clearAllMocks();
});
const flush = async () => {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
};

function harness(config?: FleetConfig['exploreCompanion']) {
  const events = new EventBus();
  const workers: Array<{ id: string; status: 'idle' | 'running' | 'stopped' | 'error' }> = [];
  const completed = new Set<(payload: { task: TaskSpec; result: TaskResult }) => void>();
  const spawn = vi.fn(async (cfg: SubagentConfig) => {
    workers.push({ id: cfg.id!, status: 'idle' });
    return cfg.id!;
  });
  const assign = vi.fn(async (_task: TaskSpec) => _task.id);
  const terminate = vi.fn(async (id: string) => {
    const idx = workers.findIndex((w) => w.id === id);
    if (idx >= 0) workers.splice(idx, 1);
  });
  let allowed = true;
  const companion = createHostExploreCompanion({
    events,
    sessionId: 'leader-session',
    mailboxProjectDir: '/mailbox',
    projectRoot: process.cwd(),
    roster: FLEET_ROSTER,
    config,
    scrub: (text) => text.replaceAll('fixture-secret', '[redacted]'),
    companionsAllowed: () => allowed,
    director: {
      status: () => ({ subagents: workers }),
      spawnCompanion: spawn,
      assignInternal: assign,
      terminate,
      on: (_event: string, handler: (payload: { task: TaskSpec; result: TaskResult }) => void) => {
        completed.add(handler);
        return () => {
          completed.delete(handler);
        };
      },
    } as unknown as Director,
  });
  if (companion) instances.push(companion);
  const emit = (path: string, name = 'edit') =>
    events.emit('tool.executed', {
      id: `${name}:${path}`,
      sessionId: 'leader-session',
      name,
      ok: true,
      durationMs: 1,
      input: { path },
    });
  const finish = (overrides: Partial<TaskResult> = {}, task = assign.mock.calls.at(-1)![0]) => {
    const result: TaskResult = {
      taskId: task.id,
      subagentId: task.subagentId!,
      status: 'success',
      result: 'src/a.ts:3 - entry point',
      iterations: 1,
      toolCalls: 1,
      durationMs: 5,
      ...overrides,
    };
    for (const handler of completed) handler({ task, result });
  };
  return {
    companion,
    emit,
    finish,
    spawn,
    assign,
    terminate,
    workers,
    completed,
    disable: () => {
      allowed = false;
    },
  };
}

describe('Explore Companion host lifecycle', () => {
  it('serializes discovery and delivers findings through a real Director completion', async () => {
    const events = new EventBus();
    const tasks: TaskSpec[] = [];
    const releases: Array<() => void> = [];
    const director = new Director({
      sessionId: 'explore-integration',
      config: {
        coordinatorId: 'explore-integration',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 1,
      },
      runner: async (task) => {
        tasks.push(task);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return { result: 'src/example.ts:1 - fixture entry point', iterations: 1, toolCalls: 0 };
      },
    });
    const companion = createHostExploreCompanion({
      director,
      events,
      sessionId: 'explore-integration',
      mailboxProjectDir: '/mailbox',
      roster: FLEET_ROSTER,
      config: { signals: { mailboxAsk: false } },
    })!;
    instances.push(companion);
    try {
      for (const path of ['src/a.ts', 'src/b.ts'])
        events.emit('tool.executed', {
          id: path,
          name: 'edit',
          durationMs: 1,
          ok: true,
          sessionId: 'explore-integration',
          input: { path },
        });
      await vi.waitFor(() => expect(tasks).toHaveLength(1));
      expect(companion.pendingCount()).toBe(1);
      expect(director.listPendingTasks()).toHaveLength(0);
      releases.shift()!();
      await vi.waitFor(() => expect(tasks).toHaveLength(2));
      expect(tasks[0]?.subagentId).toBe(tasks[1]?.subagentId);
      expect(postSessionNote).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'explore-integration',
          body: 'src/example.ts:1 - fixture entry point',
        }),
      );
      releases.shift()!();
      await vi.waitFor(() => expect(postSessionNote).toHaveBeenCalledTimes(2));
    } finally {
      companion.stop();
      for (const release of releases) release();
      await director.shutdown();
    }
  });

  it('is lazy; one task owns the flight slot until its matching completion', async () => {
    const h = harness();
    expect(h.spawn).not.toHaveBeenCalled();
    h.emit('src/a.ts');
    h.emit('src/b.ts');
    h.emit('src/c.ts');
    await flush();
    expect(h.assign).toHaveBeenCalledTimes(1);
    expect(h.companion?.pendingCount()).toBe(2);
    h.finish({ taskId: 'unrelated-task' });
    await flush();
    expect(h.assign).toHaveBeenCalledTimes(1);
    expect(postSessionNote).not.toHaveBeenCalled();
    h.finish();
    await flush();
    expect(h.assign).toHaveBeenCalledTimes(2);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(postSessionNote).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'leader-session',
        subject: '[explore] edit_unread_file: file:src/a.ts',
      }),
    );
  });

  it('forwards configured signal switches to the observer', async () => {
    const h = harness({ signals: { unfamiliarRead: false } });
    h.emit('src/a.ts', 'read');
    h.emit('./src/a.ts');
    await flush();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('enforces probe budgets on the resident and preserves session attribution', async () => {
    const h = harness({ maxToolCallsPerProbe: 12, probeTimeoutMs: 15_000 });
    h.emit('src/a.ts');
    await flush();
    expect(h.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        originSessionId: 'leader-session',
        timeoutMs: 15_000,
        maxToolCalls: 12,
        maxIterations: 12,
      }),
    );
  });

  it('deadline retires a stalled worker, suppresses its late result, and resumes the queue', async () => {
    vi.useFakeTimers();
    const h = harness({ probeTimeoutMs: 100 });
    h.emit('src/a.ts');
    h.emit('src/b.ts');
    await flush();
    const oldTask = h.assign.mock.calls[0]![0];
    await vi.advanceTimersByTimeAsync(101);
    await flush();
    expect(h.terminate).toHaveBeenCalledWith(oldTask.subagentId);
    expect(h.assign).toHaveBeenCalledTimes(2);
    expect(h.spawn.mock.calls[0]![0].id).not.toBe(h.spawn.mock.calls[1]![0].id);
    h.finish({}, oldTask);
    expect(postSessionNote).not.toHaveBeenCalled();
  });

  it('stop retires its resident and removes completion listeners without dispatching queued work', async () => {
    const h = harness();
    h.emit('src/a.ts');
    h.emit('src/b.ts');
    await flush();
    h.companion?.stop();
    await flush();
    h.finish();
    expect(h.completed.size).toBe(0);
    expect(h.terminate).toHaveBeenCalledTimes(1);
    expect(h.assign).toHaveBeenCalledTimes(1);
    expect(postSessionNote).not.toHaveBeenCalled();
  });

  it('stop while spawning fences assignment and cleans up the eventual spawn', async () => {
    const h = harness();
    let resolve!: (id: string) => void;
    h.spawn.mockImplementationOnce(
      () =>
        new Promise((finish) => {
          resolve = finish;
        }),
    );
    h.emit('src/a.ts');
    await flush();
    h.companion?.stop();
    resolve('late-worker');
    await flush();
    expect(h.assign).not.toHaveBeenCalled();
    expect(h.terminate).toHaveBeenCalledWith('late-worker');
  });

  it('a hung spawn times out and its late incarnation cannot replace the next resident', async () => {
    vi.useFakeTimers();
    const h = harness({ probeTimeoutMs: 100 });
    let resolve!: (id: string) => void;
    h.spawn.mockImplementationOnce(
      () =>
        new Promise((finish) => {
          resolve = finish;
        }),
    );
    h.emit('src/a.ts');
    h.emit('src/b.ts');
    await flush();
    await vi.advanceTimersByTimeAsync(101);
    await flush();
    expect(h.assign).toHaveBeenCalledTimes(1);
    resolve('late-worker');
    await flush();
    expect(h.terminate).toHaveBeenCalledWith('late-worker');
    h.finish();
    await flush();
    h.emit('src/c.ts');
    await flush();
    expect(h.spawn).toHaveBeenCalledTimes(2);
  });

  it('assignment rejection releases the queue and retires the failed resident', async () => {
    const h = harness();
    h.assign.mockRejectedValueOnce(new Error('fixture rejection'));
    h.emit('src/a.ts');
    h.emit('src/b.ts');
    await flush();
    expect(h.assign).toHaveBeenCalledTimes(2);
    expect(h.terminate).toHaveBeenCalledTimes(1);
  });

  it('failed tasks release the queue without publishing invented findings', async () => {
    const h = harness();
    h.emit('src/a.ts');
    h.emit('src/b.ts');
    await flush();
    h.finish({ status: 'failed' });
    await flush();
    expect(h.assign).toHaveBeenCalledTimes(2);
    expect(postSessionNote).not.toHaveBeenCalled();
  });

  it('policy disable during spawn prevents assignment', async () => {
    const h = harness();
    let resolve!: (id: string) => void;
    h.spawn.mockImplementationOnce(
      () =>
        new Promise((finish) => {
          resolve = finish;
        }),
    );
    h.emit('src/a.ts');
    await flush();
    h.disable();
    resolve('late-worker');
    await flush();
    expect(h.assign).not.toHaveBeenCalled();
    expect(h.terminate).toHaveBeenCalledWith('late-worker');
  });

  it('bounds and scrubs results; reports take precedence over fallback text', async () => {
    const h = harness({ maxFindingsChars: 160 });
    h.emit('src/a.ts');
    await flush();
    h.finish({
      result: 'wrong fallback',
      report: {
        summary: 'fixture-secret',
        findings: ['src/a.ts:1 - ' + 'x'.repeat(500)],
        files_examined: ['src/a.ts'],
        confidence: 0.9,
        suggested_next_steps: [],
      },
    });
    const note = vi.mocked(postSessionNote).mock.calls[0]![0];
    expect(note.body.length).toBeLessThanOrEqual(160);
    expect(note.body).toContain('[redacted]');
    expect(note.body).toContain('[Explore result truncated]');
    expect(note.body).not.toContain('wrong fallback');
  });

  it('falls back to result.result when report summary and findings are blank', async () => {
    const h = harness();
    h.emit('src/a.ts');
    await flush();
    h.finish({
      result: 'src/a.ts:10 — fallback finding from result text',
      report: {
        summary: '   ',
        findings: [' '],
        files_examined: ['src/a.ts'],
        confidence: 0.5,
        suggested_next_steps: [],
      },
    });
    const note = vi.mocked(postSessionNote).mock.calls[0]![0];
    expect(note.body).toBe('src/a.ts:10 — fallback finding from result text');
  });

  it('disabled feature does not even open the mailbox', () => {
    const h = harness({ enabled: false });
    expect(h.companion).toBeNull();
    expect(getSharedProjectMailbox).not.toHaveBeenCalled();
  });

  it('clears queued probes on terminateSession without spawning a replacement resident', async () => {
    const events = new EventBus();
    const tasks: TaskSpec[] = [];
    const releases: Array<() => void> = [];
    let spawnCalls = 0;
    const director = new Director({
      sessionId: 'explore-stop',
      config: {
        coordinatorId: 'explore-stop',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 1,
      },
      runner: async (task) => {
        tasks.push(task);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return { result: 'src/a.ts:1 - ok', iterations: 1, toolCalls: 0 };
      },
    });
    const origSpawn = director.spawnCompanion.bind(director);
    vi.spyOn(director, 'spawnCompanion').mockImplementation(async (cfg) => {
      spawnCalls += 1;
      return origSpawn(cfg);
    });
    const companion = createHostExploreCompanion({
      director,
      events,
      sessionId: 'explore-stop',
      mailboxProjectDir: '/mailbox',
      roster: FLEET_ROSTER,
      config: { signals: { mailboxAsk: false } },
    })!;
    instances.push(companion);
    try {
      events.emit('tool.executed', {
        id: '1',
        name: 'edit',
        durationMs: 1,
        ok: true,
        sessionId: 'explore-stop',
        input: { path: 'src/first.ts' },
      });
      events.emit('tool.executed', {
        id: '2',
        name: 'edit',
        durationMs: 1,
        ok: true,
        sessionId: 'explore-stop',
        input: { path: 'src/second.ts' },
      });
      await vi.waitFor(() => expect(tasks).toHaveLength(1));
      expect(spawnCalls).toBe(1);

      await director.terminateSession('explore-stop');
      releases.shift()?.();
      await flush();

      // Queued second probe was dropped on terminateSession — no second spawn or task.
      expect(tasks).toHaveLength(1);
      expect(spawnCalls).toBe(1);
    } finally {
      await director.shutdown();
    }
  });
});
