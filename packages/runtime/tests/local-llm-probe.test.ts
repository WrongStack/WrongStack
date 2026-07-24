import type { SecretScrubber } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { probeLocalLlm } from '../src/local-llm-probe.js';

const scrubber: SecretScrubber = {
  scrub: (text: string) => text.replaceAll('secret-key', '[redacted]'),
  scrubObject: <T>(obj: T): T => obj,
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: init.status ?? 500, headers: init.headers });
}

describe('probeLocalLlm', () => {
  it('fetches /models with auth, deduplicates model ids, and preserves server order', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [
          { id: 'llama3' },
          { name: 'mistral' },
          { id: 'llama3' },
          { id: '  ' },
          { id: 'secret-key-model' },
          { notAModel: true },
          null,
        ],
      }),
    );

    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1/',
      apiKey: 'secret-key',
      noAuth: false,
      scrubber,
      fetchImpl,
      timeoutMs: 1234,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/models');
    expect(init).toMatchObject({
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer secret-key',
      },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toMatchObject({
      ok: true,
      status: 'ok',
      httpStatus: 200,
      modelCount: 3,
      modelIds: ['llama3', 'mistral', '[redacted]-model'],
    });
    expect(result.elapsedMs).toEqual(expect.any(Number));
  });

  it('does not add an auth header when noAuth is enabled and accepts an existing /models URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ models: [] }));

    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:1234/v1/models',
      apiKey: 'secret-key',
      noAuth: true,
      scrubber,
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:1234/v1/models');
    expect(init?.headers).toEqual({ accept: 'application/json' });
    expect(result).toMatchObject({
      ok: true,
      status: 'ok',
      modelCount: 0,
      modelIds: [],
    });
  });

  it('returns http_error with a redacted body slice for non-2xx responses', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        textResponse(`failure for secret-key ${'x'.repeat(300)}`, { status: 401 }),
      );

    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      noAuth: false,
      scrubber,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('http_error');
    expect(result.httpStatus).toBe(401);
    expect(result.detail).toContain('[redacted]');
    expect(result.detail).not.toContain('secret-key');
    expect(result.detail?.length).toBeLessThanOrEqual(200);
  });

  it('returns invalid_response when the JSON payload is not an object', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse('not an object'));

    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      noAuth: false,
      scrubber,
      fetchImpl,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'invalid_response',
      httpStatus: 200,
      detail: 'response is not a JSON object',
    });
  });

  it('returns invalid_response when neither data nor models is an array', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: null, models: 'bad' }));

    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      noAuth: false,
      scrubber,
      fetchImpl,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'invalid_response',
      httpStatus: 200,
      detail: 'no `data` or `models` array in response',
    });
  });

  it('returns invalid_response with redacted parse detail when JSON parsing fails', async () => {
    const response = new Response('not json', { status: 200 });
    vi.spyOn(response, 'json').mockRejectedValue(new Error('bad secret-key parse'));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);

    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      noAuth: false,
      scrubber,
      fetchImpl,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'invalid_response',
      httpStatus: 200,
      detail: 'bad [redacted] parse',
    });
  });

  it('classifies abort-like fetch failures as timeouts', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException('timed out', 'AbortError'));

    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      noAuth: false,
      scrubber,
      fetchImpl,
      timeoutMs: 42,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'timeout',
      detail: '> 42ms',
    });
  });

  it('classifies other fetch failures as unreachable and redacts the detail', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED secret-key'));

    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      noAuth: false,
      scrubber,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('unreachable');
    expect(result.detail).toBe('ECONNREFUSED [redacted]');
  });

  it('keeps http_error detail undefined when the response body cannot be read', async () => {
    const response = new Response('', { status: 503 });
    vi.spyOn(response, 'text').mockRejectedValue(new Error('body read failed'));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);

    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      noAuth: false,
      scrubber,
      fetchImpl,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'http_error',
      httpStatus: 503,
    });
    expect(result.detail).toBeUndefined();
  });

  it('uses global fetch when no implementation is injected', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ models: [] }));

    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      noAuth: true,
      scrubber,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    fetchSpy.mockRestore();
  });

  it('stringifies non-Error fetch failures', async () => {
    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      noAuth: true,
      scrubber,
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue('plain failure'),
    });

    expect(result.detail).toBe('plain failure');
  });

  it('uses the parse fallback for a non-Error JSON rejection', async () => {
    const response = new Response('', { status: 200 });
    vi.spyOn(response, 'json').mockRejectedValue('plain failure');

    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      noAuth: true,
      scrubber,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response),
    });

    expect(result.detail).toBe('parse failed');
  });
});
