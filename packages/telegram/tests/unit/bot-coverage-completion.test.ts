import type { Logger } from '@wrongstack/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type TelegramApiCallbackQuery,
  type TelegramApiMessage,
  type TelegramApiUpdate,
  TelegramBotApiError,
  TelegramNetworkError,
} from '../../src/api-client.js';
import { TelegramBot, truncateForTelegram } from '../../src/bot.js';
import type { OffsetStore } from '../../src/offset-store.js';
import type { PollLock } from '../../src/poll-lock.js';

interface BotInternals {
  api: {
    safeBaseUrl: string;
    sendMessage: ReturnType<typeof vi.fn>;
    sendMessageWithKeyboard: ReturnType<typeof vi.fn>;
    getMe: ReturnType<typeof vi.fn>;
    getUpdates: ReturnType<typeof vi.fn>;
    answerCallbackQuery: ReturnType<typeof vi.fn>;
  };
  pollActive: boolean;
  conflictStreak: number;
  acquireAndPoll(): void;
  handleLockLost(): void;
  schedulePoll(): void;
  poll(): Promise<void>;
  processMessage(message: TelegramApiMessage & { text: string }): void;
  settleApproval(
    requestId: string,
    state: 'resolved' | 'expired' | 'cancelled',
    result: { approved: boolean; fromUser: string },
  ): boolean;
  dispatchCallback(callback: TelegramApiCallbackQuery): Promise<void>;
  answerCallback(callbackQueryId: string, text: string, showAlert: boolean): Promise<void>;
  loadOffset(): Promise<void>;
  saveOffset(): Promise<void>;
}

const bots: TelegramBot[] = [];

function makeLog(): Logger {
  return {
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
}

function makeApi() {
  return {
    safeBaseUrl: 'https://api.telegram.org/bot<redacted>',
    sendMessage: vi.fn(),
    sendMessageWithKeyboard: vi.fn(),
    getMe: vi.fn(),
    getUpdates: vi.fn(),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
  };
}

function makeBot(options?: {
  log?: Logger;
  allowedUsers?: string[];
  allowedChats?: string[];
  lock?: PollLock;
  offsetStore?: OffsetStore;
  standbyRetryMs?: number;
}) {
  const bot = new TelegramBot({
    token: 'test:token',
    pollIntervalSec: 1,
    allowedUsers: new Set(options?.allowedUsers ?? []),
    allowedChats: new Set(options?.allowedChats ?? []),
    bufferSize: 2,
    log: options?.log ?? makeLog(),
    onMessage: vi.fn(),
    lock: options?.lock,
    offsetStore: options?.offsetStore,
    standbyRetryMs: options?.standbyRetryMs,
    getParseMode: () => 'HTML',
  });
  bots.push(bot);
  return bot;
}

function internals(bot: TelegramBot): BotInternals {
  return bot as unknown as BotInternals;
}

function installApi(bot: TelegramBot, api = makeApi()) {
  Object.assign(internals(bot), { api });
  return api;
}

function message(overrides: Partial<TelegramApiMessage> = {}): TelegramApiMessage {
  return {
    message_id: 1,
    from: { id: 1, is_bot: false, first_name: 'Ada' },
    chat: { id: 9, type: 'private' },
    date: 1,
    ...overrides,
  };
}

function callback(
  requestId: string,
  overrides: Partial<TelegramApiCallbackQuery> = {},
): TelegramApiCallbackQuery {
  return {
    id: `callback-${requestId}`,
    from: { id: 1, is_bot: false, first_name: 'Ada' },
    message: message({ message_id: 10 }),
    data: `approve:${requestId}:yes`,
    ...overrides,
  };
}

function approval(
  bot: TelegramBot,
  requestId: string,
  options?: {
    signal?: AbortSignal;
    expiresAt?: number;
    expectedUserIds?: readonly number[];
  },
) {
  return bot.awaitApproval({
    requestId,
    sessionId: 'session',
    expectedChatId: 9,
    expectedUserIds: options?.expectedUserIds ?? [1],
    allowGroup: false,
    expiresAt: options?.expiresAt ?? Date.now() + 60_000,
    signal: options?.signal,
  });
}

afterEach(() => {
  for (const bot of bots.splice(0)) bot.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TelegramBot lifecycle completion', () => {
  it('stands by, takes over, and handles lock loss only while active', async () => {
    vi.useFakeTimers();
    let held = false;
    let attempt = 0;
    const lock = {
      get held() {
        return held;
      },
      tryAcquire: vi.fn(() => {
        attempt++;
        if (attempt === 1) return false;
        held = true;
        return true;
      }),
      release: vi.fn(() => {
        held = false;
      }),
      onLost: undefined as (() => void) | undefined,
    } as unknown as PollLock;
    const log = makeLog();
    const bot = makeBot({ lock, log, standbyRetryMs: 5 });
    installApi(bot);

    bot.start();
    bot.start();
    expect(bot.standby).toBe(true);
    await vi.advanceTimersByTimeAsync(5);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('taking over'));

    lock.onLost?.();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('poll lock lost'));
    held = false;
    lock.onLost?.();
    await vi.advanceTimersByTimeAsync(5);
    bot.stop();
    lock.onLost?.();
    internals(bot).acquireAndPoll();
  });

  it('does not schedule when inactive or when the lock is not held', () => {
    const lock = {
      held: false,
      tryAcquire: vi.fn(),
      release: vi.fn(),
    } as unknown as PollLock;
    const bot = makeBot({ lock });
    const inner = internals(bot);

    inner.schedulePoll();
    inner.pollActive = true;
    inner.schedulePoll();
    inner.pollActive = false;
  });
});

