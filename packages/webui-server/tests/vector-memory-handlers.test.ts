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
  handleMemorySearch,
  handleVectorMemoryForget,
  handleVectorMemorySearch,
  handleVectorMemoryStatus,
  handleVectorMemoryStore,
} from '../src/server/http-server/vector-memory-handlers.js';

type MockRes = { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };

/** Partial persisted entries exercise legacy records and optional vector payloads. */
type SearchHitFixture = {
  entry: Record<string, unknown> & { id: string; text: string; tags: string[] };
  score: number;
  vector?: Float32Array | undefined;
};

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
    cacheStats: vi.fn(() => ({
      entries: 5,
      providers: 1,
      totalUseCount: 12,
      oldestLastUsedAt: '2026-08-15T20:00:00.000Z',
    })),
    embeddingCoverage: vi.fn(() => ({ entries: 2, covered: 2, missing: 0 })),
    search: vi.fn(
      async (): Promise<SearchHitFixture[]> => [
        {
          entry: { id: 'e1', text: 'hello', summary: 'sum', tags: ['a'] },
          score: 0.9,
          vector: undefined as Float32Array | undefined,
        },
      ],
    ),
    remember: vi.fn(async () => ({ id: 'new-1', vector: new Float32Array([1]), dimensions: 8 })),
    forget: vi.fn(async () => true),
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
      coverage: { entries: 2, covered: 2, missing: 0 },
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
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a'),
      () => undefined,
    );
    expect(statusCode(res)).toBe(503);
  });

  it('returns 400 for a missing query', async () => {
    const res = makeRes();
    const store = makeStore();
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search'),
      () => store as never,
    );
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
    expect(store.search).toHaveBeenCalledWith('hello', {
      limit: 50,
      threshold: 0.5,
      includeVectors: false,
      scope: 'project',
      failOnEmbeddingError: true,
    });
    expect(lastBody(res)).toMatchObject({
      count: 1,
      hits: [{ id: 'e1', score: 0.9, text: 'hello', summary: 'sum', tags: ['a'] }],
    });
  });

  it('returns 500 when the store search throws', async () => {
    const res = makeRes();
    const store = makeStore();
    store.search.mockRejectedValue(new Error('search failed'));
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a'),
      () => store as never,
    );
    expect(statusCode(res)).toBe(500);
    expect(lastBody(res)).toMatchObject({ error: 'Vector memory search failed' });
  });

  it('passes `includeVectors: true` when `?similarity=1` is set', async () => {
    const res = makeRes();
    const store = makeStore();
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=hello&similarity=1'),
      () => store as never,
    );
    expect(store.search).toHaveBeenCalledWith('hello', {
      limit: 10,
      includeVectors: true,
      scope: 'project',
      failOnEmbeddingError: true,
    });
  });

  it('builds the pairwise similarity matrix when vectors are returned', async () => {
    const res = makeRes();
    const store = makeStore();
    // Override the search mock to return two hits with distinct vectors.
    // The orthogonal vectors → cosine = 0; identical → 1.0.
    const v1 = new Float32Array([1, 0]);
    const v2 = new Float32Array([0, 1]);
    store.search.mockResolvedValue([
      { entry: { id: 'e1', text: 'one', summary: '', tags: [] }, score: 0.9, vector: v1 },
      { entry: { id: 'e2', text: 'two', summary: '', tags: [] }, score: 0.7, vector: v2 },
    ]);
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=x&similarity=1'),
      () => store as never,
    );
    const body = lastBody(res) as { similarity: number[][] };
    expect(body.similarity).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it('omits the similarity matrix when fewer than two hits are returned', async () => {
    const res = makeRes();
    const store = makeStore();
    store.search.mockResolvedValue([
      {
        entry: { id: 'e1', text: 'one', summary: '', tags: [] },
        score: 0.9,
        vector: new Float32Array([1]),
      },
    ]);
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=x&similarity=1'),
      () => store as never,
    );
    const body = lastBody(res) as { similarity?: number[][] };
    expect(body.similarity).toBeUndefined();
  });
});

