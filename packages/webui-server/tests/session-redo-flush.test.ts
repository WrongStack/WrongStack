/**
 * A redo replaces the live messages, which queues a `messages_replaced` journal entry in the
 * session's write buffer. The success reply must follow the flush: a client that reads the
 * journal revision after the reply (to review the next rewind) would otherwise see it change
 * under it and have that rewind refused as stale.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@wrongstack/core/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/core/storage')>()),
  redoLastRewind: async () => ({
    toPromptIndex: 0,
    restoredEvents: 3,
    files: [],
    conflicts: [],
    conversation: { messages: [] },
  }),
}));

const { createSessionCheckpointHandlers } = await import(
  '../src/server/session-checkpoint-handlers.js'
);

describe('session redo', () => {
  it('flushes the journal before acknowledging a redo', async () => {
    const order: string[] = [];
    const handlers = createSessionCheckpointHandlers({
      ctx: {
        getProjectRoot: () => 'root',
        isRunActive: () => false,
        sessionStartPayload: async () => ({}),
      },
      sendTo: (_ws: unknown, message: { type: string; payload: Record<string, unknown> }) => {
        order.push(`${message.type}:${String(message.payload['success'])}`);
      },
      broadcastToAll: () => undefined,
      result: (_ws: unknown, success: boolean) => order.push(`result:${success}`),
      actingSessionId: () => 'sess',
      ensureCurrentSession: () => true,
      serializeSessionTransition: async (fn: () => Promise<void>) => fn(),
      contextForMessage: () => ({
        session: {
          id: 'sess',
          flush: async () => {
            order.push('flush');
          },
        },
        state: {},
        meta: {},
      }),
      sessionsDirectory: () => 'sessions',
    } as never);
    await handlers.redoSession({} as never, { type: 'session.redo', payload: {} } as never);
    expect(order).toEqual(['flush', 'key.operation_result:true']);
  });
});
