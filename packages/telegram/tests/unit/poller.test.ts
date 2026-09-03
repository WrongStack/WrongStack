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
import type { TelegramApiUpdate } from '../../src/api-client.js';
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
