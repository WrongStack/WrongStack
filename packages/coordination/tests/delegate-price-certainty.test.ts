import { EventBus, type EventMap } from '@wrongstack/contracts/kernel/events';
import { describe, expect, it } from 'vitest';
import { createDelegateTool } from '../src/delegate-tool.js';
import { Director } from '../src/director.js';

describe('delegate worker price certainty', () => {
  it.each([
    { label: 'known', rates: { input: 1, output: 2 }, expected: 0.00011 },
    { label: 'explicitly free', rates: { input: 0, output: 0 }, expected: 0 },
    { label: 'unknown', rates: undefined, expected: undefined },
    { label: 'missing output rate', rates: { input: 1 }, expected: undefined },
  ])('$label price stays distinct from a free worker', async ({ rates, expected }) => {
    const events = new EventBus();
    const completed: EventMap['delegate.completed'][] = [];
    events.on('delegate.completed', (event) => completed.push(event));
    const director = new Director({
      sessionId: 'sess_worker_price_certainty',
      config: {
        coordinatorId: 'price-certainty',
        maxConcurrent: 1,
        doneCondition: { type: 'all_tasks_done' },
      },
      resolveModelPrice: async () => rates,
      runner: async (_task, context) => {
        director.fleet.emit({
          subagentId: context.subagentId,
          type: 'provider.response',
          ts: Date.now(),
          payload: { usage: { input: 100, output: 5 } },
        });
        return { result: 'Done.', iterations: 1, toolCalls: 0 };
      },
    });
    try {
      const tool = createDelegateTool({
        events,
        host: {
          isDirectorMode: () => true,
          ensureDirector: async () => director,
          promoteToDirector: async () => director,
        },
      });
      await tool.execute(
        {
          wait: true,
          name: 'worker',
          provider: 'local',
          model: 'worker-model',
          task: 'Report a status.',
          scope: 'Report one status.',
          outOfScope: ['Do not edit files.'],
        },
        null as never,
        { signal: new AbortController().signal },
      );
      expect(completed).toHaveLength(1);
      expect(completed[0]?.ok).toBe(true);
      if (expected === undefined) expect(completed[0]?.costUsd).toBeUndefined();
      else expect(completed[0]?.costUsd).toBeCloseTo(expected, 12);
    } finally {
      await director.shutdown();
    }
  });
});
