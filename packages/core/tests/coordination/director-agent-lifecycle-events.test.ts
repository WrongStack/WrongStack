/**
 * agent_spawned / agent_stopped / agent_error are declared in the SessionEvent
 * union and rendered by the TUI replay timeline. agent_stopped and agent_error
 * had no producer at all, so a resumed session replayed every subagent starting
 * and none of them finishing — a crash looked exactly like a run still going.
 */
import { describe, expect, it, vi } from 'vitest';
import { Director } from '../../src/coordination/director.js';
import type {
  SubagentRunContext,
  SubagentRunOutcome,
  TaskSpec,
} from '../../src/types/multi-agent.js';
import type { SessionEvent } from '../../src/types/session.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

function makeDirector(opts: {
  appended: SessionEvent[];
  runner?: (task: TaskSpec, ctx: SubagentRunContext) => Promise<SubagentRunOutcome>;
}): Director {
  return new Director({
    sessionId: TEST_SESSION_ID,
    config: {
      coordinatorId: 'agent-lifecycle-test',
      doneCondition: { type: 'all_tasks_done' },
      maxConcurrent: 1,
    },
    sessionWriter: {
      append: async (ev: SessionEvent) => {
        opts.appended.push(ev);
      },
    } as never,
    runner: opts.runner ?? (async () => ({ result: 'done', iterations: 1, toolCalls: 0 })),
  });
}

const typesOf = (events: SessionEvent[]) => events.map((e) => e.type);

describe('Director subagent lifecycle session events', () => {
  it('writes agent_stopped when a subagent is removed', async () => {
    const appended: SessionEvent[] = [];
    const director = makeDirector({ appended });

    await director.spawn({ id: 'worker-1', name: 'Worker 1' });
    await director.remove('worker-1');
    await vi.waitFor(() => expect(typesOf(appended)).toContain('agent_stopped'));

    const stopped = appended.find((e) => e.type === 'agent_stopped') as
      | { agentId: string; ts: string }
      | undefined;
    expect(stopped?.agentId).toBe('worker-1');
    expect(stopped?.ts).toBeTruthy();
  });

  it('writes agent_error against the subagent when its task fails', async () => {
    const appended: SessionEvent[] = [];
    const director = makeDirector({
      appended,
      runner: async () => {
        throw new Error('subagent blew up');
      },
    });

    await director.spawn({ id: 'doomed', name: 'Doomed' });
    await director.assign({ id: 't1', description: 'a task that fails', subagentId: 'doomed' });
    await vi.waitFor(() => expect(typesOf(appended)).toContain('agent_error'));

    const err = appended.find((e) => e.type === 'agent_error') as
      | { agentId: string; error: string }
      | undefined;
    // task_failed pins the failure to the task; agent_error pins it to the agent.
    expect(err?.agentId).toBe('doomed');
    expect(err?.error).toContain('blew up');
    expect(typesOf(appended)).toContain('task_failed');
  });

  it('pairs every agent_spawned with an agent_stopped', async () => {
    const appended: SessionEvent[] = [];
    const director = makeDirector({ appended });

    await director.spawn({ id: 'w1', name: 'W1' });
    await director.spawn({ id: 'w2', name: 'W2' });
    await director.remove('w1');
    await director.remove('w2');

    await vi.waitFor(() => {
      const spawned = appended.filter((e) => e.type === 'agent_spawned');
      const stopped = appended.filter((e) => e.type === 'agent_stopped');
      expect(stopped).toHaveLength(spawned.length);
    });
  });
});
