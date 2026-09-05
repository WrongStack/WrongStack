import { Container, EventBus } from '@wrongstack/core/kernel';
import type { PluginAPI } from '@wrongstack/core/plugin';
import type { Logger, SlashCommand, Tool } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { PLUGIN_NAME } from '../../src/config.js';
import plugin, { teardownState } from '../../src/index.js';

/**
 * Regression: inbound identity config keys (`inboundMode`, `allowedUsers`,
 * `allowedChats`) are classified `lifecycle: 'hot'` in TELEGRAM_CONFIG_FIELDS
 * and reported as hotApplied by the onConfigChange handler — so they must
 * reach the LIVE inbound gate (bot.inbox), not just the approve-tool gate.
 * Before the fix, the gate's allowlist Sets were built once at setup and a
 * removed user kept being admitted (and bridged to the leader mailbox) until
 * a plugin restart.
 */

const log: Logger = {
  level: 'error',
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child() {
    return this;
  },
};

type TelegramSection = Record<string, unknown>;

function makeApi(telegram: TelegramSection): PluginAPI {
  const tools = new Map<string, Tool>();
  const commands = new Map<string, SlashCommand>();
  return {
    container: new Container(),
    events: new EventBus(),
    pipelines: {},
    tools: {
      register(tool: Tool) {
        tools.set(tool.name, tool);
      },
      unregister(name: string) {
        tools.delete(name);
      },
      get(name: string) {
        return tools.get(name);
      },
      list() {
        return Array.from(tools.values());
      },
      wrap: vi.fn(),
    },
    providers: { register: vi.fn(), create: vi.fn(), list: () => [] },
    mcp: { start: vi.fn(), stop: vi.fn(), restart: vi.fn(), list: () => [] },
    slashCommands: {
      register(cmd: SlashCommand) {
        commands.set(cmd.name, cmd);
        commands.set(`${PLUGIN_NAME}:${cmd.name}`, cmd);
      },
      unregister(name: string) {
        const cmd = commands.get(name);
        if (!cmd) return false;
        for (const [key, value] of commands.entries()) if (value === cmd) commands.delete(key);
        return true;
      },
      get(name: string) {
        return commands.get(name);
      },
      list() {
        return Array.from(new Set(commands.values()));
      },
    },
    session: { append: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    extensions: {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      registerSystemPromptContributor: vi.fn().mockReturnValue(vi.fn()),
    } as never as PluginAPI['extensions'],
    registerSystemPromptContributor: vi.fn().mockReturnValue(vi.fn()),
    onEvent: vi.fn().mockReturnValue(vi.fn()),
    onPattern: vi.fn().mockReturnValue(vi.fn()),
    emitCustom: vi.fn(),
    onConfigChange: vi.fn().mockReturnValue(vi.fn()),
    config: {
      version: 1,
      cwd: process.cwd(),
      plugins: ['@wrongstack/telegram'],
      extensions: { [PLUGIN_NAME]: { ...telegram } },
    },
    log,
  } as never as PluginAPI;
}

const BASE_TELEGRAM: TelegramSection = {
  botToken: 'test:t0k3n',
  notifyChatId: '999',
  allowedOutboundChats: ['111'],
  notifyOnSessionEnd: false,
  longToolThresholdMs: 0,
  // Keep the test hermetic: no cross-process lock file, no offset file.
  singleInstanceLock: false,
  offsetStoragePath: '',
};

function msg(chatId: number, userId: number, messageId: number, text: string) {
  return {
    message_id: messageId,
    from: { id: userId, is_bot: false, first_name: `User${userId}`, username: `user_${userId}` },
    chat: { id: chatId, type: 'private' as const },
    date: Math.floor(Date.now() / 1000),
    text,
  };
}

describe('inbound allowlist hot-reload', () => {
  const originalFetch = globalThis.fetch;
  let api: PluginAPI;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/getMe')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              result: { id: 1, is_bot: true, first_name: 'TestBot', username: 'test_bot' },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: [] }),
      });
    });
  });

  afterEach(async () => {
    await plugin.teardown?.(api);
    globalThis.fetch = originalFetch;
  });

  /**
   * Set the plugin up with `initial`, returning the live bot and a `reload`
   * that fires the captured onConfigChange listener with `next`. Tests send
   * their baseline messages BEFORE calling reload.
   */
  async function setupBot(initial: TelegramSection) {
    api = makeApi(initial);
    await plugin.setup(api);
    const handler = (api.onConfigChange as Mock).mock.calls[0]?.[0] as
      | ((next: unknown, prev: unknown) => void)
      | undefined;
    expect(handler).toBeTypeOf('function');
    const configFrom = (section: TelegramSection) => ({
      version: 1,
      cwd: process.cwd(),
      plugins: [],
      extensions: { [PLUGIN_NAME]: { ...section } },
    });
    return {
      bot: teardownState!.bot,
      reload: (next: TelegramSection) => handler!(configFrom(next), configFrom(initial)),
    };
  }

  it('applies an allowedUsers removal to the live gate (hot key)', async () => {
    const initial = { ...BASE_TELEGRAM, inboundMode: 'allowlist', allowedUsers: ['111', '222'] };
    const { bot, reload } = await setupBot(initial);

    // Baseline: both users admitted pre-change.
    bot.inbox.processMessage(msg(111, 111, 501, 'before reload'));
    bot.inbox.processMessage(msg(222, 222, 502, 'before reload'));
    expect(bot.bufferCount).toBe(2);

    // Hot-reload: remove user 111.
    reload({ ...BASE_TELEGRAM, inboundMode: 'allowlist', allowedUsers: ['222'] });

    // After the hot reload, user 111 is denied; user 222 still admitted.
    bot.inbox.processMessage(msg(111, 111, 503, 'must be rejected'));
    bot.inbox.processMessage(msg(222, 222, 504, 'still allowed'));

    expect(bot.getMessages({ chatId: 111 }).some((m) => m.messageId === 503)).toBe(false);
    expect(bot.getMessages({ chatId: 222 }).some((m) => m.messageId === 504)).toBe(true);
    expect(bot.bufferCount).toBe(3);

    // The rejected message must not be bridged to the host.
    const received = (api.emitCustom as Mock).mock.calls.filter(
      ([event]) => event === 'telegram:message_received',
    );
    expect(received.some(([, payload]) => payload?.messageId === 503)).toBe(false);
  });

  it('applies an inboundMode change to the live gate (hot key)', async () => {
    const initial = { ...BASE_TELEGRAM, inboundMode: 'allowlist', allowedUsers: ['222'] };
    const { bot, reload } = await setupBot(initial);

    // Before the flip the user is admitted.
    bot.inbox.processMessage(msg(222, 222, 601, 'before flip'));
    expect(bot.bufferCount).toBe(1);

    // Hot-reload: disable inbound entirely.
    reload({ ...BASE_TELEGRAM, inboundMode: 'disabled' });

    // inboundMode: 'disabled' → deny-all on the live gate.
    bot.inbox.processMessage(msg(222, 222, 602, 'must be rejected'));
    expect(bot.getMessages({ chatId: 222 }).some((m) => m.messageId === 602)).toBe(false);
    expect(bot.bufferCount).toBe(1);
  });

  it('applies an allowedChats removal to the live gate (hot key)', async () => {
    const initial = {
      ...BASE_TELEGRAM,
      inboundMode: 'allowlist',
      allowedUsers: [],
      allowedChats: ['100'],
    };
    const { bot, reload } = await setupBot(initial);

    // Chat 100 allowed pre-change; user dimension unrestricted.
    bot.inbox.processMessage(msg(100, 999, 701, 'before reload'));
    expect(bot.bufferCount).toBe(1);

    // Hot-reload: allow only chat 200.
    reload({ ...BASE_TELEGRAM, inboundMode: 'allowlist', allowedUsers: [], allowedChats: ['200'] });

    // Chat 100 removed → denied; chat 200 admitted.
    bot.inbox.processMessage(msg(100, 999, 702, 'must be rejected'));
    bot.inbox.processMessage(msg(200, 999, 703, 'still allowed'));
    expect(bot.getMessages({ chatId: 100 }).some((m) => m.messageId === 702)).toBe(false);
    expect(bot.getMessages({ chatId: 200 }).some((m) => m.messageId === 703)).toBe(true);
    expect(bot.bufferCount).toBe(2);
  });
});
