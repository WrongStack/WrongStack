import { describe, expect, it, vi } from 'vitest';
import { WrongStackWebSocketClient } from '../../src/lib/ws-client';

describe('WrongStackWebSocketClient permission confirmations', () => {
  it('tracks confirm prompts without expecting a browser-side resolver', () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    const seen: unknown[] = [];
    client.on('tool.confirm_needed', (msg) => seen.push(msg));

    (
      client as unknown as {
        handleMessage: (msg: unknown) => void;
        pendingConfirms: Map<string, unknown>;
      }
    ).handleMessage({
      type: 'tool.confirm_needed',
      payload: {
        id: 'confirm_1',
        toolName: 'mail_send',
        input: { to: 'leader', body: 'ping' },
        suggestedPattern: 'mail_send:*',
      },
    });

    expect(
      (
        client as unknown as {
          pendingConfirms: Map<string, unknown>;
        }
      ).pendingConfirms.has('confirm_1'),
    ).toBe(true);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { payload: Record<string, unknown> }).payload).not.toHaveProperty('resolve');
  });

  it('always sends confirm_result when resolving a prompt', () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    const send = vi.spyOn(client, 'send').mockImplementation(() => true);
    (
      client as unknown as {
        pendingConfirms: Map<string, unknown>;
      }
    ).pendingConfirms.set('confirm_1', {});

    expect(() => client.sendConfirm('confirm_1', 'no')).not.toThrow();

    expect(send).toHaveBeenCalledWith({
      type: 'tool.confirm_result',
      payload: { id: 'confirm_1', decision: 'no' },
    });
    expect(
      (
        client as unknown as {
          pendingConfirms: Map<string, unknown>;
        }
      ).pendingConfirms.has('confirm_1'),
    ).toBe(false);
  });
});