describe('handleVectorMemorySearch — bounded filters (B0/B3)', () => {
  it('defaults to project scope and never requests user/session entries', async () => {
    const res = makeRes();
    const store = makeStore();
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a'),
      () => store as never,
    );
    expect(store.search).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ scope: 'project', failOnEmbeddingError: true }),
    );
  });

  it('rejects scope=user with 400 and never calls the store', async () => {
    const res = makeRes();
    const store = makeStore();
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a&scope=user'),
      () => store as never,
    );
    expect(statusCode(res)).toBe(400);
    expect(lastBody(res)).toMatchObject({ param: 'scope' });
    expect(store.search).not.toHaveBeenCalled();
  });

  it('rejects scope=session with 400 and never calls the store', async () => {
    const res = makeRes();
    const store = makeStore();
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a&scope=session'),
      () => store as never,
    );
    expect(statusCode(res)).toBe(400);
    expect(store.search).not.toHaveBeenCalled();
  });

  it('accepts an explicit scope=project', async () => {
    const res = makeRes();
    const store = makeStore();
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a&scope=project'),
      () => store as never,
    );
    expect(statusCode(res)).toBe(200);
    expect(store.search).toHaveBeenCalledWith('a', expect.objectContaining({ scope: 'project' }));
  });

  it('forwards a valid kind filter to the store server-side', async () => {
    const res = makeRes();
    const store = makeStore();
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a&kind=fact'),
      () => store as never,
    );
    expect(statusCode(res)).toBe(200);
    expect(store.search).toHaveBeenCalledWith('a', expect.objectContaining({ kind: 'fact' }));
  });

  it('rejects an invalid kind with 400 and never calls the store', async () => {
    const res = makeRes();
    const store = makeStore();
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a&kind=rumor'),
      () => store as never,
    );
    expect(statusCode(res)).toBe(400);
    expect(lastBody(res)).toMatchObject({ param: 'kind' });
    expect(store.search).not.toHaveBeenCalled();
  });

  it.each(['status', 'audience', 'sessionId', 'randomJunk'])(
    'rejects the unsupported `%s` param with 400 instead of ignoring or post-filtering it',
    async (param) => {
      const res = makeRes();
      const store = makeStore();
      await handleVectorMemorySearch(
        resAsServer(res),
        new URL(`http://x/search?q=a&${param}=x`),
        () => store as never,
      );
      expect(statusCode(res)).toBe(400);
      expect(lastBody(res)).toMatchObject({
        error: expect.stringContaining('Unsupported filter'),
        param,
      });
      expect(store.search).not.toHaveBeenCalled();
    },
  );
});

