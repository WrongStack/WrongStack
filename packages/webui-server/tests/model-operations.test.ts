import type { Context } from '@wrongstack/core/agent';
import { createModelOperations } from '../src/server/model-operations.js';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

function harness(options: { runActive?: boolean; fail?: boolean } = {}) {
  const context = {
    model: 'old-model',
    provider: { id: 'old-provider' },
  } as never as Context;
  const sent: Array<{ type: string; payload: unknown }> = [];
  const broadcasts: Array<{ type: string; payload: unknown }> = [];
  const applyModelSwitch = vi.fn(async (provider: string, model: string) => {
    if (options.fail) throw new Error('provider unavailable');
    context.provider = { id: provider } as Context['provider'];
    context.model = model;
  });
  const operations = createModelOperations({
    context,
    getConfig: () => undefined,
    getLiveProviderId: () => context.provider.id,
    buildProvider: () => context.provider,
    applyModelSwitch,
    isRunActive: () => options.runActive ?? false,
    send: (_ws, message) => sent.push(message),
    broadcast: (message) => broadcasts.push(message),
  });
  return {
    context,
    sent,
    broadcasts,
    applyModelSwitch,
    switchModel: (payload: unknown) => operations.switchModel({} as WebSocket, payload),
  };
}

describe('model switch lifecycle', () => {
  it('broadcasts a correlated success with the activation boundary', async () => {
    const h = harness({ runActive: true });

    await h.switchModel({
      provider: 'new-provider',
      model: 'new-model',
      requestId: 'switch-1',
    });

    expect(h.sent).toEqual([]);
    expect(h.broadcasts).toEqual([
      {
        type: 'model.switch_result',
        payload: {
          requestId: 'switch-1',
          success: true,
          message: 'Switched to new-provider / new-model',
          provider: 'new-provider',
          model: 'new-model',
          previousProvider: 'old-provider',
          previousModel: 'old-model',
          runActive: true,
        },
      },
    ]);
  });

  it('sends failure only to the requester and preserves the previous identity', async () => {
    const h = harness({ fail: true });

    await h.switchModel({
      provider: 'bad-provider',
      model: 'bad-model',
      requestId: 'switch-2',
    });

    expect(h.broadcasts).toEqual([]);
    expect(h.context.provider.id).toBe('old-provider');
    expect(h.context.model).toBe('old-model');
    expect(h.sent).toEqual([
      {
        type: 'model.switch_result',
        payload: expect.objectContaining({
          requestId: 'switch-2',
          success: false,
          previousProvider: 'old-provider',
          previousModel: 'old-model',
          runActive: false,
        }),
      },
    ]);
  });

  it('keeps the legacy result only for clients without request correlation', async () => {
    const h = harness();

    await h.switchModel({ provider: 'simple-provider', model: 'simple-model' });

    expect(h.broadcasts[0]).toMatchObject({
      type: 'model.switch_result',
      payload: { success: true, provider: 'simple-provider', model: 'simple-model' },
    });
    expect(h.sent).toEqual([
      {
        type: 'key.operation_result',
        payload: {
          success: true,
          message: 'Switched to simple-provider / simple-model',
        },
      },
    ]);
  });
});
