// ---------------------------------------------------------------------------
// P1.6 — Cursor persistence integration tests.
//
// Verifies that the TelegramBot polling loop correctly persists and restores
// the getUpdates offset cursor through the OffsetStore. Tests the P1.6
// invariant: the cursor is committed only after processing a non-empty poll,
// never on empty polls, transport failures, or API errors.
//
// Fixes applied (based on chimera-review findings on the original draft):
//  1. NO assertions inside the mocked fetch callback — poll()'s try/catch
//     swallows throws, making them silent false-greens. All assertions run
//     in the test body after stop().
//  2. Assert raw persisted offset ('42'), not stored+1 ('43'). loadOffset()
//     sets this.offset = saved (no +1), and getUpdates serializes it raw.
//  3. globalThis.fetch is captured in beforeEach and restored in afterEach.
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramBot } from '../../src/bot.js';
import { OffsetStore } from '../../src/offset-store.js';

const silentLog: Logger = {
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

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build a bot with an OffsetStore backed by a temp file. The fetch impl is
 * injected so the test can observe the exact URL/params sent to Telegram.
 */
function makeBot(fetchImpl: typeof fetch, offsetStore: OffsetStore): TelegramBot {
  return new TelegramBot({
    token: 'test:token',
    pollIntervalSec: 0,
    allowedUsers: new Set<string>(),
    allowedChats: new Set<string>(),
    bufferSize: 1,
    log: silentLog,
    fetch: fetchImpl,
    offsetStore,
    onMessage() {},
  });
}

describe('P1.6 cursor — persistence, restore, and commit-on-progress', () => {
  let tempDir: string;
  let offsetPath: string;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'p16-cursor-'));
    offsetPath = join(tempDir, 'offset.json');
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    // FIX #3: restore the real fetch so the mock doesn't leak into other suites.
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------
  // 1. Offset is NOT written on an empty poll (P1.6 invariant)
  // -------------------------------------------------------------------
  describe('commit-on-progress invariant', () => {
    it('does NOT persist the offset when getUpdates returns zero updates', async () => {
      const store = new OffsetStore({ path: offsetPath });
      const spy = vi.spyOn(store, 'write');

      // Capture calls outside the mock so assertions survive poll()'s catch.
      const observedOffsets: string[] = [];

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(typeof input === 'string' ? input : input.toString());
        observedOffsets.push(url.searchParams.get('offset')!);
        return okJson({ ok: true, result: [] });
      }) as never as typeof fetch;

      const bot = makeBot(globalThis.fetch, store);
      bot.start();

      // Wait for at least one poll cycle to complete.
      await new Promise((r) => setTimeout(r, 50));
      bot.stop();

      // No write should have occurred — empty poll must not trigger persistence.
      expect(spy).not.toHaveBeenCalled();
      expect(store.read()).toBeNull();
    });

    it('persists offset = last_update_id + 1 after a non-empty poll', async () => {
      const store = new OffsetStore({ path: offsetPath });

      globalThis.fetch = vi.fn(async () =>
        okJson({
          ok: true,
          result: [
            {
              update_id: 10,
              message: {
                message_id: 100,
                date: Math.floor(Date.now() / 1000),
                chat: { id: 1, type: 'private' },
                from: { id: 1, is_bot: false, first_name: 'test' },
                text: 'hello',
              },
            },
          ],
        }),
      ) as never as typeof fetch;

      const bot = makeBot(globalThis.fetch, store);
      bot.start();

      await new Promise((r) => setTimeout(r, 50));
      bot.stop();

      // update_id=10 → offset becomes 10+1=11, which is persisted.
      expect(store.read()).toBe(11);
    });

    it('persists offset = highest_update_id + 1 when multiple updates arrive in one poll', async () => {
      const store = new OffsetStore({ path: offsetPath });

      let pollCount = 0;
      globalThis.fetch = vi.fn(async () => {
        pollCount++;
        if (pollCount === 1) {
          return okJson({
            ok: true,
            result: [
              {
                update_id: 50,
                message: {
                  message_id: 1,
                  date: Math.floor(Date.now() / 1000),
                  chat: { id: 1, type: 'private' },
                  from: { id: 1, is_bot: false, first_name: 'a' },
                  text: 'a',
                },
              },
              {
                update_id: 51,
                message: {
                  message_id: 2,
                  date: Math.floor(Date.now() / 1000),
                  chat: { id: 1, type: 'private' },
                  from: { id: 1, is_bot: false, first_name: 'b' },
                  text: 'b',
                },
              },
            ],
          });
        }
        return okJson({ ok: true, result: [] });
      }) as never as typeof fetch;

      const bot = makeBot(globalThis.fetch, store);
      bot.start();

      await new Promise((r) => setTimeout(r, 50));
      bot.stop();

      // Highest update_id is 51 → offset becomes 52.
      expect(store.read()).toBe(52);
    });

    it('does NOT persist on transport failure (fetch throws)', async () => {
      const store = new OffsetStore({ path: offsetPath });
      const spy = vi.spyOn(store, 'write');

      globalThis.fetch = vi.fn(async () => {
        throw new TypeError('fetch failed');
      }) as never as typeof fetch;

      const bot = makeBot(globalThis.fetch, store);
      bot.start();

      await new Promise((r) => setTimeout(r, 50));
      bot.stop();

      expect(spy).not.toHaveBeenCalled();
      expect(store.read()).toBeNull();
    });

    it('does NOT persist on Telegram API error (ok: false)', async () => {
      const store = new OffsetStore({ path: offsetPath });
      const spy = vi.spyOn(store, 'write');

      globalThis.fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error_code: 429, description: 'rate' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          }),
      ) as never as typeof fetch;

      const bot = makeBot(globalThis.fetch, store);
      bot.start();

      await new Promise((r) => setTimeout(r, 50));
      bot.stop();

      expect(spy).not.toHaveBeenCalled();
    });

    it('only writes once per non-empty poll, not once per update', async () => {
      const store = new OffsetStore({ path: offsetPath });
      const spy = vi.spyOn(store, 'write');

      let pollCount = 0;
      globalThis.fetch = vi.fn(async () => {
        pollCount++;
        if (pollCount === 1) {
          return okJson({
            ok: true,
            result: [
              {
                update_id: 5,
                message: {
                  message_id: 1,
                  date: Math.floor(Date.now() / 1000),
                  chat: { id: 1, type: 'private' },
                  from: { id: 1, is_bot: false, first_name: 'a' },
                  text: 'x',
                },
              },
              {
                update_id: 6,
                message: {
                  message_id: 2,
                  date: Math.floor(Date.now() / 1000),
                  chat: { id: 1, type: 'private' },
                  from: { id: 1, is_bot: false, first_name: 'b' },
                  text: 'y',
                },
              },
            ],
          });
        }
        return okJson({ ok: true, result: [] });
      }) as never as typeof fetch;

      const bot = makeBot(globalThis.fetch, store);
      bot.start();

      await new Promise((r) => setTimeout(r, 50));
      bot.stop();

      // Exactly one write for the entire non-empty poll, not one per update.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(7); // update_id 6 + 1
    });
  });

  // -------------------------------------------------------------------
  // 2. Offset IS restored on startup from the persisted file (raw, no +1)
  // -------------------------------------------------------------------
  describe('restart replay', () => {
    it('restores the persisted offset on start and sends it raw to getUpdates', async () => {
      // Pre-seed the offset file with 42.
      writeFileSync(offsetPath, '42');

      const store = new OffsetStore({ path: offsetPath });

      // FIX #1: Capture observed offsets outside the mock.
      // poll() wraps everything in try/catch, so an expect() inside the mock
      // is swallowed silently — a hidden false-green. Collect values and
      // assert in the test body instead.
      const observedOffsets: string[] = [];

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(typeof input === 'string' ? input : input.toString());
        observedOffsets.push(url.searchParams.get('offset')!);
        return okJson({ ok: true, result: [] });
      }) as never as typeof fetch;

      const bot = makeBot(globalThis.fetch, store);
      bot.start();

      await new Promise((r) => setTimeout(r, 50));
      bot.stop();

      // FIX #2: Assert raw offset '42', not '43'.
      // loadOffset() sets this.offset = saved (no +1), and getUpdates
      // serializes it as String(opts.offset). The first request offset
      // must be the raw persisted value.
      expect(observedOffsets.length).toBeGreaterThanOrEqual(1);
      expect(observedOffsets[0]).toBe('42');
    });

    it('does NOT increment the restored offset when the poll returns empty', async () => {
      writeFileSync(offsetPath, '99');

      const store = new OffsetStore({ path: offsetPath });

      const observedOffsets: string[] = [];
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(typeof input === 'string' ? input : input.toString());
        observedOffsets.push(url.searchParams.get('offset')!);
        return okJson({ ok: true, result: [] });
      }) as never as typeof fetch;

      const bot = makeBot(globalThis.fetch, store);
      bot.start();

      await new Promise((r) => setTimeout(r, 50));
      bot.stop();

      // Raw offset is sent every cycle; empty polls don't advance it.
      for (const off of observedOffsets) {
        expect(off).toBe('99');
      }
    });

    it('advances past the restored offset after processing new updates', async () => {
      writeFileSync(offsetPath, '20');

      const store = new OffsetStore({ path: offsetPath });

      let pollCount = 0;
      globalThis.fetch = vi.fn(async () => {
        pollCount++;
        if (pollCount === 1) {
          return okJson({
            ok: true,
            result: [
              {
                update_id: 30,
                message: {
                  message_id: 1,
                  date: Math.floor(Date.now() / 1000),
                  chat: { id: 1, type: 'private' },
                  from: { id: 1, is_bot: false, first_name: 'a' },
                  text: 'new',
                },
              },
            ],
          });
        }
        return okJson({ ok: true, result: [] });
      }) as never as typeof fetch;

      const bot = makeBot(globalThis.fetch, store);
      bot.start();

      await new Promise((r) => setTimeout(r, 50));
      bot.stop();

      // First poll sends raw restored offset 20, processes update_id=30,
      // offset becomes 31, persisted. Subsequent polls send 31.
      expect(store.read()).toBe(31);
    });
  });

  // -------------------------------------------------------------------
  // 3. Token never leaks into the offset file or its path
  // -------------------------------------------------------------------
  describe('token safety', () => {
    it('the persisted offset file never contains the bot token', async () => {
      const store = new OffsetStore({ path: offsetPath });

      globalThis.fetch = vi.fn(async () =>
        okJson({
          ok: true,
          result: [
            {
              update_id: 1,
              message: {
                message_id: 1,
                date: Math.floor(Date.now() / 1000),
                chat: { id: 1, type: 'private' },
                from: { id: 1, is_bot: false, first_name: 'a' },
                text: 'x',
              },
            },
          ],
        }),
      ) as never as typeof fetch;

      const bot = makeBot(globalThis.fetch, store);
      bot.start();

      await new Promise((r) => setTimeout(r, 50));
      bot.stop();

      const fileContents = JSON.parse(
        await import('node:fs').then((fs) => fs.readFileSync(offsetPath, 'utf8')),
      );
      // The file should contain just the offset number, never the token.
      expect(typeof fileContents).toBe('number');
      expect(fileContents).toBe(2);
    });
  });
});