describe('handleVectorMemorySearch — ranked cursor (B2)', () => {
  it('emits nextCursor from the last store hit when the page is full', async () => {
    const res = makeRes();
    const store = makeStore();
    store.search.mockResolvedValue([
      { entry: { id: 'aaa', text: 'one', summary: '', tags: [] }, score: 0.9 },
      { entry: { id: 'bbb', text: 'two', summary: '', tags: [] }, score: 0.8 },
    ]);
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a&limit=2'),
      () => store as never,
    );
    const body = lastBody(res) as { nextCursor: string | null };
    expect(body.nextCursor).toEqual(expect.any(String));
    const decoded = JSON.parse(Buffer.from(body.nextCursor!, 'base64url').toString('utf8'));
    expect(decoded).toMatchObject({ v: 1, s: 0.8, i: 'bbb' });
  });

  it('emits nextCursor null when the store page is short', async () => {
    const res = makeRes();
    const store = makeStore();
    store.search.mockResolvedValue([
      { entry: { id: 'aaa', text: 'one', summary: '', tags: [] }, score: 0.9 },
    ]);
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a&limit=10'),
      () => store as never,
    );
    const body = lastBody(res) as { nextCursor: string | null };
    expect(body.nextCursor).toBeNull();
  });

  it('forwards a matching opaque cursor and rejects a cursor used with another query', async () => {
    const res = makeRes();
    const store = makeStore();
    store.search
      .mockResolvedValueOnce([{ entry: { id: 'entry-42', text: 'one', tags: [] }, score: 0.75 }])
      .mockResolvedValue([]);
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a&limit=1'),
      () => store as never,
    );
    const cursor = (lastBody(res) as { nextCursor: string }).nextCursor;
    const next = makeRes();
    await handleVectorMemorySearch(
      resAsServer(next),
      new URL(`http://x/search?q=a&cursor=${encodeURIComponent(cursor)}`),
      () => store as never,
    );
    expect(store.search).toHaveBeenLastCalledWith(
      'a',
      expect.objectContaining({ cursor: { score: 0.75, id: 'entry-42' } }),
    );
    const mismatched = makeRes();
    await handleVectorMemorySearch(
      resAsServer(mismatched),
      new URL(`http://x/search?q=b&cursor=${encodeURIComponent(cursor)}`),
      () => store as never,
    );
    expect(statusCode(mismatched)).toBe(400);
    expect(store.search).toHaveBeenCalledTimes(2);
  });

  it('rejects a malformed cursor with 400 and never calls the store', async () => {
    const res = makeRes();
    const store = makeStore();
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a&cursor=bogus'),
      () => store as never,
    );
    expect(statusCode(res)).toBe(400);
    expect(lastBody(res)).toMatchObject({ param: 'cursor' });
    expect(store.search).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range cursor score with 400', async () => {
    const res = makeRes();
    const store = makeStore();
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a&cursor=1.5%3Aabc'),
      () => store as never,
    );
    expect(statusCode(res)).toBe(400);
    expect(store.search).not.toHaveBeenCalled();
  });
});

