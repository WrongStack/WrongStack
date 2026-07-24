import type { Logger } from '@wrongstack/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramBot } from '../../src/bot.js';
import type { TelegramPluginConfig } from '../../src/config.js';
import {
  registerSlashCommands,
  tgChatIdCommand,
  tgHealthCommand,
  tgSendCommand,
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
  it('uses the queue-backed sender when supplied', async () => {
    const outbound = {
      sendManual: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 55 } }),
    };
    const command = tgSendCommand(
      makeBot(),
      {
        getDefaultChatId: () => '999',
        getMaxMessageLength: () => 20,
      },
      outbound as never,
    );
    const result = await command.run('x'.repeat(100), null as never);
    expect(outbound.sendManual).toHaveBeenCalledWith('999', expect.stringMatching(/^x+…$/));
    expect(result?.message).toContain('msg_id=55');

    outbound.sendManual.mockResolvedValueOnce({ ok: true, result: undefined });
    const withoutId = await command.run('again', null as never);
    expect(withoutId?.message).toContain('msg_id=?');
  });

  it('shows usage when no args', async () => {
    const bot = makeBot();
    const cmd = tgSendCommand(bot, '999');
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('Usage:');
  });

  it('sends with an explicitly allowed chat_id in args', async () => {
    const bot = makeBot();
    const sendSpy = vi.fn().mockResolvedValue({
      ok: true,
      result: { message_id: 42, chat: { id: 123, type: 'private' } },
    });
    bot.sendMessage = sendSpy;

    const cmd = tgSendCommand(bot, {
      getDefaultChatId: () => '999',
      getAllowedOutboundChatIds: () => ['123456'],
    });
    const res = await cmd.run('123456 Hello world!', null as never);

    expect(sendSpy).toHaveBeenCalledWith('123456', 'Hello world!');
    expect(res?.message).toContain('✅');
    expect(res?.message).toContain('123456');
    expect(res?.message).toContain('msg_id=42');
  });

  it('rejects an untrusted explicit chat_id before any bot call', async () => {
    const bot = makeBot();
    const sendSpy = vi.fn();
    bot.sendMessage = sendSpy;

    const cmd = tgSendCommand(bot, {
      getDefaultChatId: () => '999',
      getAllowedOutboundChatIds: () => ['123456'],
    });
    const res = await cmd.run('222222 Do not send', null as never);

    expect(res?.message).toContain('not paired or included in allowedOutboundChats');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('supports a trusted negative supergroup chat_id', async () => {
    const bot = makeBot();
    const sendSpy = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 9 } });
    bot.sendMessage = sendSpy;

    const cmd = tgSendCommand(bot, {
      getDefaultChatId: () => '999',
      getAllowedOutboundChatIds: () => ['-100123'],
    });
    await cmd.run('-100123 Release complete', null as never);

    expect(sendSpy).toHaveBeenCalledWith('-100123', 'Release complete');
  });

  it('scrubs credentials before slash-command sends', async () => {
    const bot = makeBot();
    const sendSpy = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 10 } });
    bot.sendMessage = sendSpy;
    const raw = `sk-${'z'.repeat(24)}`;

    const cmd = tgSendCommand(bot, '999');
    await cmd.run(`Credential ${raw}; TOKEN=SLASH_SECRET_CANARY_DDD`, null as never);

    const sent = String(sendSpy.mock.calls[0]?.[1]);
    expect(sent).not.toContain(raw);
    expect(sent).not.toContain('SLASH_SECRET_CANARY_DDD');
    expect(sent).toContain('[REDACTED');
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

describe('registerSlashCommands', () => {
  it('registers all commands and resolves live config through policy callbacks', async () => {
    const registered: Array<{ name: string; run: (...args: never[]) => Promise<unknown> }> = [];
    const api = {
      slashCommands: {
        register(command: (typeof registered)[number]) {
          registered.push(command);
        },
      },
    };
    const bot = makeBot();
    bot.sendMessage = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } });
    const names = registerSlashCommands(
      api as never,
      bot,
      makeConfig({
        allowedOutboundChats: undefined,
        maxMessageLength: undefined,
      }),
    );
    expect(names).toEqual(['telegram-health', 'send', 'chatid']);
    const send = registered.find((command) => command.name === 'send')!;
    await send.run('registered message' as never, null as never);
    expect(bot.sendMessage).toHaveBeenCalled();
  });
});
