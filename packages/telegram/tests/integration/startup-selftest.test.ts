import { Container, EventBus } from '@wrongstack/core/kernel';
import type { PluginAPI } from '@wrongstack/core/plugin';
import type { Logger, SlashCommand, Tool } from '@wrongstack/core/types';
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
    providers: { register: vi.fn(), create: vi.fn(), list: () => [] },
    mcp: { start: vi.fn(), stop: vi.fn(), restart: vi.fn(), list: () => [] },
    slashCommands: {
      register(cmd: SlashCommand) {
        commands.set(`${PLUGIN_NAME}:${cmd.name}`, cmd);
      },
      unregister(name: string) {
        commands.delete(name);
      },
      get(name: string) {
        return commands.get(name);
      },
      list() {
        return Array.from(commands.values());
      },
    },
    session: { append: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    extensions: {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
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
        [PLUGIN_NAME]: { botToken: 'test:t0k3n', notifyChatId: '999', allowedUsers: [] },
      },
    },
    log,
  } as never as PluginAPI;
}

let _originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  _originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = _originalFetch;
});

describe('plugin startup self-test (C7)', () => {
  it('fails setup when getMe returns 401 Unauthorized', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: false,
          error_code: 401,
          description: 'Unauthorized',
        }),
    }) as never as typeof fetch;

    const api = makeApi();
    await expect(plugin.setup(api)).rejects.toThrow(/Telegram plugin startup failed.*Unauthorized/);
  });

  it('fails setup when getMe returns 403 Forbidden', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: false,
          error_code: 403,
          description: 'Forbidden: bot was blocked by the user',
        }),
    }) as never as typeof fetch;

    const api = makeApi();
    await expect(plugin.setup(api)).rejects.toThrow(/Forbidden/);
  });

  it('fails setup when the network is unreachable', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('ENOTFOUND api.telegram.org')) as never as typeof fetch;

    const api = makeApi();
    await expect(plugin.setup(api)).rejects.toThrow(/ENOTFOUND api\.telegram\.org/);
  });

  it('completes setup when getMe returns ok with a username', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((_url: string) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              result: { id: 1, is_bot: true, first_name: 'TestBot', username: 'test_bot' },
            }),
        });
      }
      // Subsequent calls (polls) return empty.
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: [] }),
      });
    }) as never as typeof fetch;

    const api = makeApi();
    await expect(plugin.setup(api)).resolves.not.toThrow();

    // The self-test log line carries the bot username.
    expect(api.log.info).toHaveBeenCalledWith(expect.stringMatching(/self-test ok.*@test_bot/));

    // The three tools are registered.
    expect(api.tools.get('telegram_send')).toBeDefined();
    expect(api.tools.get('telegram_read')).toBeDefined();
    expect(api.tools.get('telegram_approve')).toBeDefined();

    await plugin.teardown?.(api);
  });
});
