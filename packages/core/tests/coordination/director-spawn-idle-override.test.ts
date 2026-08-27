/**
 * Verifies that `Director.spawn()` honors a per-subagent `idleTimeoutMs`
 * override, and falls back to the Director-wide default otherwise.
 *
 * Regression coverage for: subagents spawned without a follow-up assign_task
 * within the Director-wide default window would be auto-retired, even when
 * the caller passed a longer idleTimeoutMs in the SubagentConfig. The
 * Director now reads config.idleTimeoutMs before falling back to
 * this.subagentIdleTimeoutMs (director.ts:494-509).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Director } from '../../src/coordination/director.js';
import type { SubagentRunOutcome, TaskSpec } from '../../src/types/multi-agent.js';

type DirectorOpts = ConstructorParameters<typeof Director>[0];
const tick = () => new Promise((r) => setImmediate(r));

function makeDirector(directorWideIdleMs?: number): {
  d: Director;
  runner: ReturnType<typeof vi.fn>;
} {
  const runner = vi.fn(
    async (task: TaskSpec): Promise<SubagentRunOutcome> => ({
      result: `done:${task.description}`,
      iterations: 1,
      toolCalls: 1,
    }),
  );
  const opts: Partial<DirectorOpts> = {
    config: {
      coordinatorId: 'idle-override',
      doneCondition: { type: 'all_tasks_done' },
      maxConcurrent: 4,
    },
    runner,
    sessionId: 'sess_test',
    retireSubagentOnTaskComplete: false,
    ...(directorWideIdleMs !== undefined ? { subagentIdleTimeoutMs: directorWideIdleMs } : {}),
  };
  return { d: new Director(opts as DirectorOpts), runner };
}

describe('Director.spawn idleTimeoutMs override', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the per-subagent override when SubagentConfig.idleTimeoutMs is provided', async () => {
    // Director-wide default is the historical 30s; per-subagent override is 150ms.
    const { d } = makeDirector(30_000);

    const id = await d.spawn({ id: 'fast-retire', name: 'Fast', idleTimeoutMs: 150 });
    await tick();
    expect(d.status().subagents.find((s) => s.id === id)?.status).toBe('idle');

    // Advance past the per-subagent override (150ms) — subagent should retire.
    await new Promise((r) => setTimeout(r, 250));
    expect(d.status().subagents.find((s) => s.id === id)).toBeUndefined();
  });

  it('falls back to Director-wide subagentIdleTimeoutMs when override is absent', async () => {
    // Director-wide default of 200ms; no per-subagent override.
    const { d } = makeDirector(200);

    const id = await d.spawn({ id: 'default-retire', name: 'Default' });
    await tick();
    expect(d.status().subagents.find((s) => s.id === id)).toBeDefined();

    await new Promise((r) => setTimeout(r, 350));
    expect(d.status().subagents.find((s) => s.id === id)).toBeUndefined();
  });

  it('keeps the subagent alive across the gap to assign_task when per-subagent timeout is long', async () => {
    // Reproduces the original symptom: the leader takes a while between
    // spawn_subagent and assign_task. With a 1s per-subagent override, the
    // subagent must survive the 250ms gap that previously retired it.
    const { d } = makeDirector(30_000);

    const id = await d.spawn({ id: 'survivor', name: 'Survivor', idleTimeoutMs: 1_000 });
    await new Promise((r) => setTimeout(r, 250));

    // Subagent still present because the 1s per-subagent override is in effect.
    expect(d.status().subagents.find((s) => s.id === id)?.status).toBe('idle');

    // Now assign_task lands. The subagent is still alive, dispatch succeeds.
    const taskId = await d.assign({ id: 'late-task', description: 'finally', subagentId: id });
    const [result] = await d.awaitTasks([taskId]);
    expect(result).toBeDefined();
    if (!result) throw new Error(`Missing result for task ${taskId}`);
    expect(result.status).toBe('success');
    expect(result.result).toBe('done:finally');
  });

  it('ignores invalid per-subagent values and falls back to the Director default', async () => {
    const { d } = makeDirector(200);
    // Negative number is invalid; should fall back to the Director default (200ms).
    const id = await d.spawn({ id: 'bad-idle', name: 'Bad', idleTimeoutMs: -1 });
    await tick();
    expect(d.status().subagents.find((s) => s.id === id)).toBeDefined();
    await new Promise((r) => setTimeout(r, 350));
    expect(d.status().subagents.find((s) => s.id === id)).toBeUndefined();
  });
});
