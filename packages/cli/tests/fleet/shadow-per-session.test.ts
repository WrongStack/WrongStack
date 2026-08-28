/**
 * The shadow reviewer belongs to ONE conversation.
 *
 * `HostShadowManager` used to hold flat fields, which is right for a CLI or a
 * TUI and wrong for the WebUI's four tabs on one process: the depth counter
 * mixed every tab's work, the "problem" text merged unrelated failures, and
 * the spawn named no owner so the reviewer landed in the boot tab's roster.
 */
import { EventBus } from '@wrongstack/core/kernel';
import type { ConfigStore, SessionWriter, SubagentConfig } from '@wrongstack/core/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { HostShadowManager } from '../../src/fleet/host-shadow-manager.js';
import type { MultiAgentDeps, MultiAgentHostOptions } from '../../src/fleet/host-types.js';

const HOST_SESSION = 'boot-session';
const TAB_A = 'tab-a';
const TAB_B = 'tab-b';

interface Harness {
  manager: HostShadowManager;
  events: EventBus;
  spawns: Array<{ config: SubagentConfig; description: string }>;
  opts: MultiAgentHostOptions;
  started: string[];
  stopped: string[];
  /** Subagent ids the fake coordinator reports as still running. */
  active: Set<string>;
}

function makeHarness(): Harness {
  const events = new EventBus();
  const spawns: Harness['spawns'] = [];
  const started: string[] = [];
  const stopped: string[] = [];
  const active = new Set<string>();
  let spawnSeq = 0;

  const deps = {
    events,
    session: { id: HOST_SESSION } as unknown as SessionWriter,
    configStore: {
      get: () => ({ provider: 'mock', model: 'test-model' }),
    } as unknown as ConfigStore,
  } as unknown as MultiAgentDeps;

  const opts: MultiAgentHostOptions = {
    onShadowAgentStarted: (id: string) => started.push(id),
    onShadowAgentStopped: (id: string) => stopped.push(id),
  } as MultiAgentHostOptions;

  const manager = new HostShadowManager({
    deps,
    opts,
    getDirector: () =>
      ({
        isWorkComplete: () => false,
        coordinator: {
          getStatus: () => ({
            subagents: [...active].map((id) => ({ id, status: 'running' })),
          }),
          stop: async () => undefined,
        },
      }) as never,
    spawnAndAssign: async (config, description) => {
      spawnSeq += 1;
      const subagentId = `shadow-${spawnSeq}`;
      const taskId = `task-${spawnSeq}`;
      spawns.push({ config, description });
      // Mirror the real host: an internal shadow spawn records the agent
      // against the conversation the config names.
      manager.markShadowTask(taskId, config.originSessionId);
      manager.recordShadowAgent(subagentId, taskId, 30_000, config.originSessionId);
      active.add(subagentId);
      return { subagentId, taskId };
    },
  });

  manager.armIfNeeded();
  return { manager, events, spawns, opts, started, stopped, active };
}

/** One task start/finish pair for a conversation. */
function emitTask(
  events: EventBus,
  sessionId: string | undefined,
  status: 'success' | 'failed',
  subagentId = 'w1',
): void {
  events.emit('subagent.task_started', { sessionId, subagentId, taskId: `${subagentId}-t` });
  events.emit('subagent.task_completed', {
    sessionId,
    subagentId,
    taskId: `${subagentId}-t`,
    status,
    iterations: 1,
    toolCalls: 0,
    durationMs: 5,
  });
}

