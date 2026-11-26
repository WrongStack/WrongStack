import { describe, expect, it } from 'vitest';
import { makeTelegramReadTool } from '../src/tools/telegram-read.js';

describe('telegram_read non-finite guards', () => {
  it('ignores non-integer ack_last and handles invalid message timestamps safely', async () => {
    let ackCalls = 0;
    const tool = makeTelegramReadTool({
      bot: {
        bufferCount: 1,
        getMessages: () => [
          {
            messageId: 1,
            chatId: 'c1',
            chatType: 'private',
            userName: 'alice',
            text: 'hi',
            timestamp: Number.NaN,
          },
        ],
        acknowledge: () => {
          ackCalls += 1;
          return 1;
        },
      } as never,
    });
    const out = (await tool.execute(
      { ack_last: Number.POSITIVE_INFINITY },
      {} as never,
      {} as never,
    )) as {
      messages: Array<{ ts: string }>;
      acked: number;
    };
    expect(ackCalls).toBe(0);
    expect(out.acked).toBe(0);
    expect(out.messages[0]?.ts).toBe('');
  });
});
