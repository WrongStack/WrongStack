import type { ClientRequest, IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the transport so requestOnce's data/end handling can be driven
// deterministically without real network I/O.
vi.mock('node:https', () => ({ get: vi.fn(), request: vi.fn() }));
vi.mock('node:http', () => ({ get: vi.fn(), request: vi.fn() }));

import { get as httpsGet } from 'node:https';
import { requestWithRetry } from '../src/registry/http-fetch.js';

interface FakeResponse extends IncomingMessage {
  _emit(event: string, arg?: unknown): void;
}

function fakeResponse(): FakeResponse {
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  let destroyed = false;
  return {
    statusCode: 200,
    headers: {},
    setEncoding() {},
    destroy() {
      destroyed = true;
    },
    get destroyed() {
      return destroyed;
    },
    on(event: string, cb: (arg?: unknown) => void) {
      const bucket = listeners[event] ?? [];
      bucket.push(cb);
      listeners[event] = bucket;
      return this;
    },
    _emit(event: string, arg?: unknown) {
      for (const cb of listeners[event] ?? []) cb(arg);
    },
  } as unknown as FakeResponse;
}

describe('requestWithRetry body cap', () => {
  afterEach(() => vi.clearAllMocks());

  it('rejects once the streamed body exceeds maxBodyBytes', async () => {
    const res = fakeResponse();
    vi.mocked(httpsGet).mockImplementation(((_opts: unknown, cb: (r: IncomingMessage) => void) => {
      cb(res);
      // Emit two 400-byte chunks: the second crosses the 500-byte cap.
      setTimeout(() => {
        res._emit('data', 'a'.repeat(400));
        res._emit('data', 'b'.repeat(400));
        // A well-behaved server would also emit 'end', but the cap must fire
        // before that; emit it anyway to prove resolve-after-reject is a no-op.
        res._emit('end');
      }, 0);
      const req: Partial<ClientRequest> = {
        on: vi.fn(() => req as ClientRequest),
        end: vi.fn(),
        write: vi.fn(),
      };
      return req as ClientRequest;
    }) as typeof httpsGet);

    await expect(
      requestWithRetry({
        hostname: 'registry.example',
        path: '/big',
        maxAttempts: 1,
        maxBodyBytes: 500,
      }),
    ).rejects.toThrow(/exceeded 500 bytes/);
    expect(res.destroyed).toBe(true);
  });

  it('returns the full body when under the cap', async () => {
    const res = fakeResponse();
    vi.mocked(httpsGet).mockImplementation(((_opts: unknown, cb: (r: IncomingMessage) => void) => {
      cb(res);
      setTimeout(() => {
        res._emit('data', 'hello');
        res._emit('end');
      }, 0);
      const req: Partial<ClientRequest> = {
        on: vi.fn(() => req as ClientRequest),
        end: vi.fn(),
        write: vi.fn(),
      };
      return req as ClientRequest;
    }) as typeof httpsGet);

    const out = await requestWithRetry({
      hostname: 'registry.example',
      path: '/small',
      maxAttempts: 1,
      maxBodyBytes: 500,
    });
    expect(out.body).toBe('hello');
    expect(res.destroyed).toBe(false);
  });
});
