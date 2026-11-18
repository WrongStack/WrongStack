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
  onCallbackQuery?: (cq: unknown) => void;
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
    onCallbackQuery: opts.onCallbackQuery ?? (() => {}),
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

  // Regression (bug-hunt round 20260907-r4): the callback branch called the
  // handler WITHOUT the poison guard the message path has had since round 17.
  // A sync-throwing onCallbackQuery broke the update loop without advancing
  // the offset, so the callback update was redelivered and re-failed on every
  // poll and every later update stayed blocked behind it.
  it('advances the offset past a callback_query whose handler throws (poison-safety parity)', async () => {
    const processed: string[] = [];
    const callbackUpdate: TelegramApiUpdate = {
      update_id: 10,
      callback_query: { id: 'cb1', data: 'approve:req1:yes' },
    };
    const { poller, getUpdatesOffsets, log } = makePoller({
      updates: [callbackUpdate, textUpdate(11, 'good')],
      onCallbackQuery: () => {
        throw new Error('callback handler exploded');
      },
      onMessageUpdate: (msg) => processed.push(msg.text ?? ''),
    });

    await poller.poll();
    // The callback failure is logged and skipped; the rest of the batch flows.
    expect(processed).toEqual(['good']);
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('Telegram callback handler failed'),
    );

    // The failed callback is acknowledged — the next poll requests offset 12,
    // strictly past it (id 10), so the poison callback is never redelivered.
    // (The double re-sends the raw batch; the Poller's own staleness guard
    // skips update 10 and re-acknowledges 11 — at-least-once, Telegram-normal.)
    await poller.poll();
    expect(getUpdatesOffsets[1]).toBe(12);
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

/**
 * Supersede contract — an in-flight poll that settles after its chain was
 * superseded must not re-arm a second polling chain.
 *
 * Regression (bug-hunt round 2026-09-17-r15): poll()'s `.finally` re-armed
 * schedulePoll() unconditionally. Two supersede events could land while a
 * long poll was still in flight — handleLockLost() followed by a standby
 * re-acquire, and stop() → start() — and the stale poll then re-armed its
 * old chain on top of the successor. Two live getUpdates chains make
 * Telegram 409 ping-pong between them, driving both into CONFLICT_POLL_MS
 * (60s) conflict backoff: message latency collapses from the configured
 * interval to ~60s until process restart. The chain-epoch fence in
 * schedulePoll() now lets a superseded poll's .finally die silently.
 */
describe('Poller supersede contract', () => {
  it.each(['message', 'callback'] as const)(
    'cannot overwrite the new cursor when a %s handler restarts polling',
    async (kind) => {
      vi.useFakeTimers();
      let saved = 0;
      const offsets: number[] = [];
      const writes = vi.fn((offset: number) => {
        saved = offset;
      });
      const update =
        kind === 'message'
          ? textUpdate(1, 'restart')
          : ({ update_id: 1, callback_query: { id: 'fixture' } } as TelegramApiUpdate);
      const restart = () => {
        poller.stop();
        saved = 100;
        poller.start();
      };
      const poller = new Poller({
        api: () =>
          ({
            safeBaseUrl: 'fixture',
            getUpdates: async ({ offset }: { offset: number }) => {
              offsets.push(offset);
              return offsets.length === 1 ? [update] : [];
            },
          }) as never,
        pollIntervalMs: 100,
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
        controller: new AbortController(),
        standbyRetryMs: 100,
        offsetStore: { read: () => saved, write: writes } as never,
        onMessageUpdate: restart,
        onCallbackQuery: restart,
      });
      try {
        poller.start();
        await vi.advanceTimersByTimeAsync(100);
        expect(saved).toBe(100);
        expect(writes).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(100);
        expect(offsets).toEqual([0, 100]);
        expect(vi.getTimerCount()).toBe(1);
      } finally {
        poller.stop();
        vi.useRealTimers();
      }
    },
  );

  function makeSupersedeablePoller() {
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const releases: Array<(updates: TelegramApiUpdate[]) => void> = [];
    const getUpdates = vi.fn(async () => {
      // First call parks like a real long-poll until released; every later
      // call resolves immediately with no updates.
      if (releases.length === 0) {
        return await new Promise<TelegramApiUpdate[]>((resolve) => releases.push(resolve));
      }
      return [];
    });
    const lock = {
      held: false,
      tryAcquire: () => {
        lock.held = true;
        return true;
      },
      onLost: undefined as (() => void) | undefined,
    };
    const poller = new Poller({
      api: () => ({ safeBaseUrl: 'https://api.telegram.org/bot<redacted>', getUpdates }) as never,
      pollIntervalMs: 1000,
      log: log as never,
      controller: new AbortController(),
      standbyRetryMs: 500,
      lock: lock as never,
      onCallbackQuery: () => {},
      onMessageUpdate: () => {},
    });
    return { poller, getUpdates, releases, lock };
  }

  it('lock lost + standby re-acquire mid-poll leaves ONE chain, not two', async () => {
    vi.useFakeTimers();
    const { poller, getUpdates, releases, lock } = makeSupersedeablePoller();
    try {
      poller.start();
      await vi.advanceTimersByTimeAsync(1000); // first tick → poll parks in flight
      expect(getUpdates).toHaveBeenCalledTimes(1);

      lock.held = false;
      lock.onLost!(); // another instance takes the lock
      await vi.advanceTimersByTimeAsync(500); // standby retry re-acquires
      await vi.advanceTimersByTimeAsync(1000); // successor chain polls (resolves [])
      expect(getUpdates).toHaveBeenCalledTimes(2); // successor ran while poll 1 in flight

      releases[0]!([]); // the orphaned long poll finally settles
      await vi.advanceTimersByTimeAsync(0);

      // Pre-fix: the orphan's .finally re-armed a second chain (2 timers).
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(getUpdates).toHaveBeenCalledTimes(5); // 2 + one tick per second
    } finally {
      poller.stop();
      vi.useRealTimers();
    }
  });

  it('aborts the old long poll on lock loss and re-acquires with a live signal', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const getUpdates = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<TelegramApiUpdate[]>((resolve, reject) => {
          signals.push(signal);
          signal.addEventListener(
            'abort',
            () => reject(new TelegramNetworkError('getUpdates', 'aborted', true)),
            { once: true },
          );
          void resolve;
        }),
    );
    const lock = {
      held: false,
      tryAcquire: () => {
        lock.held = true;
        return true;
      },
      onLost: undefined as (() => void) | undefined,
    };
    const poller = new Poller({
      api: () => ({ safeBaseUrl: 'https://api.telegram.org/bot<redacted>', getUpdates }) as never,
      pollIntervalMs: 1000,
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
      controller: new AbortController(),
      standbyRetryMs: 500,
      lock: lock as never,
      onCallbackQuery: () => {},
      onMessageUpdate: () => {},
    });

    try {
      poller.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);

      lock.held = false;
      lock.onLost?.();
      expect(signals[0]?.aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(1500);
      expect(signals).toHaveLength(2);
      expect(signals[1]?.aborted).toBe(false);
    } finally {
      poller.stop();
      vi.useRealTimers();
    }
  });

  it('stop() → start() mid-poll leaves ONE chain, not two', async () => {
    vi.useFakeTimers();
    const { poller, getUpdates, releases } = makeSupersedeablePoller();
    try {
      poller.start();
      await vi.advanceTimersByTimeAsync(1000); // poll parks in flight
      expect(getUpdates).toHaveBeenCalledTimes(1);

      poller.stop();
      poller.start(); // restart arms the successor chain

      releases[0]!([]); // the pre-restart poll settles after the restart
      await vi.advanceTimersByTimeAsync(0);

      expect(vi.getTimerCount()).toBe(1); // pre-fix: 2
      await vi.advanceTimersByTimeAsync(3000);
      expect(getUpdates).toHaveBeenCalledTimes(4); // 1 + one tick per second
    } finally {
      poller.stop();
      vi.useRealTimers();
    }
  });
});
