/**
 * The standalone engine (what the desktop runs) applied, restored and displayed a leader's own
 * effort override but never registered `leader_effort_set`, so the leader there could not set
 * one. Real tool and real override helpers; the registry and bus are recorders.
 */
import type { Config } from '@wrongstack/contracts/types';
import { activeLeaderEffort } from '@wrongstack/core/execution';
import { describe, expect, it } from 'vitest';
import { registerLeaderEffortTool } from '../src/server/leader-effort-tool.js';

function setup(config: Partial<Config> = {}) {
  const registered: Array<{ name: string; execute: (input: unknown, ctx: unknown) => unknown }> =
    [];
  const emitted: Array<[string, unknown]> = [];
  const live = {
    modelRuntime: { reasoning: { effort: 'high' } },
    providers: { zai: { type: 'zai-coding-plan' } },
    tools: {},
    ...config,
  } as unknown as Config;
  registerLeaderEffortTool({
    toolRegistry: { registerDefault: (tool: never) => registered.push(tool) } as never,
    getConfig: () => live,
    modelsRegistry: {
      getModel: async () => ({
        capabilities: {
          reasoningConfig: { effortSupported: true, effortLevels: ['low', 'high', 'max'] },
        },
      }),
    } as never,
    events: { emit: (name: string, payload: unknown) => emitted.push([name, payload]) } as never,
  });
  const journal: unknown[] = [];
  const ctx = {
    meta: {} as Record<string, unknown>,
    provider: { id: 'zai' },
    model: 'glm-5.3-flash',
    session: { append: async (event: unknown) => journal.push(event) },
    eventSessionId: () => 'tab-1',
  };
  return { registered, emitted, ctx, journal };
}

describe('leader_effort_set in the standalone engine', () => {
  it('lets the leader set and reset its own effort for this conversation only', async () => {
    const { registered, emitted, ctx, journal } = setup();
    const tool = registered.find((item) => item.name === 'leader_effort_set');
    expect(tool).toBeDefined();

    await tool!.execute({ action: 'set', effort: 'low', reason: 'mechanical renames' }, ctx);
    expect(activeLeaderEffort(ctx.meta, 'high')).toBe('low');
    expect(emitted).toEqual([
      [
        'leader.effort_changed',
        { sessionId: 'tab-1', effort: 'low', reason: 'mechanical renames' },
      ],
    ]);
    expect(journal).toHaveLength(1);

    await tool!.execute({ action: 'reset' }, ctx);
    expect(activeLeaderEffort(ctx.meta, 'high')).toBeUndefined();
    expect(emitted.at(-1)).toEqual(['leader.effort_changed', { sessionId: 'tab-1' }]);
  });
  it('honours tools.disabledTools', () => {
    const { registered } = setup({ tools: { disabledTools: ['leader_effort_set'] } } as never);
    expect(registered).toHaveLength(0);
  });
});
