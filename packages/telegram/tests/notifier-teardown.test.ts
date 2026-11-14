import type { PluginAPI } from '@wrongstack/contracts/types/plugin';
import { describe, expect, it } from 'vitest';
import plugin from '../src/index.js';

describe('telegram plugin notifier channel teardown (F197)', () => {
  it('unregisters the telegram notification channel on teardown', async () => {
    const registered = new Map<string, unknown>();
    const api = {
      config: {
        extensions: {
          telegram: {
            enabled: true,
            botToken: '123456:TEST_TOKEN',
            notifyChatId: 12345,
            allowedUserIds: [12345],
            pollingIntervalMs: 60_000,
          },
        },
      },
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      events: { on: () => () => {}, emit: () => {}, once: () => () => {} },
      tools: { register: () => {}, unregister: () => {} },
      registerSystemPromptContributor: () => () => {},
      slashCommands: { register: () => {}, unregister: () => {} },
      onConfigChange: () => () => {},
      notifier: {
        registerChannel: (ch: { name: string }) => {
          registered.set(ch.name, ch);
        },
        unregisterChannel: (name: string) => {
          registered.delete(name);
        },
      },
    } as unknown as PluginAPI;

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/getMe')) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { id: 1, is_bot: true, first_name: 'TestBot', username: 'test_bot' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      await plugin.setup(api);
      expect(registered.has('telegram')).toBe(true);
      await plugin.teardown?.(api);
      expect(registered.has('telegram')).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
