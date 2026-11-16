import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WrongStackClient } from '../src/index.js';

interface ProbeResponse {
  response: Response;
  signal: AbortSignal | null | undefined;
}

async function withProbe(
  status: number,
  streaming: boolean,
  check: (url: string, responses: ProbeResponse[]) => Promise<void>,
): Promise<void> {
  const server = http.createServer((_request, response) => {
    response.writeHead(status, { 'Content-Type': 'text/plain' });
    if (streaming) response.write('probe body still streaming');
    else response.end();
  });
  server.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP port');
  const responses: ProbeResponse[] = [];
  const originalFetch = globalThis.fetch;
  // Observe real network responses; neither fetch nor the client is simulated.
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
    const response = await originalFetch(...args);
    responses.push({ response, signal: args[1]?.signal });
    return response;
  });
  try {
    await check(`http://127.0.0.1:${address.port}`, responses);
  } finally {
    fetchSpy.mockRestore();
    for (const { response, signal } of responses) {
      if (response.body && !signal?.aborted) await response.body.cancel();
    }
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function expectReleased(response: Response): Promise<void> {
  if (!response.body) throw new Error('Expected the streaming probe response body');
  const reader = response.body.getReader();
  let released = false;
  try {
    released = (await reader.read()).done === true;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
    released = true;
  } finally {
    reader.releaseLock();
  }
  expect(released, 'probe response body remains open after connect rejects').toBe(true);
}

afterEach(() => vi.restoreAllMocks());

describe('handshake auth probe response ownership', () => {
  it.each([401, 200, 503])(
    'releases a streaming HTTP %i response before rejecting',
    async (status) => {
      await withProbe(status, true, async (url, responses) => {
        await expect(
          WrongStackClient.connect({ url, timeoutMs: 2_000, reconnect: false }),
        ).rejects.toMatchObject({
          kind: status === 401 ? 'auth' : 'connection',
          code: status === 401 ? '401' : 'handshake_failed',
        });
        expect(responses).toHaveLength(1);
        const observed = responses[0];
        if (!observed) throw new Error('Expected the real HTTP probe to run');
        await expectReleased(observed.response);
      });
    },
  );

  it('keeps the existing error classification for a bodyless probe', async () => {
    await withProbe(204, false, async (url, responses) => {
      await expect(
        WrongStackClient.connect({ url, timeoutMs: 2_000, reconnect: false }),
      ).rejects.toMatchObject({ kind: 'connection', code: 'handshake_failed', retryable: true });
      expect(responses).toHaveLength(1);
      expect(responses[0]?.response.body).toBeNull();
    });
  });
});
