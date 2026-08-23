import type { Logger } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { TelegramBot } from '../../src/bot.js';
import type { TelegramIncomingMessage } from '../../src/bot.js';
import { makeTelegramReadTool } from '../../src/tools/telegram-read.js';
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

function makeBot() {
  return new TelegramBot({
    token: 'test:token',
    pollIntervalSec: 60,
    allowedUsers: new Set<string>(),
    allowedChats: new Set<string>(),
    bufferSize: 50,
    log,
    onMessage: vi.fn(),
  });
}

function pushMsg(bot: TelegramBot, msg: Partial<TelegramIncomingMessage>) {
  const buf = (bot as never as { inbox: { buffer: TelegramIncomingMessage[] } }).inbox.buffer;
  buf.push({
    messageId: msg.messageId ?? 1,
    chatId: msg.chatId ?? 123,
    chatType: msg.chatType ?? 'private',
    userId: msg.userId,
    userName: msg.userName,
    text: msg.text ?? 'hello',
    timestamp: msg.timestamp ?? Date.now(),
  });
  while (buf.length > 50) buf.shift();
}

// ---------------------------------------------------------------------------
// telegram_read
// ---------------------------------------------------------------------------

describe('telegram_read tool', () => {
  it('returns buffered messages', async () => {
    const bot = makeBot();
    pushMsg(bot, { messageId: 1, text: 'hi from user', userId: 456, chatId: 789 });
    pushMsg(bot, { messageId: 2, text: 'task completed', userId: 456, chatId: 789 });

    const tool = makeTelegramReadTool({ bot });
    const result = await tool.execute({ limit: 5 });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.text).toBe('task completed');
    expect(result.messages[0]!.chat_id).toBe(789);
    expect(result.messages[0]!.from).toBe('user_456');
    expect(result.buffer_total).toBe(2);
  });

  it('ack_last clears processed messages', async () => {
    const bot = makeBot();
    pushMsg(bot, { messageId: 10, text: 'old' });
    pushMsg(bot, { messageId: 20, text: 'new' });
    pushMsg(bot, { messageId: 30, text: 'newest' });

    const tool = makeTelegramReadTool({ bot });
    // getMessages snapshot is taken BEFORE ack — shows all 3, then clears 2
    const result = await tool.execute({ limit: 5, ack_last: 20 });

    expect(result.acked).toBe(2);
    expect(bot.bufferCount).toBe(1);
    // Messages are a snapshot from before ack, so still 3 here
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]!.message_id).toBe(30);
    expect(result.messages[2]!.message_id).toBe(10);
  });

  it('filters by chat_id', async () => {
    const bot = makeBot();
    pushMsg(bot, { messageId: 1, text: 'a', chatId: 111 });
    pushMsg(bot, { messageId: 2, text: 'b', chatId: 222 });

    const tool = makeTelegramReadTool({ bot });
    const result = await tool.execute({ chat_id: 111 });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.text).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// telegram_send
// ---------------------------------------------------------------------------

describe('telegram_send tool', () => {
  it('declares a confirmed mutating network side effect', () => {
    const tool = makeTelegramSendTool({
      bot: makeBot(),
      getDefaultChatId: () => '999',
      maxMessageLength: 4000,
      log,
    });

    expect(tool.permission).toBe('confirm');
    expect(tool.mutating).toBe(true);
    expect(tool.capabilities).toEqual(['net.outbound']);
  });

  it('throws when no chat_id provided and no default', async () => {
    const bot = makeBot();
    const tool = makeTelegramSendTool({
      bot,
      getDefaultChatId: () => undefined,
      maxMessageLength: 4000,
      log,
    });

    await expect(tool.execute({ message: 'test' })).rejects.toThrow('No chat_id provided');
  });

  it('sends message and returns result', async () => {
    const bot = makeBot();
    // Mock sendMessage
    const sendSpy = vi.fn().mockResolvedValue({
      ok: true,
      result: { message_id: 42, chat: { id: 123, type: 'private' } },
    });
    bot.sendMessage = sendSpy;

    const tool = makeTelegramSendTool({
      bot,
      getDefaultChatId: () => '999',
      maxMessageLength: 4000,
      log,
    });

    const result = await tool.execute({
      message: 'Build succeeded <b>✓</b>',
    });

    expect(sendSpy).toHaveBeenCalledWith('999', expect.stringContaining('Build succeeded'));
    expect(result.ok).toBe(true);
    expect(result.message_id).toBe(42);
  });

  it('forwards the tool AbortSignal to the bot send path', async () => {
    const bot = makeBot();
    const sendSpy = vi.fn().mockResolvedValue({
      ok: true,
      result: { message_id: 43, chat: { id: 999, type: 'private' } },
    });
    bot.sendMessage = sendSpy;
    const tool = makeTelegramSendTool({
      bot,
      getDefaultChatId: () => '999',
      maxMessageLength: 4000,
      log,
    });
    const controller = new AbortController();

    await tool.execute({ message: 'cancel-aware send' }, undefined as never, {
      signal: controller.signal,
    });

    expect(sendSpy).toHaveBeenCalledWith(
      '999',
      expect.stringContaining('cancel-aware send'),
      controller.signal,
    );
  });

  it('uses an explicitly allowed chat_id over the paired default', async () => {
    const bot = makeBot();
    const sendSpy = vi.fn().mockResolvedValue({
      ok: true,
      result: { message_id: 1, chat: { id: 111, type: 'private' } },
    });
    bot.sendMessage = sendSpy;

    const tool = makeTelegramSendTool({
      bot,
      getDefaultChatId: () => '999',
      getAllowedOutboundChatIds: () => ['111'],
      maxMessageLength: 4000,
      log,
    });

    await tool.execute({ chat_id: '111', message: 'hi' });
    expect(sendSpy).toHaveBeenCalledWith('111', expect.any(String));
  });

  it('rejects an untrusted chat_id before any bot call', async () => {
    const bot = makeBot();
    const sendSpy = vi.fn();
    bot.sendMessage = sendSpy;
    const tool = makeTelegramSendTool({
      bot,
      getDefaultChatId: () => '999',
      getAllowedOutboundChatIds: () => ['111'],
      maxMessageLength: 4000,
      log,
    });

    await expect(tool.execute({ chat_id: '222', message: 'do not send' })).rejects.toThrow(
      'not paired or included in allowedOutboundChats',
    );
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('scrubs common raw credentials before sending', async () => {
    const bot = makeBot();
    const sendSpy = vi.fn().mockResolvedValue({ ok: true });
    bot.sendMessage = sendSpy;
    const tool = makeTelegramSendTool({
      bot,
      getDefaultChatId: () => '999',
      maxMessageLength: 4000,
      log,
    });
    const raw = 'sk-' + 'a'.repeat(24);
    const botToken = `123456:${'BOT_TOKEN_CANARY_'.repeat(2)}`;

    await tool.execute({
      message: `Credential: ${raw}; Telegram: ${botToken}; TOKEN=CANARY_ENV_VALUE_DDD`,
    });

    const sent = String(sendSpy.mock.calls[0]?.[1]);
    expect(sent).not.toContain(raw);
    expect(sent).not.toContain(botToken);
    expect(sent).not.toContain('CANARY_ENV_VALUE_DDD');
    expect(sent).toContain('[REDACTED');
  });

  it('handles result without chat object', async () => {
    const bot = makeBot();
    bot.sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      result: { message_id: 99 },
    });

    const tool = makeTelegramSendTool({
      bot,
      getDefaultChatId: () => '999',
      maxMessageLength: 4000,
      log,
    });

    const result = await tool.execute({ message: 'test' });
    expect(result.ok).toBe(true);
    expect(result.message_id).toBe(99);
    expect(result.chat).toBeUndefined();
  });
});
