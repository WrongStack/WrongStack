import type { SubagentRunOutcome, TaskSpec } from '@wrongstack/contracts/types/multi-agent';
import { describe, expect, it } from 'vitest';
import { DefaultMultiAgentCoordinator } from '../src/multi-agent-coordinator.js';

/**
 * remove() deletes the entry so the id can be spawned again. A task still
 * running on the removed entry must not publish into that replacement:
 * the new worker stays on its own task, and a task queued behind it stays
 * queued until that task finishes.
 */
describe('coordinator replaced owner', () => {
  it('does not let a removed worker finish into the id that replaced it', async () => {
    const releases = new Map<string, (outcome: SubagentRunOutcome) => void>();
    const entered = new Map<string, Promise<void>>();
    const open: Array<() => void> = [];
    for (const id of ['task-old', 'task-new', 'task-extra']) {
      entered.set(
        id,
        new Promise<void>((resolve) => {
          open.push(resolve);
          releases.set(id, () => undefined);
        }),
      );
    }
    // The resolve registered above is the entry signal. Pair each id in order.
    const ids = ['task-old', 'task-new', 'task-extra'] as const;
    const signal = new Map<string, () => void>();
    for (let i = 0; i < ids.length; i++) signal.set(ids[i]!, open[i]!);

    const coord = new DefaultMultiAgentCoordinator(
      {
        coordinatorId: 'replaced-owner',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 4,
      },
      { sessionId: 'sess-replaced-owner' },
    );
    coord.setRunner(async (task: TaskSpec) => {
      signal.get(task.id)?.();
      return await new Promise<SubagentRunOutcome>((resolve) => {
        releases.set(task.id, resolve);
      });
    });

    await coord.spawn({ id: 'reused', name: 'Worker 1', originSessionId: 'sess-replaced-owner' });
    await coord.assign({ id: 'task-old', description: 'old owner', subagentId: 'reused' });
    await entered.get('task-old');
    await coord.remove('reused');
    await coord.spawn({ id: 'reused', name: 'Worker 1', originSessionId: 'sess-replaced-owner' });
    await coord.assign({ id: 'task-new', description: 'replacement', subagentId: 'reused' });
    await entered.get('task-new');
    await coord.assign({
      id: 'task-extra',
      description: 'must stay queued',
      subagentId: 'reused',
    });

    releases.get('task-old')?.({ result: 'stale', iterations: 0, toolCalls: 0 });
    await coord.awaitTasks(['task-old']);

    const worker = coord.getStatus().subagents.find((subagent) => subagent.id === 'reused');
    expect(worker).toMatchObject({ status: 'running', currentTask: 'task-new' });
    expect(coord.listPendingTasks().map((task) => task.id)).toEqual(['task-extra']);

    releases.get('task-new')?.({ result: 'new', iterations: 0, toolCalls: 0 });
    await coord.awaitTasks(['task-new']);
    await entered.get('task-extra');
    expect(coord.getStatus().subagents.find((subagent) => subagent.id === 'reused')).toMatchObject({
      status: 'running',
      currentTask: 'task-extra',
    });
    releases.get('task-extra')?.({ result: 'extra', iterations: 0, toolCalls: 0 });
    await coord.awaitTasks(['task-extra']);
  });
});
