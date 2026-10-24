import { afterEach, expect, it, vi } from 'vitest';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';
import { PhaseOrchestrator } from '../src/phase-orchestrator.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function graph() {
  return new PhaseGraphBuilder({
    title: 'Ownership',
    phases: [
      {
        name: 'Build',
        description: '',
        priority: 'high',
        estimateHours: 1,
        parallelizable: false,
        taskTemplates: [
          { title: 'Build', description: '', type: 'chore', priority: 'high', estimateHours: 1 },
        ],
      },
    ],
  }).build();
}
afterEach(() => vi.useRealTimers());
for (const rejects of [false, true]) {
  it(`retains timed-out ownership beyond grace until the worker ${rejects ? 'rejects' : 'resolves'}`, async () => {
    vi.useFakeTimers();
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    let settled = false;
    const orchestrator = new PhaseOrchestrator({
      graph: await graph(),
      maxRetries: 1,
      taskTimeoutMs: 10,
      ctx: {
        executeTask: async () => {
          calls++;
          if (calls === 1) {
            entered.resolve();
            await release.promise;
            if (rejects) throw new Error('settled cancellation');
          }
        },
      },
    });
    const run = orchestrator.start().then(() => {
      settled = true;
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(5_010);
    expect(calls).toBe(1);
    expect(settled).toBe(false);
    await expect(orchestrator.start()).rejects.toThrow('unfinished workers');
    release.resolve();
    await run;
    expect(calls).toBe(2);
    expect(settled).toBe(true);
  });
}
it('keeps stop pending until the worker settles without merging or starting another task', async () => {
  vi.useFakeTimers();
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  let settled = false;
  const saved = await graph();
  const orchestrator = new PhaseOrchestrator({
    graph: saved,
    maxRetries: 1,
    taskTimeoutMs: 10,
    ctx: {
      executeTask: async () => {
        calls++;
        entered.resolve();
        await release.promise;
      },
    },
  });
  const run = orchestrator.start().then(() => {
    settled = true;
  });
  await entered.promise;
  await vi.advanceTimersByTimeAsync(5_010);
  orchestrator.stop();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(calls).toBe(1);
  expect(settled).toBe(false);
  release.resolve();
  await run;
  expect(saved.completedAt).toBeUndefined();
  expect([...saved.phases.values()][0]!.status).toBe('paused');
});
