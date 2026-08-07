import {
  type AutonomyRouteHandlers,
  type CompletionRouteHandlers,
  type ConversationRouteHandlers,
  type GoalSnapshotRouteHandlers,
  handleAutonomyRoute,
  handleCompletionRoute,
  handleConversationRoute,
  handleGoalSnapshotRoute,
} from '@wrongstack/webui-server';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

const ws = {} as WebSocket;

describe('canonical core route families', () => {
  it.each([
    ['user_message', 'userMessage'],
    ['abort', 'abort'],
    ['ping', 'ping'],
    ['tool.confirm_result', 'confirmTool'],
  ] as const)('dispatches conversation message %s', async (type, handlerName) => {
    const handlers: ConversationRouteHandlers = {
      userMessage: vi.fn(),
      abort: vi.fn(),
      ping: vi.fn(),
      confirmTool: vi.fn(),
      topicAdvice: vi.fn(),
    };
    const msg = { type, payload: {} };

    await expect(handleConversationRoute(ws, msg, handlers)).resolves.toBe(true);
    expect(handlers[handlerName]).toHaveBeenCalledWith(ws, msg);
  });

  it('dispatches completion and autonomy through their capability adapters', async () => {
    const completion: CompletionRouteHandlers = { request: vi.fn() };
    const autonomy: AutonomyRouteHandlers = { switchMode: vi.fn() };
    const completionMsg = { type: 'completion.request', payload: {} };
    const autonomyMsg = { type: 'autonomy.switch', payload: { mode: 'ask' } };

    await expect(handleCompletionRoute(ws, completionMsg, completion)).resolves.toBe(true);
    await expect(handleAutonomyRoute(ws, autonomyMsg, autonomy)).resolves.toBe(true);
    expect(completion.request).toHaveBeenCalledWith(ws, completionMsg);
    expect(autonomy.switchMode).toHaveBeenCalledWith(ws, autonomyMsg);
  });

  it.each(['goal.get', 'goal-state.get'])(
    'routes %s to the same snapshot authority',
    async (type) => {
      const handlers: GoalSnapshotRouteHandlers = { getSnapshot: vi.fn() };
      const msg = { type };

      await expect(handleGoalSnapshotRoute(ws, msg, handlers)).resolves.toBe(true);
      expect(handlers.getSnapshot).toHaveBeenCalledWith(ws, msg);
    },
  );

  it('does not claim unrelated messages', async () => {
    const handlers: ConversationRouteHandlers = {
      userMessage: vi.fn(),
      abort: vi.fn(),
      ping: vi.fn(),
      confirmTool: vi.fn(),
      topicAdvice: vi.fn(),
    };
    await expect(handleConversationRoute(ws, { type: 'providers.list' }, handlers)).resolves.toBe(
      false,
    );
  });
});
