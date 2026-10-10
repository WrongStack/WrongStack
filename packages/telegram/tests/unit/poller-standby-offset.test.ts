import * as testNodeFs from 'node:fs';
/**
 * Regression: a standby Poller loaded the shared OffsetStore only in its
 * constructor. When it took over the poll lock it polled with that stale
 * offset, and the previous holder's last batch — never confirmed to Telegram,
 * because that holder stopped before its next getUpdates — was delivered a
 * second time. acquireAndPoll() now reloads the store, and the offset only
 * ever moves forward.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelegramApiClient, TelegramApiUpdate } from '../../src/api-client.js';
import { OffsetStore } from '../../src/offset-store.js';
import { PollLock } from '../../src/poll-lock.js';
import { Poller } from '../../src/poller.js';

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

function textUpdate(id: number): TelegramApiUpdate {
  return {
    update_id: id,
    message: { message_id: id, date: 0, chat: { id: 1, type: 'private' }, text: `prompt ${id}` },
  } as unknown as TelegramApiUpdate;
}

/** Telegram's rule: an update is confirmed once getUpdates asks for a higher offset. */
function fakeTelegram(updates: TelegramApiUpdate[]) {
  let confirmedBelow = 0;
  return (offsets: number[]) => {
    const api = {
      safeBaseUrl: 'fake',
      getUpdates: async (req: { offset: number }) => {
        offsets.push(req.offset);
        confirmedBelow = Math.max(confirmedBelow, req.offset);
        return updates.filter((u) => u.update_id >= confirmedBelow);
      },
    } as unknown as TelegramApiClient;
    return () => api;
  };
}

function makePoller(opts: {
  api: () => TelegramApiClient;
  offsetPath: string;
  lock?: PollLock;
  onMessage: (id: number) => void;
}): Poller {
  return new Poller({
    api: opts.api,
    pollIntervalMs: 5,
    log,
    controller: new AbortController(),
    offsetStore: new OffsetStore({ path: opts.offsetPath }),
    ...(opts.lock ? { lock: opts.lock } : {}),
    standbyRetryMs: 20,
    onCallbackQuery: () => {},
    onMessageUpdate: (m) => opts.onMessage(m.message_id),
  });
}

describe('Poller standby takeover offset', () => {
  let dir: string;
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
    rmSync(dir, { recursive: true, force: true });
  });

  it('polls from the offset the previous holder persisted, not the one read at construction', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tg-standby-'));
    const offsetPath = join(dir, 'offset.json');
    const lockPath = join(dir, 'poll.lock');
    const telegram = fakeTelegram([textUpdate(1), textUpdate(2), textUpdate(3)]);
    const offsetsB: number[] = [];
    const seenA: number[] = [];
    const seenB: number[] = [];
    const lockA = new PollLock(lockPath, { heartbeatMs: 1_000, staleMs: 3_000 });
    const lockB = new PollLock(lockPath, { heartbeatMs: 1_000, staleMs: 3_000 });
    const a: Poller = makePoller({
      api: telegram([]),
      offsetPath,
      lock: lockA,
      onMessage: (id) => {
        seenA.push(id);
        // A shuts down right after its batch, before a confirming getUpdates.
        if (id === 3)
          setTimeout(() => {
            a.stop();
            lockA.release();
          }, 0);
      },
    });
    const b = makePoller({
      api: telegram(offsetsB),
      offsetPath,
      lock: lockB,
      onMessage: (id) => seenB.push(id),
    });
    cleanups.push(() => {
      a.stop();
      b.stop();
      lockA.release();
      lockB.release();
    });

    a.start();
    b.start(); // lock held by A -> standby
    await vi.waitFor(() => expect(offsetsB.length).toBeGreaterThan(0), { timeout: 2_000 });

    expect(seenA).toEqual([1, 2, 3]);
    expect(offsetsB[0]).toBe(4);
    expect(seenB).toEqual([]);
  });

  it('never moves the offset backwards when the store holds an older value', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tg-standby-'));
    const offsetPath = join(dir, 'offset.json');
    writeFileSync(offsetPath, '5');
    const offsets: number[] = [];
    const poller = makePoller({
      api: fakeTelegram([textUpdate(9)])(offsets),
      offsetPath,
      onMessage: () => {},
    });
    cleanups.push(() => poller.stop());

    poller.start();
    await vi.waitFor(() => expect(offsets.length).toBeGreaterThan(1), { timeout: 2_000 });
    poller.stop();
    writeFileSync(offsetPath, '5'); // an older value reappears in the store
    offsets.length = 0;
    poller.start();
    await vi.waitFor(() => expect(offsets.length).toBeGreaterThan(0), { timeout: 2_000 });

    expect(offsets[0]).toBe(10);
  });

  it('holds polling instead of replaying the handled batch while the saved offset is unreadable', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tg-standby-'));
    const offsetPath = join(dir, 'offset.json');
    writeFileSync(offsetPath, '3'); // the previous owner handled 1 and 2
    const offsets: number[] = [];
    const seen: number[] = [];
    // A transient lock (e.g. AV scanning the freshly renamed file) used to read
    // as "no offset", so polling restarted at 0 and re-ran both commands.
    const nodeFs = testNodeFs as typeof import('node:fs');
    let nodeFs_readFileSync_spy: { mockRestore(): void } | undefined;
    const realReadFileSync = nodeFs.readFileSync;
    nodeFs_readFileSync_spy = vi.spyOn(nodeFs, 'readFileSync').mockImplementation(((
      p: Parameters<typeof realReadFileSync>[0],
      ...rest: unknown[]
    ) => {
      if (String(p) === offsetPath) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return (realReadFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof realReadFileSync);

    let poller: Poller;
    try {
      poller = makePoller({
        api: fakeTelegram([textUpdate(1), textUpdate(2)])(offsets),
        offsetPath,
        onMessage: (id) => seen.push(id),
      });
      await poller.poll();
    } finally {
      nodeFs_readFileSync_spy?.mockRestore();
    }
    expect(offsets).toEqual([]);

    await poller.poll();
    expect(offsets).toEqual([3]);
    expect(seen).toEqual([]);
  });
});

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));
