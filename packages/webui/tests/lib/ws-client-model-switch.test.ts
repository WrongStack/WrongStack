import { describe, expect, it, vi } from 'vitest';
import { WrongStackWebSocketClient } from '../../src/lib/ws-client';

describe('WrongStackWebSocketClient model switch', () => {
  it('keeps listening through a cold ACP provider switch beyond the API-model deadline', async () => {
    vi.useFakeTimers();
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    const send = vi.spyOn(client, 'send').mockImplementation(() => true);
    try {
      let settled = false;
      const pending = client.switchModel('acp', 'codex-cli').then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled).toBe(false);
      const requestId = (send.mock.calls[0]![0] as { payload: { requestId: string } }).payload
        .requestId;
      client.emit({
        type: 'model.switch_result',
        payload: {
          requestId,
          success: true,
          message: 'Switched',
          provider: 'acp',
          model: 'codex-cli',
          runActive: false,
        },
      });
      await expect(pending).resolves.toMatchObject({ success: true });
    } finally {
      client.disconnect();
      vi.useRealTimers();
    }
  });
  it('waits for the result matching its request id', async () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    const send = vi.spyOn(client, 'send').mockImplementation(() => true);

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
