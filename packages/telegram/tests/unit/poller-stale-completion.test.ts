import type { Logger } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import {
  type TelegramApiClient,
  type TelegramApiUpdate,
  TelegramBotApiError,
} from '../../src/api-client.js';
import { Poller } from '../../src/poller.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fixture(getUpdates: () => Promise<TelegramApiUpdate[]>) {
  const message = vi.fn();
  const callback = vi.fn();
  const write = vi.fn();
  const poller = new Poller({
    api: () => ({ getUpdates, safeBaseUrl: 'fake' }) as unknown as TelegramApiClient,
    pollIntervalMs: 60_000,
    standbyRetryMs: 60_000,
    controller: new AbortController(),
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger,
    offsetStore: { read: () => null, write } as never,
    onMessageUpdate: message,
    onCallbackQuery: callback,
  });
  return { poller, message, callback, write };
}

const update: TelegramApiUpdate = {
  update_id: 12,
  message: { message_id: 1, chat: { id: 1, type: 'private' }, date: 0, text: 'current' },
};

describe('Poller stale completions', () => {
  it.each(['message', 'callback'] as const)(
    'stops the batch when the %s handler stops its owner',
    async (kind) => {
      const gate = deferred<TelegramApiUpdate[]>();
      const f = fixture(() => gate.promise);
      const handler = kind === 'message' ? f.message : f.callback;
      handler.mockImplementation(() => f.poller.stop());
      const pending = f.poller.poll();
      gate.resolve(
        kind === 'message'
          ? [update, { ...update, update_id: 13 }]
          : [12, 13].map((id) => ({
              update_id: id,
              callback_query: { id: `cb${id}`, from: { id: 1, is_bot: false, first_name: 'Test' } },
            })),
      );
      await pending;
      expect(handler).toHaveBeenCalledOnce();
      expect(f.write).not.toHaveBeenCalled();
    },
  );

  it('delivers and persists the current chain as an unaffected control', async () => {
    const f = fixture(async () => [update]);
    await f.poller.poll();
    expect(f.message).toHaveBeenCalledOnce();
    expect(f.write).toHaveBeenCalledWith(13);
  });

  it.each([false, true])(
    'discards a late successful poll after stop, restart=%s',
    async (restart) => {
      const gate = deferred<TelegramApiUpdate[]>();
      const f = fixture(() => gate.promise);
      const pending = f.poller.poll();
      f.poller.stop();
      if (restart) f.poller.start();
      try {
        gate.resolve([
          update,
          {
            update_id: 13,
            callback_query: { id: 'cb', from: { id: 1, is_bot: false, first_name: 'Test' } },
          },
        ]);
        await pending;
        expect(f.message).not.toHaveBeenCalled();
        expect(f.callback).not.toHaveBeenCalled();
        expect(f.write).not.toHaveBeenCalled();
      } finally {
        f.poller.stop();
      }
    },
  );

  it('does not carry a late conflict into the restarted chain', async () => {
    const gate = deferred<TelegramApiUpdate[]>();
    const f = fixture(() => gate.promise);
    const pending = f.poller.poll();
    f.poller.stop();
    f.poller.start();
    try {
      gate.reject(
        new TelegramBotApiError('getUpdates', { errorCode: 409, description: 'conflict' }),
      );
      await pending;
      expect(f.poller.conflictStreak).toBe(0);
    } finally {
      f.poller.stop();
    }
  });
});
