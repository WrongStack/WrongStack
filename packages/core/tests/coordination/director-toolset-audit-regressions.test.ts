import type { Tool } from '@wrongstack/contracts/types/tool';
import { describe, expect, it } from 'vitest';
import { buildDirectorToolset } from '../../src/coordination/director/director-toolset.js';
import { Director } from '../../src/coordination/director.js';

/**
 * Behaviour found by driving the director toolset against a real Director
 * (audit 2026-09-15):
 * - assign_task to an unknown subagent returned a taskId that never settled,
 *   so await_tasks blocked forever while any other worker stayed live;
 * - roll_up rendered a failed task's structured error as "[object Object]";
 * - collab_debug over only missing paths reported `approve` with zero bugs.
 */
function buildToolset() {
  const director = new Director({
    sessionId: 'sess_audit',
    config: {
      coordinatorId: 'coord-audit',
      doneCondition: { type: 'all_tasks_done' },
      maxConcurrent: 4,
    },
    runner: async (task) => {
      if (task.description.includes('explode')) throw new Error('worker crashed on purpose');
      return { result: 'done', iterations: 1, toolCalls: 0 };
    },
  });
  const tools = new Map<string, Tool>(
    (buildDirectorToolset(director) as Tool[]).map((tool) => [tool.name, tool]),
  );
  const run = (name: string, input: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool.execute(
      input as never,
      { meta: {} } as never,
      {
        signal: new AbortController().signal,
      } as never,
    ) as Promise<Record<string, unknown>>;
  };
  return { director, run };
}

const boundary = { scope: 'the audit fixture only', outOfScope: ['any real project file'] };

describe('director toolset audit regressions', () => {
  it('rejects assign_task to a subagent that was never spawned', async () => {
    const { director, run } = buildToolset();
    try {
      const spawned = await run('spawn_subagent', { name: 'worker' });
      await expect(
        run('assign_task', { subagentId: 'ghost', description: 'x', ...boundary }),
      ).rejects.toThrow(/unknown or stopped subagent "ghost".*spawn it first/);
      // A real worker still accepts work.
      const assigned = await run('assign_task', {
        subagentId: spawned['subagentId'],
        description: 'real work',
        ...boundary,
      });
      const awaited = await run('await_tasks', { taskIds: [assigned['taskId']] });
      expect(awaited['results']).toMatchObject([{ status: 'success' }]);
    } finally {
      await director.shutdown();
    }
  });

  it('renders a failed task error by kind and message in roll_up', async () => {
    const { director, run } = buildToolset();
    try {
      const spawned = await run('spawn_subagent', { name: 'worker' });
      const assigned = await run('assign_task', {
        subagentId: spawned['subagentId'],
        description: 'explode now',
        ...boundary,
      });
      await run('await_tasks', { taskIds: [assigned['taskId']] });
      const rolled = await run('roll_up', { taskIds: [assigned['taskId']] });
      expect(rolled['summary']).toContain('worker crashed on purpose');
      expect(rolled['summary']).not.toContain('[object Object]');
    } finally {
      await director.shutdown();
    }
  });

  it('refuses collab_debug when no target path is a readable file', async () => {
    const { director, run } = buildToolset();
    try {
      await expect(
        run('collab_debug', { targetPaths: ['does/not/exist-audit.ts'], timeoutMs: 1000 }),
      ).rejects.toThrow(/no readable file matches targetPaths/);
    } finally {
      await director.shutdown();
    }
  });
});
