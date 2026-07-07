import type { Logger } from '@wrongstack/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramBot } from '../../src/bot.js';
import type { TelegramPluginConfig } from '../../src/config.js';
import {
  tgChatIdCommand,
  tgSendCommand,
  tgHealthCommand,
} from '../../src/slash-commands/index.js';

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
    bufferSize: 10,
    log,
    onMessage: vi.fn(),
  });
}

function makeConfig(overrides?: Partial<TelegramPluginConfig>): TelegramPluginConfig {
  return {
    botToken: 'test:token',
    pollIntervalSec: 2,
    notifyOnSessionEnd: true,
    longToolThresholdMs: 30_000,
    maxMessageLength: 4000,
    allowedUsers: [111, 222],
    allowedChats: ['-100123'],
    notifyChatId: '999',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// /telegram-health
// ---------------------------------------------------------------------------

describe('tgHealthCommand', () => {
  it('uses Telegram-specific slash names and plugin-name alias', () => {
    const cmd = tgHealthCommand(makeBot(), makeConfig());

    expect(cmd.name).toBe('telegram-health');
    expect(cmd.aliases).toEqual(expect.arrayContaining(['telegram', 'tgstat', 'tgs']));
    expect(cmd.help).toContain('/telegram-health');
    expect(cmd.help).toContain('/telegram');
  });

  // A single bot instance shared across tests so `bot.start()` (which
  // schedules a 60 s polling timer) is paired with `bot.stop()` in
  // afterEach — otherwise the timer keeps the test worker alive after
  // every test completes, and vitest's exit handshake stalls.
  const bots: TelegramBot[] = [];
  function makeTrackedBot(): TelegramBot {
    const b = makeBot();
    bots.push(b);
    return b;
  }

  it('shows connected bot status', async () => {
    const bot = makeTrackedBot();
    bot.start();
    // Mock health to return a healthy bot
    bot.health = vi.fn().mockResolvedValue({ ok: true, username: 'test_bot' });

    const cmd = tgHealthCommand(bot, makeConfig());
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('✅ @test_bot');
    expect(res?.message).toContain('Running:   yes');
    expect(res?.message).toContain('every 2s');
    expect(res?.message).toContain('2 users');
    expect(res?.message).toContain('1 chats');
    expect(res?.message).toContain('sessionEnd=true');
    expect(res?.message).toContain('longTool=30000ms');
  });

  it('shows offline bot status', async () => {
    const bot = makeBot();
    bot.health = vi.fn().mockResolvedValue({ ok: false, error: 'Network error' });

    const cmd = tgHealthCommand(bot, makeConfig());
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('❌ Network error');
    expect(res?.message).toContain('Running:   no');
  });

  it('shows "offline" when health has no error message', async () => {
    const bot = makeBot();
    bot.health = vi.fn().mockResolvedValue({ ok: false });

    const cmd = tgHealthCommand(bot, makeConfig());
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('❌ offline');
  });

  it('shows N/A when bot never started', async () => {
    const bot = makeBot();
    bot.health = vi.fn().mockResolvedValue({ ok: true, username: 'b' });

    const cmd = tgHealthCommand(bot, makeConfig());
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('Started:   N/A');
  });

  it('shows everyone when no allowlists set', async () => {
    const bot = makeBot();
    bot.health = vi.fn().mockResolvedValue({ ok: true, username: 'b' });

    const cfg = makeConfig({ allowedUsers: [], allowedChats: [] });
    const cmd = tgHealthCommand(bot, cfg);
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('everyone (users)');
    expect(res?.message).toContain('everyone (chats)');
  });

  it('shows "off" when notifications disabled', async () => {
    const bot = makeBot();
    bot.health = vi.fn().mockResolvedValue({ ok: true, username: 'b' });

    const cfg = makeConfig({ notifyOnSessionEnd: false, longToolThresholdMs: 0 });
    const cmd = tgHealthCommand(bot, cfg);
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('sessionEnd=false');
    expect(res?.message).toContain('longTool=off');
  });

  it('falls back to false when notifyOnSessionEnd is undefined', async () => {
    const bot = makeBot();
    bot.health = vi.fn().mockResolvedValue({ ok: true, username: 'b' });

    const cfg = makeConfig({ notifyOnSessionEnd: undefined, longToolThresholdMs: 0 });
    const cmd = tgHealthCommand(bot, cfg);
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('sessionEnd=false');
  });

  it('falls back to "connected" when username missing', async () => {
    const bot = makeBot();
    bot.health = vi.fn().mockResolvedValue({ ok: true });

    const cmd = tgHealthCommand(bot, makeConfig());
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('✅ @connected');
  });

  it('shows polling fallback when pollIntervalSec not set', async () => {
    const bot = makeBot();
    bot.health = vi.fn().mockResolvedValue({ ok: true, username: 'b' });

    const cfg = makeConfig({ pollIntervalSec: undefined as never as number });
    const cmd = tgHealthCommand(bot, cfg);
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('every 2s');
  });

  it('shows everyone when allowedUsers undefined', async () => {
    const bot = makeBot();
    bot.health = vi.fn().mockResolvedValue({ ok: true, username: 'b' });

    const cfg = makeConfig({ allowedUsers: undefined, allowedChats: undefined });
    const cmd = tgHealthCommand(bot, cfg);
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('everyone (users)');
    expect(res?.message).toContain('everyone (chats)');
  });

  afterEach(() => {
    // Stop every bot created via makeTrackedBot() so the 60 s polling
    // timer scheduled by bot.start() is cleared. Without this, vitest's
    // exit handshake stalls waiting for the timer to fire.
    for (const b of bots.splice(0)) {
      b.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// /telegram:send
// ---------------------------------------------------------------------------

describe('tgSendCommand', () => {
  it('shows usage when no args', async () => {
    const bot = makeBot();
    const cmd = tgSendCommand(bot, '999');
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('Usage:');
  });

  it('sends with explicit chat_id in args', async () => {
    const bot = makeBot();
    const sendSpy = vi.fn().mockResolvedValue({
      ok: true,
      result: { message_id: 42, chat: { id: 123, type: 'private' } },
    });
    bot.sendMessage = sendSpy;

    const cmd = tgSendCommand(bot, '999');
    const res = await cmd.run('123456 Hello world!', null as never);

    expect(sendSpy).toHaveBeenCalledWith('123456', 'Hello world!');
    expect(res?.message).toContain('✅');
    expect(res?.message).toContain('123456');
    expect(res?.message).toContain('msg_id=42');
  });

  it('uses default chatId when no id in args', async () => {
    const bot = makeBot();
    const sendSpy = vi.fn().mockResolvedValue({
      ok: true,
      result: { message_id: 7 },
    });
    bot.sendMessage = sendSpy;

    const cmd = tgSendCommand(bot, '888');
    const res = await cmd.run('Just a message', null as never);

    expect(sendSpy).toHaveBeenCalledWith('888', 'Just a message');
    expect(res?.message).toContain('✅');
  });

  it('shows error when no default and no chat_id in args', async () => {
    const bot = makeBot();
    const cmd = tgSendCommand(bot, undefined);
    const res = await cmd.run('Hello', null as never);

    expect(res?.message).toContain('No chat_id provided');
  });

  it('handles send failure gracefully', async () => {
    const bot = makeBot();
    bot.sendMessage = vi.fn().mockRejectedValue(new Error('Bot blocked by user'));

    const cmd = tgSendCommand(bot, '999');
    const res = await cmd.run('Hello', null as never);

    expect(res?.message).toContain('❌');
    expect(res?.message).toContain('Bot blocked by user');
  });

  it('handles send result without message_id', async () => {
    const bot = makeBot();
    bot.sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      result: undefined,
    });

    const cmd = tgSendCommand(bot, '999');
    const res = await cmd.run('hi', null as never);

    expect(res?.message).toContain('msg_id=?');
  });
});

// ---------------------------------------------------------------------------
// /telegram:chatid
// ---------------------------------------------------------------------------

describe('tgChatIdCommand', () => {
  it('shows configured chat ID', async () => {
    const cmd = tgChatIdCommand('123456');
    const res = await cmd.run('', null as never);
    expect(res?.message).toContain('123456');
  });

  it('shows message when no chat ID configured', async () => {
    const cmd = tgChatIdCommand(undefined);
    const res = await cmd.run('', null as never);
    expect(res?.message).toContain('No notifyChatId configured');
  });
});
