/**
 * Poller unit tests — the offset-advance contract of the long-poll loop.
 *
 * Regression (bug-hunt round 17): a message whose onMessageUpdate handler
 * throws used to break the update loop WITHOUT advancing the offset. Since
 * Telegram redelivers every update at/after the requested offset, the poison
 * update was re-fetched and re-failed on every poll forever, and every later
 * update — in the same batch and all future ones — was blocked behind it.
 * The stuck offset was also persisted via saveOffset, so a restart re-wedged
 * the bot. The loop now logs the failure, acknowledges the failed update
 * (offset advances), and keeps processing the batch.
 */
import { describe, expect, it, vi } from 'vitest';
import { type TelegramApiUpdate, TelegramNetworkError } from '../../src/api-client.js';
import { Poller } from '../../src/poller.js';

function makePoller(opts: {
  updates: TelegramApiUpdate[];
  onMessageUpdate?: (msg: { text?: string | undefined }) => void;
  savedOffsets?: number[];
}) {
  const getUpdatesOffsets: number[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const api = () =>
    ({
      safeBaseUrl: 'https://api.telegram.org/bot<redacted>',
      getUpdates: vi.fn(async (req: { offset: number }) => {
        getUpdatesOffsets.push(req.offset);
        return opts.updates;
      }),
    }) as never;
  const poller = new Poller({
    api,
    pollIntervalMs: 1000,
    log: log as never,
    controller: new AbortController(),
    standbyRetryMs: 1000,
    onCallbackQuery: () => {},
    onMessageUpdate: (opts.onMessageUpdate ?? (() => {})) as never,
    ...(opts.savedOffsets
      ? {
          offsetStore: {
            read: () => null,
            write: (offset: number) => {
              opts.savedOffsets?.push(offset);
            },
            storePath: '',
          } as never,
        }
      : {}),
  });
  return { poller, getUpdatesOffsets, log };
}

function textUpdate(updateId: number, text: string): TelegramApiUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      chat: { id: 99, type: 'private' },
      date: 0,
      text,
    },
  } as TelegramApiUpdate;
}

describe('Poller offset contract', () => {
  it('processes the batch tail and advances the offset past a message whose handler throws', async () => {
    const processed: string[] = [];
    const { poller, getUpdatesOffsets, log } = makePoller({
      updates: [textUpdate(1, 'poison'), textUpdate(2, 'good')],
      onMessageUpdate: (msg) => {
        if (msg.text === 'poison') throw new Error('handler exploded');
        processed.push(msg.text ?? '');
      },
    });

    await poller.poll();
    // The failure is logged and skipped, the rest of the batch is processed.
    expect(processed).toEqual(['good']);
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('Telegram processMessage failed'),
    );

    // The poison update is acknowledged — the next poll starts past it, so
    // it is never redelivered.
    await poller.poll();
    expect(getUpdatesOffsets[1]).toBe(3);
  });

  it('persists the advanced offset even when a handler failed mid-batch', async () => {
    const savedOffsets: number[] = [];
    const { poller } = makePoller({
      updates: [textUpdate(5, 'poison'), textUpdate(6, 'good')],
      onMessageUpdate: (msg) => {
        if (msg.text === 'poison') throw new Error('handler exploded');
      },
      savedOffsets,
    });

    await poller.poll();
    // Offset 7 = past update 6. Persisting anything older would re-wedge the
    // bot on the poison update after a restart.
    expect(savedOffsets).toEqual([7]);
  });

  it('still skips updates older than the current offset and advances past textless updates', async () => {
    const processed: string[] = [];
    const { poller, getUpdatesOffsets } = makePoller({
      updates: [
        { update_id: 3 } as TelegramApiUpdate, // no message — acknowledged, not processed
        textUpdate(4, 'hello'),
      ],
      onMessageUpdate: (msg) => processed.push(msg.text ?? ''),
    });

    await poller.poll();
    expect(processed).toEqual(['hello']);
    await poller.poll();
    expect(getUpdatesOffsets[1]).toBe(5);
  });
});

/**
 * Restart contract — `start()` must be re-enterable after `stop()`.
 *
 * `stop()` aborts the injected AbortController to cancel any in-flight
 * long-poll. A restart that reused the aborted controller would put an
 * already-aborted signal on every future getUpdates: each poll rejects,
 * poll() swallows the abort silently (`err.aborted → return`), and the loop
 * zombies forever while `active === true` — no updates, no errors, until the
 * process restarts.
 */
describe('Poller restart contract', () => {
  function makeRestartablePoller() {
    const calls: Array<{ aborted: boolean; offset: number }> = [];
    const delivered: string[] = [];
    let nextUpdateId = 1;
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const api = () =>
      ({
        safeBaseUrl: 'https://api.telegram.org/bot<redacted>',
        getUpdates: async (req: { offset: number; signal?: AbortSignal }) => {
          const aborted = req.signal?.aborted === true;
          calls.push({ aborted, offset: req.offset });
          // Real-client contract: an already-aborted signal rejects immediately.
          if (aborted) throw new TelegramNetworkError('getUpdates', 'aborted before fetch', true);
          const id = nextUpdateId++;
          return [
            {
              update_id: id,
              message: {
                message_id: id * 10,
                chat: { id: 99, type: 'private' },
                date: 0,
                text: `m${id}`,
              },
            },
          ] as TelegramApiUpdate[];
        },
      }) as never;
    const poller = new Poller({
      api,
      pollIntervalMs: 10,
      log: log as never,
      controller: new AbortController(),
      standbyRetryMs: 1000,
      onCallbackQuery: () => {},
      onMessageUpdate: (msg) => delivered.push((msg as { text: string }).text),
    });
    return { poller, calls, delivered };
  }

  const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  it('start() after stop() resumes polling with a live signal', async () => {
    const { poller, calls, delivered } = makeRestartablePoller();
    try {
      poller.start();
      await tick(60);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls.every((c) => !c.aborted)).toBe(true);
      expect(delivered.length).toBeGreaterThanOrEqual(1);

      poller.stop();
      await tick(20); // let any in-flight poll settle its finally-chain
      const callsAtStop = calls.length;
      const deliveredBeforeRestart = delivered.length;
      poller.start(); // restart the SAME instance
      await tick(60);

      const postRestart = calls.slice(callsAtStop);
      expect(postRestart.length).toBeGreaterThanOrEqual(1);
      // Pre-fix: every post-restart call carried the stop()ed (aborted) signal,
      // so each poll rejected silently and no update was ever delivered again.
      expect(postRestart.every((c) => !c.aborted)).toBe(true);
      expect(delivered.length).toBeGreaterThan(deliveredBeforeRestart);
    } finally {
      poller.stop();
    }
  });

  it('stop() halts the loop — no further getUpdates calls after stopping', async () => {
    const { poller, calls } = makeRestartablePoller();
    try {
      poller.start();
      await tick(40);
      expect(poller.active).toBe(true);
      poller.stop();
      const callsAtStop = calls.length;
      await tick(40);
      expect(poller.active).toBe(false);
      expect(calls.length).toBe(callsAtStop);
    } finally {
      poller.stop();
    }
  });
});
