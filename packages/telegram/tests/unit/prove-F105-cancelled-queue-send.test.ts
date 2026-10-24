import type { Logger } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelegramBot } from '../../src/bot.js';
import { TelegramBotOutbound } from '../../src/bot-queue.js';
import { makeTelegramSendTool } from '../../src/tools/telegram-send.js';

const log: Logger = {
  level: 'debug',
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child() {
    return this;
  },
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
describe('F105 telegram_send queue cancellation regression', () => {
  it('rejects an already aborted send before calling the bot', async () => {
    const sendMessage = vi.fn<TelegramBot['sendMessage']>(async () => ({
      ok: true,
      result: { message_id: 1, date: 0, chat: { id: 123, type: 'private' } },
    }));
    const bot = { sendMessage } as unknown as TelegramBot;
    const outbound = new TelegramBotOutbound({ bot, log });
    cleanups.push(() => outbound.stop());
    const tool = makeTelegramSendTool({
      bot,
      outbound,
      getDefaultChatId: () => '123',
      maxMessageLength: 4000,
      log,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.execute({ message: 'do not send after cancellation' }, undefined as never, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(outbound.stats()).toMatchObject({ enqueued: 0, sent: 0, pending: 0 });
  });

  it('passes a live signal through the real outbound queue to the bot', async () => {
    const sendMessage = vi.fn<TelegramBot['sendMessage']>(async () => ({
      ok: true,
      result: { message_id: 1, date: 0, chat: { id: 123, type: 'private' } },
    }));
    const bot = { sendMessage } as unknown as TelegramBot;
    const outbound = new TelegramBotOutbound({ bot, log });
    cleanups.push(() => outbound.stop());
    const tool = makeTelegramSendTool({
      bot,
      outbound,
      getDefaultChatId: () => '123',
      maxMessageLength: 4000,
      log,
    });
    const controller = new AbortController();
    const result = await tool.execute(
      { message: 'send with cancellation support' },
      undefined as never,
      { signal: controller.signal },
    );
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      '123',
      'send with cancellation support',
      controller.signal,
    );
    expect(result).toMatchObject({ ok: true, message_id: 1 });
  });
});
