import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SecretScrubber } from '@wrongstack/contracts/types';
import { afterEach, expect, it, vi } from 'vitest';
import { probeLocalLlm } from '../src/local-llm-probe.js';

const scrubber: SecretScrubber = {
  scrub: (text) => text,
  scrubObject: (value) => value,
};

afterEach(() => vi.restoreAllMocks());

it.each(['complete', 'malformed', 'TimeoutError', 'AbortError'])(
  'classifies a real HTTP model body: %s',
  async (mode) => {
    const controller = new AbortController();
    // Control only the deadline source; the HTTP fetch and body reader are real.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const headers = Promise.withResolvers<void>();
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (mode === 'complete') res.end('{"data":[{"id":"model-a"}]}');
      else if (mode === 'malformed') res.end('not JSON');
      else res.write('{"data":[');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
        const response = await fetch(url, init);
        headers.resolve();
        return response;
      });
      const resultPromise = probeLocalLlm({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        apiKey: undefined,
        noAuth: true,
        scrubber,
        timeoutMs: 42,
        fetchImpl,
      });
      // Abort only after fetch resolved, exercising body consumption rather
      // than the already-covered failure to receive response headers.
      await headers.promise;
      const stalled = mode === 'TimeoutError' || mode === 'AbortError';
      if (stalled) controller.abort(new DOMException('deadline expired', mode));
      const result = await resultPromise;
      expect(timeout).toHaveBeenCalledWith(42);
      if (stalled) {
        expect(result).toMatchObject({ ok: false, status: 'timeout', detail: '> 42ms' });
        expect(result.elapsedMs).toEqual(expect.any(Number));
      } else if (mode === 'complete') {
        expect(result).toMatchObject({ ok: true, status: 'ok', modelIds: ['model-a'] });
      } else {
        expect(result).toMatchObject({ ok: false, status: 'invalid_response', httpStatus: 200 });
      }
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);
