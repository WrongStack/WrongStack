import type { Logger } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import type { TelegramApiClient, TelegramApiUpdate } from '../../src/api-client.js';
import type { TelegramBot } from '../../src/bot.js';
import { TelegramBotOutbound } from '../../src/bot-queue.js';
import type { OffsetStore } from '../../src/offset-store.js';
import { OutboundQueue } from '../../src/outbound-queue.js';
import { Poller } from '../../src/poller.js';

function createSilentLog(debugLog: string[] = []): Logger {
  const log: Logger = {
    level: 'debug',
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn((msg: string) => {
      debugLog.push(msg);
    }),
    trace: vi.fn(),
    child() {
      return log;
    },
  };
  return log;
}

describe('F67 & F68 regressions: OutboundQueue/TelegramBotOutbound abort+stop and Poller offset persistence', () => {
  it('F67: increments dropped on pending abort, detaches abortHandler on dequeue, and aborts rate-limit wait on stop()', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const debugMessages: string[] = [];
    const queue = new OutboundQueue({
      maxPerChat: 4,
      maxConcurrency: 1,
      send: async (_chatId, text, signal) => {
        if (text === 'first') {
          await firstGate;
          return 'ok-first';
        }
        if (text === 'in-flight-abort') {
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('transport aborted')), {
              once: true,
            });
          });
        }
        return 'ok';
      },
      log: createSilentLog(debugMessages),
    });

    const p1 = queue.enqueue({ chatId: '1', text: 'first', kind: 'manual' });
    const pendingAbortCtrl = new AbortController();
    const p2 = queue.enqueue({
      chatId: '1',
      text: 'pending-abort',
      kind: 'manual',
      signal: pendingAbortCtrl.signal,
    });
    pendingAbortCtrl.abort();
    await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
    expect(queue.stats().dropped).toBe(1);

    const inFlightAbortCtrl = new AbortController();
    const p3 = queue.enqueue({
      chatId: '1',
      text: 'in-flight-abort',
      kind: 'manual',
      signal: inFlightAbortCtrl.signal,
    });
    releaseFirst();
    await expect(p1).resolves.toBe('ok-first');
    await new Promise((r) => setTimeout(r, 10));
    inFlightAbortCtrl.abort();
    await expect(p3).rejects.toThrow('transport aborted');
    expect(debugMessages.some((m) => m.includes('notification failed'))).toBe(false);
    await queue.stop();

    const sentAfterStop: string[] = [];
    let stopCalled = false;
    const fakeBot = {
      sendMessage: async (_chatId: string | number, text: string) => {
        if (stopCalled) sentAfterStop.push(text);
        return {
          ok: true as const,
          result: { message_id: 1, date: 0, chat: { id: 77, type: 'private' as const } },
        };
      },
    } as unknown as TelegramBot;

    const outbound = new TelegramBotOutbound({
      bot: fakeBot,
      log: createSilentLog(),
      getRateLimitTokensPerSecond: () => 0.5,
      getRateLimitBurst: () => 1,
    });
    await outbound.sendManual(77, 'burst-1');
    outbound.enqueueNotification(77, 'notif-during-rate-limit');
    await new Promise((r) => setTimeout(r, 10));
    stopCalled = true;
    await outbound.stop();
    expect(sentAfterStop).toEqual([]);
  });

  it('F68: persists already-handled offset on mid-batch stop/lock-loss and retries failed offset write on empty poll', async () => {
    const textUpdate = (updateId: number, text: string): TelegramApiUpdate => ({
      update_id: updateId,
      message: {
        message_id: updateId * 10,
        chat: { id: 99, type: 'private' },
        date: 0,
        text,
      },
    });

    const midBatchSaved: number[] = [];
    const midBatchOffsetsRequested: number[] = [];
    let midBatchPoller!: Poller;
    midBatchPoller = new Poller({
      api: () =>
        ({
          safeBaseUrl: 'https://api.telegram.org/bot<redacted>',
          getUpdates: async (req: { offset: number }) => {
            midBatchOffsetsRequested.push(req.offset);
            return [textUpdate(10, 'first-cmd'), textUpdate(11, 'second-cmd')];
          },
        }) as unknown as TelegramApiClient,
      pollIntervalMs: 1000,
      log: createSilentLog(),
      controller: new AbortController(),
      standbyRetryMs: 1000,
      offsetStore: {
        read: () => null,
        write: (offset: number) => {
          midBatchSaved.push(offset);
        },
        storePath: '',
      } as unknown as OffsetStore,
      onCallbackQuery: () => undefined,
      onMessageUpdate: (msg) => {
        if (msg.text === 'first-cmd') {
          midBatchPoller.stop();
        }
      },
    });
    midBatchPoller.start();
    await midBatchPoller.poll();
    await midBatchPoller.poll();
    expect(midBatchSaved[0]).toBe(11);
    expect(midBatchOffsetsRequested[1]).toBe(11);

    let writeAttempts = 0;
    const retrySaved: number[] = [];
    let pollCall = 0;
    const retryPoller = new Poller({
      api: () =>
        ({
          safeBaseUrl: 'https://api.telegram.org/bot<redacted>',
          getUpdates: async () => {
            pollCall += 1;
            return pollCall === 1 ? [textUpdate(20, 'once')] : [];
          },
        }) as unknown as TelegramApiClient,
      pollIntervalMs: 1000,
      log: createSilentLog(),
      controller: new AbortController(),
      standbyRetryMs: 1000,
      offsetStore: {
        read: () => null,
        write: (offset: number) => {
          writeAttempts += 1;
          if (writeAttempts === 1) {
            throw new Error('EBUSY: transient write error');
          }
          retrySaved.push(offset);
        },
        storePath: '',
      } as unknown as OffsetStore,
      onCallbackQuery: () => undefined,
      onMessageUpdate: () => undefined,
    });
    await retryPoller.poll();
    await retryPoller.poll();
    expect(retrySaved).toEqual([21]);
  });
});