describe('TelegramBot outgoing and health completion', () => {
  it('logs a terminal send error after a retry', async () => {
    vi.useFakeTimers();
    const log = makeLog();
    const bot = makeBot({ log });
    const api = installApi(bot);
    api.sendMessage
      .mockRejectedValueOnce(
        new TelegramBotApiError('sendMessage', {
          errorCode: 429,
          description: 'slow down',
          retryAfterSeconds: 0,
        }),
      )
      .mockRejectedValueOnce(
        new TelegramBotApiError('sendMessage', {
          errorCode: 400,
          description: 'bad request',
        }),
      );

    const result = expect(bot.sendMessage(9, 'hello')).rejects.toThrow('bad request');
    await vi.runAllTimersAsync();
    await result;
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('terminal error on attempt 2'));
  });

  it('uses an external signal for keyboard sends and covers retry termination', async () => {
    vi.useFakeTimers();
    const log = makeLog();
    const bot = makeBot({ log });
    const api = installApi(bot);
    const sent = message();
    api.sendMessageWithKeyboard.mockResolvedValueOnce(sent);
    const signal = new AbortController().signal;

    await expect(
      bot.sendMessageWithKeyboard(9, 'approve?', [{ text: 'Yes', callback_data: 'yes' }], signal),
    ).resolves.toEqual({ ok: true, result: sent });

    api.sendMessageWithKeyboard
      .mockRejectedValueOnce(
        new TelegramBotApiError('sendMessage', {
          errorCode: 429,
          description: 'slow down',
          retryAfterSeconds: 0,
        }),
      )
      .mockRejectedValueOnce(
        new TelegramBotApiError('sendMessage', {
          errorCode: 400,
          description: 'bad keyboard',
        }),
      );
    const failed = expect(bot.sendMessageWithKeyboard(9, 'again', [])).rejects.toThrow(
      'bad keyboard',
    );
    await vi.runAllTimersAsync();
    await failed;
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('sendMessageWithKeyboard terminal error on attempt 2'),
    );

    api.sendMessageWithKeyboard.mockRejectedValueOnce(
      new TelegramBotApiError('sendMessage', {
        errorCode: 400,
        description: 'immediate keyboard failure',
      }),
    );
    await expect(bot.sendMessageWithKeyboard(9, 'terminal', [])).rejects.toThrow(
      'immediate keyboard failure',
    );
  });

  it('combines a caller signal for health checks and reports unknown errors', async () => {
    const bot = makeBot();
    const api = installApi(bot);
    api.getMe.mockResolvedValueOnce({ id: 1, is_bot: true, first_name: 'Bot', username: 'bot' });
    await expect(bot.health(new AbortController().signal)).resolves.toEqual({
      ok: true,
      username: 'bot',
    });

    api.getMe.mockRejectedValueOnce(new Error('unexpected'));
    await expect(bot.health()).resolves.toEqual({ ok: false, error: 'unexpected' });
  });

  it('aborts a health request at its local deadline', async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const api = installApi(bot);
    api.getMe.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new TelegramNetworkError('getMe', 'deadline', true)),
          { once: true },
        );
      });
    });

    const result = bot.health();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toEqual({ ok: false, error: 'deadline' });
  });
});