describe('handleVectorMemorySearch — SAGE mirror provenance (B0)', () => {
  function mirroredHits() {
    return [
      {
        entry: {
          id: 'e1',
          text: 'mirrored',
          summary: '',
          tags: [],
          scope: 'project',
          kind: 'fact',
          metadata: { source: 'sage', sageId: 'sage-1' },
        },
        score: 0.9,
      },
      {
        entry: {
          id: 'e2',
          text: 'native',
          summary: '',
          tags: [],
          scope: 'project',
          kind: 'note',
          metadata: {},
        },
        score: 0.8,
      },
    ];
  }

  it('drops mirrors when no visibility resolver is wired', async () => {
    const res = makeRes();
    const store = makeStore();
    store.search.mockResolvedValue(mirroredHits());
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a'),
      () => store as never,
    );
    const body = lastBody(res) as {
      hits: Array<{ id: string; sage?: { id: string; status: string } }>;
    };
    expect(body.hits.map((hit) => hit.id)).toEqual(['e2']);
    expect(body.hits[0]!.sage).toBeUndefined();
  });

  it('labels verified when the resolver confirms the memory is visible', async () => {
    const res = makeRes();
    const store = makeStore();
    store.search.mockResolvedValue(mirroredHits());
    const resolver = vi.fn(async () => ({ id: 'sage-1', text: 'mirrored' }) as never);
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a'),
      () => store as never,
      {
        resolveSageMirror: resolver,
      },
    );
    expect(resolver).toHaveBeenCalledWith('sage-1');
    const body = lastBody(res) as { hits: Array<{ sage?: { status: string } }> };
    expect(body.hits[0]!.sage).toEqual({ id: 'sage-1', status: 'verified' });
  });

  it('rejects a forged or stale SAGE mirror whose content differs from the resolved record', async () => {
    const res = makeRes();
    const store = makeStore();
    store.search.mockResolvedValue(mirroredHits());
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a'),
      () => store as never,
      {
        resolveSageMirror: async () =>
          ({ id: 'sage-1', text: 'different authoritative text' }) as never,
      },
    );
    const body = lastBody(res) as { hits: Array<{ id: string }> };
    expect(body.hits.map((hit) => hit.id)).toEqual(['e2']);
  });

  it('drops the hit when the resolver resolves the id as not visible', async () => {
    const res = makeRes();
    const store = makeStore();
    store.search.mockResolvedValue(mirroredHits());
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a'),
      () => store as never,
      { resolveSageMirror: async () => undefined },
    );
    const body = lastBody(res) as { hits: Array<{ id: string }>; count: number };
    expect(body.hits.map((h) => h.id)).toEqual(['e2']);
    expect(body.count).toBe(1);
  });

  it('drops mirrored hits if the visibility resolver throws', async () => {
    const res = makeRes();
    const store = makeStore();
    store.search.mockResolvedValue(mirroredHits());
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a'),
      () => store as never,
      {
        resolveSageMirror: async () => {
          throw new Error('sage down');
        },
      },
    );
    const body = lastBody(res) as {
      hits: Array<{ id: string; sage?: { id: string; status: string } }>;
    };
    expect(body.hits.map((h) => h.id)).toEqual(['e2']);
    expect(body.hits[0]!.sage).toBeUndefined();
  });

  it('never serializes raw metadata, vectors, or content hashes', async () => {
    const res = makeRes();
    const store = makeStore();
    store.search.mockResolvedValue([
      {
        entry: {
          id: 'e1',
          text: 'secret-ish',
          summary: '',
          tags: [],
          scope: 'project',
          kind: 'fact',
          contentHash: 'deadbeef',
          metadata: { source: 'sage', sageId: 'sage-1', privateJunk: 'nope' },
        },
        score: 0.9,
        vector: new Float32Array([0.1, 0.2]),
      },
    ]);
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a'),
      () => store as never,
      {
        resolveSageMirror: async () => ({ id: 'sage-1', text: 'secret-ish' }) as never,
      },
    );
    // Assert the parsed hit object exactly: only curated fields survive —
    // no metadata, no vector, no contentHash; provenance is the curated
    // `sage` object only. (Empty-string summary is omitted, as before.)
    const body = lastBody(res) as { hits: Array<Record<string, unknown>> };
    expect(body.hits).toEqual([
      {
        id: 'e1',
        score: 0.9,
        text: 'secret-ish',
        tags: [],
        scope: 'project',
        kind: 'fact',
        sage: { id: 'sage-1', status: 'verified' },
      },
    ]);
    // Belt-and-suspenders on the wire form for anything toEqual would
    // normalize away.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('privateJunk');
    expect(raw).not.toContain('deadbeef');
    expect(raw).not.toContain('"vector"');
    expect(raw).not.toContain('"metadata"');
  });
});