/** Let the `queueMicrotask` in `requestShadowPass` run. */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('HostShadowManager keeps one review per conversation', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('spawns the reviewer under the conversation whose work failed', async () => {
    emitTask(h.events, TAB_B, 'failed');
    await flush();

    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]?.config.originSessionId).toBe(TAB_B);
  });

  it("another tab's in-flight work does not hold back the review", async () => {
    // Tab A starts something long and never finishes it.
    h.events.emit('subagent.task_started', { sessionId: TAB_A, subagentId: 'a1', taskId: 'a1-t' });
    // Tab B fails. Flat depth counting saw "1 thing still running" and parked
    // the review indefinitely behind an unrelated tab.
    emitTask(h.events, TAB_B, 'failed', 'b1');
    await flush();

    expect(h.spawns.map((s) => s.config.originSessionId)).toEqual([TAB_B]);
  });

  it('never hands one tab the other tab’s failure text', async () => {
    emitTask(h.events, TAB_A, 'failed', 'a1');
    emitTask(h.events, TAB_B, 'failed', 'b1');
    await flush();

    const bySession = new Map(
      h.spawns.map((s) => [s.config.originSessionId, s.description] as const),
    );
    expect([...bySession.keys()].sort()).toEqual([TAB_A, TAB_B]);
    expect(bySession.get(TAB_A)).toContain('a1');
    expect(bySession.get(TAB_A)).not.toContain('b1');
    expect(bySession.get(TAB_B)).toContain('b1');
    expect(bySession.get(TAB_B)).not.toContain('a1');
  });

  it('holds a live reviewer per conversation and clears only its own', async () => {
    emitTask(h.events, TAB_A, 'failed', 'a1');
    emitTask(h.events, TAB_B, 'failed', 'b1');
    await flush();

    const agentA = h.manager.getAgentId(TAB_A);
    const agentB = h.manager.getAgentId(TAB_B);
    expect(agentA).toBeTruthy();
    expect(agentB).toBeTruthy();
    expect(agentA).not.toBe(agentB);

    h.manager.clearShadowAgent(agentA!);
    expect(h.manager.getAgentId(TAB_A)).toBeNull();
    expect(h.manager.getAgentId(TAB_B)).toBe(agentB);
    expect(h.stopped).toEqual([agentA]);
  });

  it('will not start a second review for a conversation that already has one', async () => {
    emitTask(h.events, TAB_A, 'failed', 'a1');
    await flush();
    expect(h.spawns).toHaveLength(1);

    // The first reviewer is still running; a fresh failure is queued, not spawned.
    emitTask(h.events, TAB_A, 'failed', 'a2');
    await flush();
    expect(h.spawns).toHaveLength(1);

    // …and the other tab is not blocked by it.
    emitTask(h.events, TAB_B, 'failed', 'b1');
    await flush();
    expect(h.spawns.map((s) => s.config.originSessionId)).toEqual([TAB_A, TAB_B]);
  });

  it('treats an unstamped event as the host’s own session (CLI and TUI)', async () => {
    emitTask(h.events, undefined, 'failed');
    await flush();

    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]?.config.originSessionId).toBe(HOST_SESSION);
    expect(h.manager.getAgentId()).toBe(h.manager.getAgentId(HOST_SESSION));
  });

  it('forgets a conversation on release without touching the others', async () => {
    emitTask(h.events, TAB_A, 'failed', 'a1');
    emitTask(h.events, TAB_B, 'failed', 'b1');
    await flush();
    const agentB = h.manager.getAgentId(TAB_B);

    h.manager.releaseSession(TAB_A);

    expect(h.manager.getAgentId(TAB_A)).toBeNull();
    expect(h.manager.getAgentId(TAB_B)).toBe(agentB);
    expect([...h.manager.getTaskIds()].every((id) => h.manager.sessionForTask(id) === TAB_B)).toBe(
      true,
    );
  });

  it('routes a completed shadow task back to its own conversation', async () => {
    emitTask(h.events, TAB_A, 'failed', 'a1');
    emitTask(h.events, TAB_B, 'failed', 'b1');
    await flush();

    const taskA = h.manager.getTaskId(TAB_A)!;
    const agentA = h.manager.getAgentId(TAB_A)!;
    expect(h.manager.sessionForTask(taskA)).toBe(TAB_A);

    // The stop-after path retires the reviewer that owns the task, and only it.
    h.manager.addStopAfterTaskId(taskA);
    h.manager.onShadowTaskCompleted(taskA, agentA);
    await flush();

    expect(h.manager.getAgentId(TAB_A)).toBeNull();
    expect(h.manager.getAgentId(TAB_B)).not.toBeNull();
  });

  it('drops everything on dispose', async () => {
    emitTask(h.events, TAB_A, 'failed', 'a1');
    await flush();

    h.manager.dispose();

    expect(h.manager.getAgentId(TAB_A)).toBeNull();
    expect([...h.manager.getTaskIds()]).toEqual([]);
    // Listeners are gone: a fresh failure spawns nothing.
    const before = h.spawns.length;
    emitTask(h.events, TAB_A, 'failed', 'a3');
    await flush();
    expect(h.spawns).toHaveLength(before);
  });
});
