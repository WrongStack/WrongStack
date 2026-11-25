import { describe, expect, it, vi } from 'vitest';
import { _httpJson } from '../client.js';
import { DEFAULT_TRANSPORT_TIMEOUT_MS } from '../constants.js';

describe('WrongTrace _httpJson NaN timeout fallback (F1841)', () => {
  it('falls back to DEFAULT_TRANSPORT_TIMEOUT_MS when timeoutMs is NaN', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })) as unknown as typeof fetch;

    try {
      await _httpJson('http://127.0.0.1:9999', '/api/health', {
        timeoutMs: Number.NaN,
        fetchImpl: fakeFetch,
      });
      expect(spy).toHaveBeenCalledWith(expect.any(Function), DEFAULT_TRANSPORT_TIMEOUT_MS);
    } finally {
      spy.mockRestore();
    }
  });
});
