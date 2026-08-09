import { describe, expect, it, vi } from 'vitest';

const { subscribeKanbanDaemonEvents } = vi.hoisted(() => ({
  subscribeKanbanDaemonEvents: vi.fn(() => vi.fn()),
}));
vi.mock('../src/server/kanban-daemon-subscriber.js', () => ({ subscribeKanbanDaemonEvents }));

import { emitFallbackChoice } from '../src/server/fallback-choice.js';
import { watchKanbanBoards } from '../src/server/kanban-board-watcher.js';
import { createModeHandlers } from '../src/server/mode-handlers.js';
import { discoverAndMergeWebuiProviders } from '../src/server/model-auto-discovery.js';
import { buildRoutes } from '../src/server/routes.js';

describe('previously unexecuted WebUI server contracts', () => {
  it('validates and emits fallback choices', () => {
    const emit = vi.fn();
    expect(
      emitFallbackChoice(
        { emit } as never,
        {
          type: 'model.fallback_choice',
          payload: { requestId: 'req-1', providerId: 'openai', model: 'gpt-5', autoSwitch: true },
        } as never,
      ),
    ).toEqual({ ok: true });
    expect(emit).toHaveBeenCalledWith('provider.fallback_choice', {
      requestId: 'req-1',
      providerId: 'openai',
      model: 'gpt-5',
      autoSwitch: true,
    });
    expect(
      emitFallbackChoice(undefined, {
        type: 'model.fallback_choice',
        payload: null,
      } as never),
    ).toMatchObject({ ok: false });
  });

  it('keeps the Kanban compatibility wrapper on the daemon subscriber', () => {
    const broadcast = vi.fn();
    const dispose = watchKanbanBoards('D:/project', broadcast);

    expect(subscribeKanbanDaemonEvents).toHaveBeenCalledWith('D:/project', broadcast);
    expect(dispose).toBeTypeOf('function');
  });

  it('returns early when model auto-discovery has no overlay registry', async () => {
    await expect(
      discoverAndMergeWebuiProviders({
        config: {} as never,
        registry: {},
        cacheDir: 'unused',
      }),
    ).resolves.toBeUndefined();
  });

  it('loads the extracted route composition entry points from source', () => {
    expect(buildRoutes).toBeTypeOf('function');
    expect(createModeHandlers).toBeTypeOf('function');
  });
});
