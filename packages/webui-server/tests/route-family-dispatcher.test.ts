import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  createRouteFamilyDispatcher,
  type RouteFamilyDispatcherOptions,
  type RouteFamilyTable,
} from '../src/server/route-family-dispatcher.js';

function options(
  overrides: Partial<RouteFamilyDispatcherOptions> = {},
): RouteFamilyDispatcherOptions {
  return {
    routes: {
      goal: { handleMessage: vi.fn(async () => true) },
    } as unknown as RouteFamilyTable,
    memory: {} as never,
    content: {} as never,
    chronicle: {} as never,
    introspection: {
      agent: { ctx: {} },
      getConfig: () => ({}),
    } as never,
    getKanbanContext: () => ({ projectRoot: '' }),
    onUnknown: vi.fn(),
    ...overrides,
  };
}

describe('createRouteFamilyDispatcher', () => {
  it('routes a delegated protocol family through the canonical table', async () => {
    const input = options();
    const dispatch = createRouteFamilyDispatcher(input);

    await dispatch({} as WebSocket, { type: 'goal.refresh', payload: {} });

    expect(input.routes.goal.handleMessage).toHaveBeenCalledWith({} as WebSocket, {
      type: 'goal.refresh',
      payload: {},
    });
    expect(input.onUnknown).not.toHaveBeenCalled();
  });

  it('stops before route evaluation when the host guard rejects a message', async () => {
    const beforeDispatch = vi.fn(() => false);
    const input = options({ beforeDispatch });
    const dispatch = createRouteFamilyDispatcher(input);

    await dispatch({} as WebSocket, { type: 'goal.refresh', payload: {} });

    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(input.routes.goal.handleMessage).not.toHaveBeenCalled();
    expect(input.onUnknown).not.toHaveBeenCalled();
  });

  it('delegates unknown protocol messages to the host policy', async () => {
    const onUnknown = vi.fn();
    const input = options({ onUnknown });
    const dispatch = createRouteFamilyDispatcher(input);
    const message = { type: 'future.unknown', payload: { version: 2 } };

    await dispatch({} as WebSocket, message);

    expect(onUnknown).toHaveBeenCalledWith({}, message);
  });
});