describe('TelegramBot polling completion', () => {
  it('processes callback, edited, textless, and empty update variants', async () => {
    const log = makeLog();
    const store = { read: vi.fn(() => null), write: vi.fn() } as unknown as OffsetStore;
    const bot = makeBot({ log, offsetStore: store });
    const api = installApi(bot);
    const inner = internals(bot);
    const dispatch = vi
      .spyOn(bot.approvals, 'dispatchCallback')
      .mockRejectedValue('callback failure');
    api.getUpdates.mockResolvedValue([
      { update_id: 1, callback_query: callback('missing') },
      { update_id: 2, edited_message: { ...message(), text: 'edited' } },
      { update_id: 3, message: message() },
      { update_id: 4 },
    ] satisfies TelegramApiUpdate[]);

    await inner.poll();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(log.debug).toHaveBeenCalledWith('Callback dispatch failed: callback failure');
    expect(store.write).toHaveBeenCalledWith(5);

    dispatch.mockRejectedValueOnce(new Error('callback error'));
    api.getUpdates.mockResolvedValueOnce([
      { update_id: 5, callback_query: callback('missing-again') },
    ] satisfies TelegramApiUpdate[]);
    await inner.poll();
    await Promise.resolve();
    expect(log.debug).toHaveBeenCalledWith('Callback dispatch failed: callback error');
  });

  it('handles aborted, conflict, and ordinary poll errors', async () => {
    const log = makeLog();
    const bot = makeBot({ log });
    const api = installApi(bot);
    const inner = internals(bot);

    api.getUpdates.mockRejectedValueOnce(new TelegramNetworkError('getUpdates', 'aborted', true));
    await inner.poll();
    const conflict = new TelegramBotApiError('getUpdates', {
      errorCode: 409,
      description: 'conflict',
    });
    api.getUpdates.mockRejectedValue(conflict);
    await inner.poll();
    await inner.poll();
    await inner.poll();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('another instance'));

    api.getUpdates.mockRejectedValueOnce(new Error('ordinary failure'));
    await inner.poll();
    expect(log.debug).toHaveBeenCalledWith('Telegram poll error: ordinary failure');
  });

  it('uses the lock-specific conflict warning and backoff delay', async () => {
    vi.useFakeTimers();
    const log = makeLog();
    const lock = {
      held: true,
      tryAcquire: vi.fn(() => true),
      release: vi.fn(),
    } as unknown as PollLock;
    const bot = makeBot({ log, lock });
    const api = installApi(bot);
    const inner = internals(bot);
    api.getUpdates.mockRejectedValue(
      new TelegramBotApiError('getUpdates', {
        errorCode: 409,
        description: 'conflict',
      }),
    );

    await inner.poll();
    await inner.poll();
    await inner.poll();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('outside this machine'));
    inner.pollActive = true;
    inner.schedulePoll();
    bot.stop();
  });

  it('swallows a non-Error denial-message failure', async () => {
    const log = makeLog();
    const bot = makeBot({ log, allowedUsers: ['allowed'] });
    vi.spyOn(bot, 'sendMessage').mockRejectedValue('send denied');
    internals(bot).processMessage({
      ...message({ from: { id: 2, is_bot: false, first_name: 'Intruder' } }),
      text: 'hello',
    });
    await Promise.resolve();
    expect(log.debug).toHaveBeenCalledWith('Failed to send denial notice: send denied');

    vi.spyOn(bot, 'sendMessage').mockRejectedValueOnce(new Error('blocked'));
    internals(bot).processMessage({
      ...message({ from: { id: 3, is_bot: false, first_name: 'Other' } }),
      text: 'again',
    });
    await Promise.resolve();
    expect(log.debug).toHaveBeenCalledWith('Failed to send denial notice: blocked');
  });
});

