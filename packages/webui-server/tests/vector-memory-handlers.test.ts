/**
 * Focused tests for the vector-memory HTTP handlers (zero-statement
 * ratchet coverage for
 * packages/webui-server/src/server/http-server/vector-memory-handlers.ts).
 *
 * The store is mocked structurally: the handler module's
 * `VectorMemoryStore` import resolves to `any` (the package has no
 * declarations in this test project), so the mocks need no casts.
 */
import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import {
  handleVectorMemoryForget,
  handleVectorMemorySearch,
  handleVectorMemoryStatus,
  handleVectorMemoryStore,
  snapshotVectorMemory,
} from '../src/server/http-server/vector-memory-handlers.js';

type MockRes = { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };

function makeRes(): MockRes {
  return { writeHead: vi.fn(), end: vi.fn() };
}

function resAsServer(res: MockRes): http.ServerResponse {
  return res as unknown as http.ServerResponse;
}

function lastBody(res: MockRes): unknown {
  const call = res.end.mock.calls.at(-1);
  return call ? JSON.parse(String(call[0])) : undefined;
}

function statusCode(res: MockRes): number | undefined {
  return res.writeHead.mock.calls.at(-1)?.[0] as number | undefined;
}

function makeStore() {
  return {
    stats: vi.fn(() => ({
      entries: 2,
      vectors: 2,
      providers: ['fake'],
      modelId: 'fake-model',
      dimensions: 8,
    })),
    search: vi.fn(async () => [
      { entry: { id: 'e1', text: 'hello', summary: 'sum', tags: ['a'] }, score: 0.9 },
    ]),
    remember: vi.fn(async () => ({ id: 'new-1', vector: new Float32Array([1]), dimensions: 8 })),
    forget: vi.fn(() => true),
  };
}

function makeReq(): {
  req: http.IncomingMessage;
  emit: (chunk: string) => void;
  finish: () => void;
} {
  const emitter = new EventEmitter();
  const req = emitter as unknown as http.IncomingMessage;
  (req as { setEncoding: unknown }).setEncoding = vi.fn();
  (req as { destroy: unknown }).destroy = vi.fn();
  return {
    req,
    emit: (chunk: string) => emitter.emit('data', chunk),
    finish: () => emitter.emit('end'),
  };
}

describe('snapshotVectorMemory', () => {
  it('returns the store snapshot with optional paths', () => {
    const store = makeStore();
    const snap = snapshotVectorMemory(store as never, {
      projectRoot: '/proj',
      modelCacheDir: '/cache',
    });
    expect(snap.storePath).toBe('/proj');
    expect(snap.modelCacheDir).toBe('/cache');
    expect(snap.stats).toEqual({
      entries: 2,
      vectors: 2,
      providers: ['fake'],
      modelId: 'fake-model',
      dimensions: 8,
    });
  });
});

describe('handleVectorMemoryStatus', () => {
  it('responds enabled:false when no store is wired', async () => {
    const res = makeRes();
    await handleVectorMemoryStatus(resAsServer(res), () => undefined);
    expect(statusCode(res)).toBe(200);
    expect(lastBody(res)).toEqual({ enabled: false });
  });

  it('maps the store snapshot into the status response', async () => {
    const res = makeRes();
    const store = makeStore();
    await handleVectorMemoryStatus(resAsServer(res), () => store as never);
    expect(statusCode(res)).toBe(200);
    expect(lastBody(res)).toMatchObject({
      enabled: true,
      providerId: 'fake-model',
      modelId: 'fake-model',
      dimensions: 8,
      entries: 2,
      vectors: 2,
      providers: ['fake'],
    });
  });

  it('returns 500 with a sanitized error when the store throws', async () => {
    const res = makeRes();
    const store = makeStore();
    store.stats.mockImplementation(() => {
      throw new Error('db closed');
    });
    await handleVectorMemoryStatus(resAsServer(res), () => store as never);
    expect(statusCode(res)).toBe(500);
    expect(lastBody(res)).toMatchObject({ error: 'Vector memory status failed' });
  });
});