describe('handleVectorMemorySearch — typed embedding failure (B4)', () => {
  it('maps VectorMemoryProviderUnavailableError to a typed 503', async () => {
    const res = makeRes();
    const store = makeStore();
    const { VectorMemoryProviderUnavailableError } = await import('@wrongstack/vector-memory');
    store.search.mockRejectedValue(new VectorMemoryProviderUnavailableError('provider down'));
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a'),
      () => store as never,
    );
    expect(statusCode(res)).toBe(503);
    expect(lastBody(res)).toMatchObject({
      error: 'Vector memory embedding provider unavailable',
      code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
    });
  });

  it('still maps unrelated errors to 500', async () => {
    const res = makeRes();
    const store = makeStore();
    store.search.mockRejectedValue(new Error('db locked'));
    await handleVectorMemorySearch(
      resAsServer(res),
      new URL('http://x/search?q=a'),
      () => store as never,
    );
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

describe('handleMemorySearch', () => {
  function makeMemoryPort(
    overrides: { search?: (q: string, o: { limit: number }) => Promise<unknown[]> } & {
      searchWithBreakdown?: (q: string, o: { limit: number }) => Promise<unknown[]>;
    } = {},
  ): unknown {
    return {
      getCapability: vi.fn((capability: { id?: string }) => {
        if (capability.id === 'wrongstack.memory.surface.v1') {
          return {
            searchSage: overrides.search ?? vi.fn(async () => []),
            ...(overrides.searchWithBreakdown
              ? { searchSageWithBreakdown: overrides.searchWithBreakdown }
              : {}),
          };
        }
        return undefined;
      }),
    };
  }

  it('returns 400 when q is missing', async () => {
    const res = makeRes();
    const port = makeMemoryPort();
    await handleMemorySearch(
      resAsServer(res),
      new URL('http://x/api/memory/search'),
      () => port as never,
    );
    expect(statusCode(res)).toBe(400);
    expect(lastBody(res)).toMatchObject({ error: 'Missing required query parameter `q`' });
  });

  it('returns 503 when no store is wired', async () => {
    const res = makeRes();
    await handleMemorySearch(
      resAsServer(res),
      new URL('http://x/api/memory/search?q=hello'),
      () => undefined,
    );
    expect(statusCode(res)).toBe(503);
  });

  it('returns 503 when the store has no SAGE surface', async () => {
    const res = makeRes();
    const port = { getCapability: () => undefined };
    await handleMemorySearch(
      resAsServer(res),
      new URL('http://x/api/memory/search?q=hello'),
      () => port as never,
    );
    expect(statusCode(res)).toBe(503);
  });

  it('returns lexical-only hits when explain=1 is not set', async () => {
    const res = makeRes();
    const search = vi.fn(async () => [
      {
        id: 'm1',
        text: 'memory a',
        kind: 'fact',
        status: 'active',
        tags: ['t1'],
      },
      {
        id: 'm2',
        text: 'memory b',
        kind: 'note',
        status: 'active',
        tags: [],
      },
    ]);
    const port = makeMemoryPort({ search });
    await handleMemorySearch(
      resAsServer(res),
      new URL('http://x/api/memory/search?q=hello&limit=10'),
      () => port as never,
    );
    expect(statusCode(res)).toBe(200);
    const body = lastBody(res) as { channel: string; hits: Array<{ source: string }> };
    expect(body.channel).toBe('lexical');
    expect(body.hits).toHaveLength(2);
    expect(body.hits[0]!.source).toBe('lexical');
    expect(body.hits[1]!.source).toBe('lexical');
  });

  it('returns breakdown hits when explain=1 and the rich variant is wired', async () => {
    const res = makeRes();
    const searchWithBreakdown = vi.fn(async () => [
      {
        memory: { id: 'a', text: 'mem a', kind: 'fact', status: 'active', tags: [] },
        lexicalScore: 0.91,
        vectorScore: 0.78,
        finalScore: 0.84,
        source: 'both',
      },
      {
        memory: { id: 'b', text: 'mem b', kind: 'note', status: 'active', tags: [] },
        lexicalScore: null,
        vectorScore: 0.55,
        finalScore: 0.55,
        source: 'vector',
      },
    ]);
    const port = makeMemoryPort({ searchWithBreakdown });
    await handleMemorySearch(
      resAsServer(res),
      new URL('http://x/api/memory/search?q=hello&explain=1&limit=10'),
      () => port as never,
    );
    expect(statusCode(res)).toBe(200);
    const body = lastBody(res) as {
      channel: string;
      hits: Array<{
        id: string;
        source: string;
        lexicalScore: number | null;
        vectorScore: number | null;
      }>;
    };
    expect(body.channel).toBe('breakdown');
    expect(body.hits).toHaveLength(2);
    expect(body.hits[0]).toMatchObject({
      id: 'a',
      source: 'both',
      lexicalScore: 0.91,
      vectorScore: 0.78,
    });
    expect(body.hits[1]).toMatchObject({
      id: 'b',
      source: 'vector',
      lexicalScore: null,
      vectorScore: 0.55,
    });
  });
});