describe('TelegramBot approval completion', () => {
  it('rejects empty and duplicate identities and ignores missing settlements', async () => {
    const bot = makeBot();
    expect(() => approval(bot, 'empty', { expectedUserIds: [] })).toThrow(
      'at least one expected user',
    );
    const pending = approval(bot, 'duplicate');
    expect(() => approval(bot, 'duplicate')).toThrow('already pending');
    expect(
      bot.approvals.settleApproval('missing', 'cancelled', {
        approved: false,
        fromUser: 'none',
      }),
    ).toBe(false);
    bot.cancelApproval('duplicate');
    await expect(pending).resolves.toMatchObject({ fromUser: 'cancelled' });
  });

  it('settles pre-aborted and later-aborted requests', async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      approval(makeBot(), 'pre-aborted', { signal: alreadyAborted.signal }),
    ).resolves.toMatchObject({ fromUser: 'aborted' });

    const controller = new AbortController();
    const bot = makeBot();
    const result = approval(bot, 'later-aborted', { signal: controller.signal });
    controller.abort();
    await expect(result).resolves.toMatchObject({ fromUser: 'aborted' });
  });

  it('expires callbacks and rejects each mismatched identity dimension', async () => {
    const bot = makeBot();
    installApi(bot);

    const expired = approval(bot, 'expired', { expiresAt: Date.now() - 1 });
    bot.bindApprovalPrompt('expired', 10);
    await bot.approvals.dispatchCallback(callback('expired'));
    await expect(expired).resolves.toMatchObject({ fromUser: 'timeout' });

    const cases: Array<[string, Partial<TelegramApiCallbackQuery>]> = [
      ['missing-user', { from: undefined }],
      ['wrong-chat', { message: message({ message_id: 10, chat: { id: 8, type: 'private' } }) }],
      ['wrong-user', { from: { id: 2, is_bot: false, first_name: 'Other' } }],
      ['wrong-message', { message: message({ message_id: 11 }) }],
      ['wrong-type', { message: message({ message_id: 10, chat: { id: 9, type: 'group' } }) }],
    ];
    for (const [requestId, overrides] of cases) {
      const pending = approval(bot, requestId);
      bot.bindApprovalPrompt(requestId, 10);
      await bot.approvals.dispatchCallback(callback(requestId, overrides));
      bot.cancelApproval(requestId);
      await pending;
    }
  });

  it('uses first-name and ID fallbacks and handles a lost resolution race', async () => {
    const bot = makeBot();
    installApi(bot);

    const firstName = approval(bot, 'first-name');
    bot.bindApprovalPrompt('first-name', 10);
    await bot.approvals.dispatchCallback(callback('first-name'));
    await expect(firstName).resolves.toMatchObject({ fromUser: 'Ada' });

    const idFallback = approval(bot, 'id-fallback');
    bot.bindApprovalPrompt('id-fallback', 10);
    await bot.approvals.dispatchCallback(
      callback('id-fallback', {
        from: { id: 1, is_bot: false } as TelegramApiCallbackQuery['from'],
      }),
    );
    await expect(idFallback).resolves.toMatchObject({ fromUser: 'user:1' });

    const racing = approval(bot, 'race');
    bot.bindApprovalPrompt('race', 10);
    const flow = bot.approvals as unknown as {
      settleApproval: (typeof bot.approvals)['settleApproval'];
      dispatchCallback: (typeof bot.approvals)['dispatchCallback'];
    };
    const originalSettle = flow.settleApproval.bind(flow);
    Object.assign(flow, { settleApproval: vi.fn(() => false) });
    await flow.dispatchCallback(callback('race'));
    Object.assign(flow, { settleApproval: originalSettle });
    bot.cancelApproval('race');
    await racing;
  });

  it('covers missing data, callback acknowledgement failure, and replay failure', async () => {
    const log = makeLog();
    const bot = makeBot({ log });
    const api = installApi(bot);
    api.answerCallbackQuery.mockRejectedValueOnce('ack failed');
    await bot.approvals.dispatchCallback(callback('none', { data: undefined }));
    expect(log.debug).toHaveBeenCalledWith('answerCallbackQuery failed: undefined');

    expect(bot.bindApprovalPrompt('missing', 1)).toBe(false);
    const pending = approval(bot, 'replay');
    await bot.approvals.dispatchCallback(callback('replay'));
    const flow = bot.approvals as unknown as {
      dispatchCallback: (typeof bot.approvals)['dispatchCallback'];
    };
    const originalDispatch = flow.dispatchCallback.bind(flow);
    Object.assign(flow, { dispatchCallback: vi.fn().mockRejectedValue('replay failed') });
    expect(bot.bindApprovalPrompt('replay', 10)).toBe(true);
    await Promise.resolve();
    expect(log.debug).toHaveBeenCalledWith('Callback dispatch failed: replay failed');
    expect(bot.bindApprovalPrompt('replay', 11)).toBe(false);
    Object.assign(flow, { dispatchCallback: originalDispatch });
    bot.cancelApproval('replay');
    await pending;

    const errorReplay = approval(bot, 'error-replay');
    await flow.dispatchCallback(callback('error-replay'));
    Object.assign(flow, {
      dispatchCallback: vi.fn().mockRejectedValue(new Error('replay error')),
    });
    expect(bot.bindApprovalPrompt('error-replay', 10)).toBe(true);
    await Promise.resolve();
    expect(log.debug).toHaveBeenCalledWith('Callback dispatch failed: replay error');
    Object.assign(flow, { dispatchCallback: originalDispatch });
    bot.cancelApproval('error-replay');
    await errorReplay;
  });
});

describe('TelegramBot persistence and truncation completion', () => {
  it('handles absent and failing offset stores', async () => {
    const plain = makeBot();
    await internals(plain).loadOffset();
    await internals(plain).saveOffset();

    const log = makeLog();
    const store = {
      read: vi.fn(() => {
        throw new Error('bad offset');
      }),
      write: vi.fn(() => {
        throw new Error('disk full');
      }),
    } as unknown as OffsetStore;
    const persisted = makeBot({ log, offsetStore: store });
    await internals(persisted).loadOffset();
    await internals(persisted).saveOffset();
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });

  it('handles a tiny cap and stops scanning sentences past the search window', () => {
    expect(truncateForTelegram('abcdef', 3)).toBe('ab…');
    const text = `${'a'.repeat(35)}. ${'b'.repeat(30)}. trailing`;
    expect(truncateForTelegram(text, 60)).toBe(`${'a'.repeat(35)}.…`);
  });
});
