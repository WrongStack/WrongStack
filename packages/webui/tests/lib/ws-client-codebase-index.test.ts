import { describe, expect, it, vi } from 'vitest';
import { WrongStackWebSocketClient } from '../../src/lib/ws-client';

describe('WrongStackWebSocketClient codebase index control', () => {
  it('waits for the shutdown result matching its request id', async () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    const send = vi.spyOn(client, 'send').mockReturnValue(true);

    const pending = client.shutdownCodebaseIndexServer();
    const request = send.mock.calls[0]?.[0] as {
      type: string;
      payload: { requestId: string };
    };
    expect(request).toMatchObject({
      type: 'codebase.index.server.shutdown',
      payload: { requestId: expect.any(String) },
    });
    expect(send.mock.calls[0]?.[1]).toEqual({ queueIfDisconnected: false });

    const deliver = (
      client as unknown as {
        handleMessage(message: unknown): void;
      }
    ).handleMessage.bind(client);
    deliver({
      type: 'codebase.index.server.shutdown_result',
      payload: { requestId: 'another-request', stopped: false },
    });
    deliver({
      type: 'codebase.index.server.shutdown_result',
      payload: { requestId: request.payload.requestId, stopped: true, pid: 4242 },
    });

    await expect(pending).resolves.toEqual({
      requestId: request.payload.requestId,
      stopped: true,
      pid: 4242,
    });
  });

  it('does not queue a destructive shutdown while disconnected', async () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    const send = vi.spyOn(client, 'send').mockReturnValue(false);

    await expect(client.shutdownCodebaseIndexServer()).resolves.toMatchObject({
      stopped: false,
      reason: 'WebSocket is not connected.',
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'codebase.index.server.shutdown' }),
      { queueIfDisconnected: false },
    );
  });
});
