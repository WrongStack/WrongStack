import { describe, expect, it, vi } from 'vitest';
import { WrongStackWebSocketClient } from '../../src/lib/ws-client';

describe('WrongStackWebSocketClient model switch', () => {
  it('waits for the result matching its request id', async () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    const send = vi.spyOn(client, 'send').mockImplementation(() => {});

    const pending = client.switchModel('openai', 'gpt-5');
    const request = send.mock.calls[0]?.[0] as {
      type: string;
      payload: { provider: string; model: string; requestId: string };
    };
    expect(request).toMatchObject({
      type: 'model.switch',
      payload: { provider: 'openai', model: 'gpt-5' },
    });

    (
      client as unknown as {
        handleMessage: (message: unknown) => void;
      }
    ).handleMessage({
      type: 'model.switch_result',
      payload: {
        requestId: request.payload.requestId,
        success: true,
        message: 'Switched',
        provider: 'openai',
        model: 'gpt-5',
        runActive: true,
      },
    });

    await expect(pending).resolves.toMatchObject({
      success: true,
      provider: 'openai',
      model: 'gpt-5',
      runActive: true,
    });
  });
});
