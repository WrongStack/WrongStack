import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { get as httpsGet } from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestWithRetry } from '../src/registry/http-fetch.js';

vi.mock('node:https', () => ({ get: vi.fn(), request: vi.fn() }));

class ResponseStream extends EventEmitter {
  statusCode = 200;
  headers = {};
  setEncoding() {
    return this;
  }
}

function connect(response: ResponseStream) {
  vi.mocked(httpsGet).mockImplementation(((
    _options: unknown,
    callback: (r: IncomingMessage) => void,
  ) => {
    callback(response as unknown as IncomingMessage);
    const request = new EventEmitter();
    return Object.assign(request, { end() {}, write() {} }) as unknown as ClientRequest;
  }) as typeof httpsGet);
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('HTTP response stream errors', () => {
  it('delivers a completed body', async () => {
    const response = new ResponseStream();
    connect(response);
    const pending = requestWithRetry({
      hostname: 'registry.example',
      path: '/control',
      maxAttempts: 1,
    });
    response.emit('data', 'complete');
    response.emit('end');
    await expect(pending).resolves.toMatchObject({ statusCode: 200, body: 'complete' });
  });

  it.each(['', 'partial'])('rejects a failed response after receiving %j', async (body) => {
    const response = new ResponseStream();
    connect(response);
    const pending = requestWithRetry({
      hostname: 'registry.example',
      path: '/broken',
      maxAttempts: 1,
    });
    const outcome = pending.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    if (body) response.emit('data', body);
    const failure = new Error('upstream response aborted');
    expect(() => response.emit('error', failure)).not.toThrow();
    await expect(outcome).resolves.toEqual({ error: failure });
  });

  it('retries a failed response and returns only the completed retry body', async () => {
    vi.useFakeTimers();
    const first = new ResponseStream();
    connect(first);
    const pending = requestWithRetry({
      hostname: 'registry.example',
      path: '/retry',
      maxAttempts: 2,
      baseBackoffMs: 10,
    });
    first.emit('data', 'discarded partial body');
    expect(() => first.emit('error', new Error('connection reset'))).not.toThrow();
    const second = new ResponseStream();
    connect(second);
    await vi.advanceTimersByTimeAsync(10);
    second.emit('data', 'complete retry');
    second.emit('end');
    await expect(pending).resolves.toMatchObject({ body: 'complete retry' });
    expect(httpsGet).toHaveBeenCalledTimes(2);
  });

  it('does not retry a response error when the caller has aborted', async () => {
    const response = new ResponseStream();
    connect(response);
    const controller = new AbortController();
    const pending = requestWithRetry({
      hostname: 'registry.example',
      path: '/abort',
      maxAttempts: 3,
      signal: controller.signal,
    });
    const outcome = pending.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    controller.abort();
    const failure = new DOMException('Request aborted', 'AbortError');
    expect(() => response.emit('error', failure)).not.toThrow();
    await expect(outcome).resolves.toEqual({ error: failure });
    expect(httpsGet).toHaveBeenCalledTimes(1);
  });
});