describe('handleVectorMemorySearch', () => {
  it('returns 503 when no store is wired', async () => {
    const res = makeRes();
    await handleVectorMemorySearch(resAsServer(res), new URL('http://x/search?q=a'), () => undefined);
    expect(statusCode(res)).toBe(503);
  });

  it('returns 400 for a missing query', async () => {
    const res = makeRes();
    const store = makeStore();
    await handleVectorMemorySearch(resAsServer(res), new URL('http://x/search'), () => store as never);
    expect(statusCode(res)).toBe(400);
    expect(store.search).not.toHaveBeenCalled();
  });

  it('maps hits and clamps the limit to 50', async () => {
    const res = makeRes();
    const store = makeStore();
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=hello&limit=999&threshold=0.5'),
      () => store as never,
    );
    expect(statusCode(res)).toBe(200);
    expect(store.search).toHaveBeenCalledWith('hello', { limit: 50, threshold: 0.5 });
    expect(lastBody(res)).toMatchObject({
      count: 1,
      hits: [{ id: 'e1', score: 0.9, text: 'hello', summary: 'sum', tags: ['a'] }],
    });
  });

  it('returns 500 when the store search throws', async () => {
    const res = makeRes();
    const store = makeStore();
    store.search.mockRejectedValue(new Error('search failed'));
    await handleVectorMemorySearch(resAsServer(res), new URL('http://x/search?q=a'), () => store as never);
    expect(statusCode(res)).toBe(500);
    expect(lastBody(res)).toMatchObject({ error: 'Vector memory search failed' });
  });
});

describe('handleVectorMemoryStore', () => {
  it('returns 503 when no store is wired', async () => {
    const res = makeRes();
    await handleVectorMemoryStore(resAsServer(res), makeReq().req, () => undefined);
    expect(statusCode(res)).toBe(503);
  });

  it('returns 400 for malformed JSON', async () => {
    const res = makeRes();
    const store = makeStore();
    const { req, emit, finish } = makeReq();
    const pending = handleVectorMemoryStore(resAsServer(res), req, () => store as never);
    emit('not json');
    finish();
    await pending;
    expect(statusCode(res)).toBe(400);
    expect(lastBody(res)).toMatchObject({ error: 'Malformed JSON body' });
  });

  it('returns 400 for an empty text field', async () => {
    const res = makeRes();
    const store = makeStore();
    const { req, emit, finish } = makeReq();
    const pending = handleVectorMemoryStore(resAsServer(res), req, () => store as never);
    emit('{"text":"   "}');
    finish();
    await pending;
    expect(statusCode(res)).toBe(400);
    expect(store.remember).not.toHaveBeenCalled();
  });

  it('stores a valid entry and returns its id', async () => {
    const res = makeRes();
    const store = makeStore();
    const { req, emit, finish } = makeReq();
    const pending = handleVectorMemoryStore(resAsServer(res), req, () => store as never);
    emit('{"text":"hello world","tags":["a", 1]}');
    finish();
    await pending;
    expect(statusCode(res)).toBe(200);
    expect(store.remember).toHaveBeenCalledWith({ text: 'hello world', tags: ['a'] });
    expect(lastBody(res)).toMatchObject({ id: 'new-1', hasVector: true, dimensions: 8 });
  });

  it('returns 500 when the store remember throws', async () => {
    const res = makeRes();
    const store = makeStore();
    store.remember.mockRejectedValue(new Error('write failed'));
    const { req, emit, finish } = makeReq();
    const pending = handleVectorMemoryStore(resAsServer(res), req, () => store as never);
    emit('{"text":"hello"}');
    finish();
    await pending;
    expect(statusCode(res)).toBe(500);
    expect(lastBody(res)).toMatchObject({ error: 'Vector memory store failed' });
  });
});

describe('handleVectorMemoryForget', () => {
  it('returns 503 when no store is wired', async () => {
    const res = makeRes();
    await handleVectorMemoryForget(
      resAsServer(res),
      new URL('http://x/api/vector-memory/store/abc'),
      () => undefined,
    );
    expect(statusCode(res)).toBe(503);
  });

  it('forgets a valid id and returns removed:true', async () => {
    const res = makeRes();
    const store = makeStore();
    await handleVectorMemoryForget(
      resAsServer(res),
      new URL('http://x/api/vector-memory/store/abc-123'),
      () => store as never,
    );
    expect(statusCode(res)).toBe(200);
    expect(store.forget).toHaveBeenCalledWith('abc-123');
    expect(lastBody(res)).toEqual({ removed: true });
  });

  it('returns 400 for an invalid URI-encoded id without calling the store', async () => {
    const res = makeRes();
    const store = makeStore();
    await handleVectorMemoryForget(
      resAsServer(res),
      new URL('http://x/api/vector-memory/store/%zz'),
      () => store as never,
    );
    expect(statusCode(res)).toBe(400);
    expect(store.forget).not.toHaveBeenCalled();
  });

  it('returns 500 when the store forget throws', async () => {
    const res = makeRes();
    const store = makeStore();
    store.forget.mockImplementation(() => {
      throw new Error('forget failed');
    });
    await handleVectorMemoryForget(
      resAsServer(res),
      new URL('http://x/api/vector-memory/store/abc'),
      () => store as never,
    );
    expect(statusCode(res)).toBe(500);
    expect(lastBody(res)).toMatchObject({ error: 'Vector memory forget failed' });
  });
});
