import {
  Container,
  EventBus,
  type Logger,
  type PluginAPI,
  type SlashCommand,
  type Tool,
} from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_NAME } from '../../src/config.js';
import plugin from '../../src/index.js';

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

/**
 * Build a minimal PluginAPI mock. The plugin needs:
 * - tools registry
 * - slashCommands registry
 * - events bus
 * - config with extensions.telegram section
 */
function makeApi(): PluginAPI {
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
    providers: {
      register: vi.fn(),
      create: vi.fn(),
      list: () => [],
    },
    mcp: {
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      list: () => [],
    },
    slashCommands: {
      register(cmd: SlashCommand) {
        commands.set(cmd.name, cmd);
        commands.set(`${PLUGIN_NAME}:${cmd.name}`, cmd);
        for (const alias of cmd.aliases ?? []) {
          commands.set(alias, cmd);
          commands.set(`${PLUGIN_NAME}:${alias}`, cmd);
        }
      },
      unregister(name: string) {
        const cmd = commands.get(name);
        if (!cmd) return false;
        for (const [key, value] of commands.entries()) {
          if (value === cmd) commands.delete(key);
        }
        return true;
      },
      get(name: string) {
        return commands.get(name);
      },
      list() {
        return Array.from(new Set(commands.values()));
      },
    },
    session: {
      append: vi.fn(),
    },
    metrics: {
      counter: vi.fn(),
      histogram: vi.fn(),
      gauge: vi.fn(),
    },
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
      extensions: {
        [PLUGIN_NAME]: {
          botToken: 'test:t0k3n',
          notifyChatId: '999',
          allowedUsers: [],
          allowedChats: [],
          notifyOnSessionEnd: false,
          longToolThresholdMs: 0,
        },
      },
    },
    log,
  } as never as PluginAPI;
}

// Mock fetch globally so TelegramBot constructor + start don't hit the network
const _originalFetch = globalThis.fetch;

describe('plugin entry', () => {
  beforeEach(() => {
    // Mock fetch to return a successful getMe response for health checks
    // and a getUpdates response that blocks (idle).
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
      // getUpdates — idle, no updates
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: [] }),
      });
    });
  });

  afterEach(() => {
    globalThis.fetch = _originalFetch;
  });

  it('registers tools and slash commands on setup', async () => {
    const api = makeApi();
    await plugin.setup(api);

    expect(api.tools.get('telegram_send')).toBeDefined();
    expect(api.tools.get('telegram_read')).toBeDefined();
    expect(api.slashCommands.get('telegram-health')).toBeDefined();
    expect(api.slashCommands.get('telegram')).toBeDefined();
    expect(api.slashCommands.get('health')).toBeUndefined();
    expect(api.slashCommands.get('status')).toBeUndefined();
    expect(api.slashCommands.get(`${PLUGIN_NAME}:telegram-health`)).toBeDefined();
    expect(api.slashCommands.get(`${PLUGIN_NAME}:telegram`)).toBeDefined();
    expect(api.slashCommands.get(`${PLUGIN_NAME}:status`)).toBeUndefined();
    expect(api.slashCommands.get(`${PLUGIN_NAME}:send`)).toBeDefined();
    expect(api.slashCommands.get(`${PLUGIN_NAME}:chatid`)).toBeDefined();

    // Should emit custom event for incoming messages
    expect(api.emitCustom).not.toHaveBeenCalled(); // no messages yet

    await plugin.teardown?.(api);

    expect(api.tools.get('telegram_send')).toBeUndefined();
    expect(api.tools.get('telegram_read')).toBeUndefined();
    expect(api.slashCommands.get('telegram-health')).toBeUndefined();
    expect(api.slashCommands.get('telegram')).toBeUndefined();
    expect(api.slashCommands.get(`${PLUGIN_NAME}:telegram-health`)).toBeUndefined();
  });

  it('emits telegram:message_received when bot receives a message', async () => {
    makeApi();

    // Mock fetch: first call getMe (constructor health check), then getUpdates with a message
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((_url: string) => {
      callCount++;
      if (callCount === 1) {
        // getMe during health check (called by start?)
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              result: { id: 1, is_bot: true, first_name: 'TestBot', username: 'test_bot' },
            }),
        });
      }
      // getUpdates with a message
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            result: [
              {
                update_id: 100,
                message: {
                  message_id: 1,
                  from: { id: 123, is_bot: false, first_name: 'Alice' },
                  chat: { id: 456, type: 'private' },
                  date: Math.floor(Date.now() / 1000),
                  text: 'Hello agent!',
                },
              },
            ],
          }),
      });
    });

    // Use a very short poll interval so we don't wait long
    const api2 = makeApi();
    (api2.config as Record<string, unknown>).extensions = {
      [PLUGIN_NAME]: {
        botToken: 'test:t0k3n',
        allowedUsers: [],
        pollIntervalSec: 0.01, // very fast
        notifyOnSessionEnd: false,
        longToolThresholdMs: 0,
      },
    };

    await plugin.setup(api2);

    // Wait for polling to catch the message
    await new Promise((r) => setTimeout(r, 100));

    expect(api2.emitCustom).toHaveBeenCalledWith(
      'telegram:message_received',
      expect.objectContaining({
        text: 'Hello agent!',
        chatId: 456,
        userId: 123,
        userName: 'Alice',
      }),
    );

    await plugin.teardown?.(api2);
  });

  it('health returns bot status', async () => {
    const api = makeApi();
    await plugin.setup(api);

    const health = await plugin.health?.();
    expect(health).toBeDefined();
    expect(health!.ok).toBe(true);

    await plugin.teardown?.(api);

    const healthAfter = await plugin.health?.();
    expect(healthAfter!.ok).toBe(false);
    expect(healthAfter!.message).toBe('Plugin not initialized');
  });
});
