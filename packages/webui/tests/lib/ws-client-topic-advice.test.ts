import { describe, expect, it, vi } from 'vitest';
import { WrongStackWebSocketClient } from '../../src/lib/ws-client.js';

describe('WrongStackWebSocketClient topic boundaries', () => {
  it('waits for the matching advice response and keeps the prompt bounded to its request', async () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    const send = vi.spyOn(client, 'send').mockReturnValue(true);

    const pending = client.adviseTopic('Plan a different deployment.');
    const request = send.mock.calls[0]?.[0] as {
      type: string;
      payload: { requestId: string; prompt: string };
    };
    expect(request).toMatchObject({
      type: 'topic.advice',
      payload: { prompt: 'Plan a different deployment.' },
    });

    (
      client as unknown as {
        handleMessage: (message: unknown) => void;
      }
    ).handleMessage({
      type: 'topic.advice_result',
      payload: {
        requestId: request.payload.requestId,
        suggestNewContext: true,
        confidence: 0.91,
        reason: 'different goal',
        source: 'model',
      },
    });

    await expect(pending).resolves.toMatchObject({
      suggestNewContext: true,
      confidence: 0.91,
    });
  });

  it('marks a fresh-context run on the same user message frame', () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    const send = vi.spyOn(client, 'send').mockReturnValue(true);

    client.sendMessage('new goal', undefined, true);

    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: 'user_message',
      payload: { content: 'new goal', freshContext: true },
    });
  });
});
