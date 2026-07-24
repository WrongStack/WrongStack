import { describe, expect, it, vi } from 'vitest';
import {
  abortableSleep,
  buildTelegramBotApiBaseUrl,
  classifyRetry,
  TelegramApiClient,
  TelegramBotApiError,
  TelegramHttpError,
  TelegramNetworkError,
  TelegramResponseParseError,
} from '../../src/api-client.js';

const TOKEN = '123456:super-secret-token';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('TelegramApiClient', () => {
  it('uses global fetch when no override is provided', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ ok: true, result: { id: 1, is_bot: true, first_name: 'Bot' } }),
      );
    try {
      await expect(new TelegramApiClient({ token: TOKEN }).getMe()).resolves.toMatchObject({
        id: 1,
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('builds one canonical Bot API base URL and exposes only its redacted form', () => {
    expect(buildTelegramBotApiBaseUrl(TOKEN, 'https://telegram.test///')).toBe(
      `https://telegram.test/bot${TOKEN}`,
    );

    const client = new TelegramApiClient({ token: TOKEN, apiRoot: 'https://telegram.test/' });
    expect(client.safeBaseUrl).toBe('https://telegram.test/bot[REDACTED]');
    expect(client.safeBaseUrl).not.toContain(TOKEN);
  });

  it('performs a typed GET for getUpdates with encoded query parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        result: [{ update_id: 7 }],
      }),
    );
    const client = new TelegramApiClient({ token: TOKEN, fetch: fetchMock });

    await expect(client.getUpdates({ offset: 4, timeoutSeconds: 10 })).resolves.toEqual([
      { update_id: 7 },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=4&timeout=10`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('performs a typed JSON POST for sendMessage', async () => {
    const result = {
      message_id: 42,
      chat: { id: 99, type: 'private' },
      date: 1_700_000_000,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result }));
    const client = new TelegramApiClient({ token: TOKEN, fetch: fetchMock });

    await expect(client.sendMessage(99, 'hello')).resolves.toEqual(result);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: '99',
      text: 'hello',
      disable_web_page_preview: true,
    });
  });

  it('adds parse mode, keyboard payloads, callback answers, and composed signals', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 2 } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: [] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: [] }));
    const client = new TelegramApiClient({ token: TOKEN, fetch: fetchMock });
    const controller = new AbortController();

    await client.sendMessage(1, 'formatted', { parseMode: 'HTML', signal: controller.signal });
    await client.sendMessageWithKeyboard(1, 'choose', [{ text: 'Yes', callback_data: 'yes' }], {
      parseMode: 'MarkdownV2',
      signal: controller.signal,
    });
    await client.answerCallbackQuery('callback', 'done', false, { signal: controller.signal });
    await client.getUpdates({
      offset: 0,
      timeoutSeconds: 1,
      signal: controller.signal,
      deadlineMs: 1_000,
    });
    await client.getUpdates({ offset: 0, timeoutSeconds: 1, deadlineMs: 1_000 });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      parse_mode: 'HTML',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: [[{ text: 'Yes', callback_data: 'yes' }]] },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      callback_query_id: 'callback',
    });
    expect(fetchMock.mock.calls[3]?.[1]?.signal).toBeDefined();
    expect(fetchMock.mock.calls[4]?.[1]?.signal).toBeDefined();

    const plainKeyboard = new TelegramApiClient({
      token: TOKEN,
      fetch: vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 3 } })),
    });
    await plainKeyboard.sendMessageWithKeyboard(1, 'plain', []);
  });

  it('distinguishes an HTTP failure without exposing the token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 502, statusText: `upstream ${TOKEN}` }));
    const client = new TelegramApiClient({ token: TOKEN, fetch: fetchMock });

    const error = await client.getMe().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramHttpError);
    expect(error).toMatchObject({ kind: 'http', method: 'getMe', status: 502 });
    expect((error as Error).message).toContain('[REDACTED]');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('distinguishes malformed JSON and a malformed Bot API envelope', async () => {
    const malformedJson = new TelegramApiClient({
      token: TOKEN,
      fetch: vi.fn().mockResolvedValue(
        new Response('{not-json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    });
    await expect(malformedJson.getMe()).rejects.toMatchObject({
      kind: 'parse',
      method: 'getMe',
    });

    const malformedEnvelope = new TelegramApiClient({
      token: TOKEN,
      fetch: vi.fn().mockResolvedValue(jsonResponse({ result: {} })),
    });
    await expect(malformedEnvelope.getMe()).rejects.toBeInstanceOf(TelegramResponseParseError);
  });

  it('classifies malformed and contradictory non-OK envelopes', async () => {
    const invalidEnvelope = new TelegramApiClient({
      token: TOKEN,
      fetch: vi.fn().mockResolvedValue(jsonResponse([], { status: 500 })),
    });
    await expect(invalidEnvelope.getMe()).rejects.toBeInstanceOf(TelegramHttpError);

    const contradictory = new TelegramApiClient({
      token: TOKEN,
      fetch: vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: {} }, { status: 500 })),
    });
    await expect(contradictory.getMe()).rejects.toBeInstanceOf(TelegramHttpError);

    for (const result of [undefined, null]) {
      const missingResult = new TelegramApiClient({
        token: TOKEN,
        fetch: vi.fn().mockResolvedValue(jsonResponse({ ok: true, result })),
      });
      await expect(missingResult.getMe()).rejects.toBeInstanceOf(TelegramResponseParseError);
    }
  });

  it('uses default API error descriptions and supports unknown error codes', async () => {
    const client = new TelegramApiClient({
      token: TOKEN,
      fetch: vi.fn().mockResolvedValue(jsonResponse({ ok: false })),
    });
    const error = await client.getMe().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramBotApiError);
    expect((error as TelegramBotApiError).description).toBe('Unknown Bot API error');
    expect((error as Error).message).toContain('unknown');
  });

  it('preserves typed Bot API metadata while redacting its description', async () => {
    const client = new TelegramApiClient({
      token: TOKEN,
      fetch: vi.fn().mockResolvedValue(
        jsonResponse(
          {
            ok: false,
            error_code: 429,
            description: `rate limited for ${TOKEN}`,
            parameters: { retry_after: 12, migrate_to_chat_id: -10042 },
          },
          { status: 429 },
        ),
      ),
    });

    const error = await client.sendMessage(99, 'hello').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramBotApiError);
    expect(error).toMatchObject({
      kind: 'api',
      method: 'sendMessage',
      errorCode: 429,
      retryAfterSeconds: 12,
      migrateToChatId: -10042,
      description: 'rate limited for [REDACTED]',
    });
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('distinguishes network failures and redacts token-bearing details', async () => {
    const client = new TelegramApiClient({
      token: TOKEN,
      fetch: vi.fn().mockRejectedValue(new Error(`connect failed at /bot${TOKEN}`)),
    });

    const error = await client.getMe().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramNetworkError);
    expect(error).toMatchObject({ kind: 'network', method: 'getMe', aborted: false });
    expect((error as TelegramNetworkError).detail).toContain('[REDACTED]');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('marks AbortError as an aborted network failure', async () => {
    const abort = new Error(`aborted ${TOKEN}`);
    abort.name = 'AbortError';
    const client = new TelegramApiClient({
      token: TOKEN,
      fetch: vi.fn().mockRejectedValue(abort),
    });

    await expect(client.getUpdates({ offset: 0, timeoutSeconds: 10 })).rejects.toMatchObject({
      kind: 'network',
      method: 'getUpdates',
      aborted: true,
      detail: 'aborted [REDACTED]',
    });
  });

  it('stringifies non-Error network failures', async () => {
    const client = new TelegramApiClient({
      token: TOKEN,
      fetch: vi.fn().mockRejectedValue('offline'),
    });
    await expect(client.getMe()).rejects.toMatchObject({ detail: 'offline', aborted: false });
  });
});

describe('abortableSleep', () => {
  it('sleeps without a signal and rejects an already-aborted signal', async () => {
    vi.useFakeTimers();
    try {
      const sleep = abortableSleep(10);
      await vi.advanceTimersByTimeAsync(10);
      await expect(sleep).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(10, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('cancels an active sleep when its signal aborts', async () => {
    const controller = new AbortController();
    const sleep = abortableSleep(10_000, controller.signal);
    controller.abort();
    await expect(sleep).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('removes its abort listener after resolving normally', async () => {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const signal = {
      aborted: false,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.delete(listener);
      },
    } as unknown as AbortSignal;

    await abortableSleep(1, signal);

    expect(listeners.size).toBe(0);
  });
});

describe('classifyRetry', () => {
  it('formats errors without optional status text and retries unknown API codes', () => {
    expect(new TelegramHttpError('getMe', 500).message).toBe(
      'Telegram HTTP error during getMe: 500',
    );
    expect(
      classifyRetry(new TelegramBotApiError('getMe', { description: 'unknown code' }), 1).retry,
    ).toBe(true);
    expect(
      classifyRetry(
        new TelegramBotApiError('getMe', { errorCode: 409, description: 'conflict' }),
        1,
      ).retry,
    ).toBe(true);
    expect(
      classifyRetry(
        new TelegramBotApiError('getMe', { errorCode: 300, description: 'redirect' }),
        1,
      ).retry,
    ).toBe(true);
  });

  it('does not retry when attempt >= 3', () => {
    expect(classifyRetry(new Error('any'), 3)).toEqual({ retry: false, delayMs: 0 });
    expect(classifyRetry(new Error('any'), 4)).toEqual({ retry: false, delayMs: 0 });
  });

  it('does not retry terminal HTTP 4xx, parse errors, or aborted network calls', () => {
    expect(classifyRetry(new TelegramHttpError('sendMessage', 403, 'Forbidden'), 1)).toEqual({
      retry: false,
      delayMs: 0,
    });
    expect(classifyRetry(new TelegramResponseParseError('sendMessage', 'invalid JSON'), 1)).toEqual(
      {
        retry: false,
        delayMs: 0,
      },
    );
    expect(classifyRetry(new TelegramNetworkError('sendMessage', 'aborted', true), 1)).toEqual({
      retry: false,
      delayMs: 0,
    });
  });

  it('retries non-envelope HTTP 5xx gateway failures with bounded backoff', () => {
    const decision = classifyRetry(new TelegramHttpError('sendMessage', 502, 'Bad Gateway'), 1);
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBeGreaterThanOrEqual(1_000);
    expect(decision.delayMs).toBeLessThanOrEqual(1_200);
  });

  it('retries non-envelope HTTP 429 and 409 responses', () => {
    expect(
      classifyRetry(new TelegramHttpError('sendMessage', 429, 'Too Many Requests'), 1).retry,
    ).toBe(true);
    expect(classifyRetry(new TelegramHttpError('sendMessage', 409, 'Conflict'), 1).retry).toBe(
      true,
    );
  });

  it('does not retry 4xx Bot API errors other than 429 and 409', () => {
    const make = (code: number, desc = 'error') =>
      new TelegramBotApiError('sendMessage', { errorCode: code, description: desc });
    for (const code of [400, 401, 403, 404, 405, 422, 500]) {
      const decision = classifyRetry(make(code), 1);
      if (code >= 500) {
        expect(decision.retry).toBe(true);
      } else if (code !== 429 && code !== 409) {
        expect(decision.retry).toBe(false);
      }
    }
  });

  it('retries 429 with retry_after-based delay', () => {
    const decision = classifyRetry(
      new TelegramBotApiError('sendMessage', {
        errorCode: 429,
        description: 'Too many',
        retryAfterSeconds: 5,
      }),
      1,
    );
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBeGreaterThanOrEqual(5000);
    expect(decision.delayMs).toBeLessThanOrEqual(7000);
  });

  it('retries 429 without retry_after with exponential backoff', () => {
    const decision = classifyRetry(
      new TelegramBotApiError('sendMessage', { errorCode: 429, description: 'Too many' }),
      1,
    );
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBeGreaterThan(0);
  });

  it('retries non-aborted network errors with backoff', () => {
    const decision = classifyRetry(new TelegramNetworkError('sendMessage', 'ECONNRESET'), 1);
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBeGreaterThan(0);
  });

  it('retries 5xx server errors with bounded backoff', () => {
    const decision = classifyRetry(
      new TelegramBotApiError('sendMessage', { errorCode: 502, description: 'Bad gateway' }),
      1,
    );
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBeGreaterThan(500);
    expect(decision.retry).toBe(true);
  });

  it('retries with increasing delay on attempt 2', () => {
    const d1 = classifyRetry(new TelegramNetworkError('sendMessage', 'timeout'), 1);
    const d2 = classifyRetry(new TelegramNetworkError('sendMessage', 'timeout'), 2);
    expect(d1.retry).toBe(true);
    expect(d2.retry).toBe(true);
    expect(d2.delayMs).toBeGreaterThanOrEqual(d1.delayMs);
  });
});
