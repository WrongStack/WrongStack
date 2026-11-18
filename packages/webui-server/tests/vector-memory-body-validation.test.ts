import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  handleVectorMemoryReindex,
  handleVectorMemoryStore,
} from '../src/server/http-server/vector-memory-handlers.js';

function makeMockHttp(chunks: Buffer[]) {
  const emitter = new EventEmitter();
  let encoding: BufferEncoding | undefined;
  let destroyedBeforeResponse = false;
  let status = 0;
  let body = '';
  const req = Object.assign(emitter, {
    setEncoding(enc: BufferEncoding) {
      encoding = enc;
    },
    destroy() {
      if (status === 0) destroyedBeforeResponse = true;
    },
  }) as unknown as http.IncomingMessage;
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(payload?: string) {
      body = payload ?? '';
    },
  } as unknown as http.ServerResponse;
  const dispatch = () => {
    for (const chunk of chunks) {
      emitter.emit('data', encoding ? chunk.toString(encoding) : chunk);
    }
    emitter.emit('end');
  };
  return { req, res, dispatch, getResult: () => ({ status, body, destroyedBeforeResponse }) };
}

describe('vector-memory body UTF-8 byte cap, chunking, and object validation', () => {
  it('enforces 64 KiB on UTF-8 byte length with HTTP 413 without early socket destroy and decodes split UTF-8', async () => {
    const remember = vi.fn(async () => ({
      id: 'mem-1',
      vector: new Float32Array([1]),
      dimensions: 1,
    }));
    const store = {
      remember,
      reindexAll: vi.fn(async () => ({ processed: 1, errors: 0 })),
      embeddingCoverage: () => ({ entries: 1, covered: 1, missing: 0 }),
    };

    // 30,000 3-byte `€` chars = 90 KB UTF-8 (>64 KiB) despite <64k UTF-16 code units
    const multibyte90KB = Buffer.from(JSON.stringify({ text: '€'.repeat(30_000) }), 'utf8');
    const utf8Over = makeMockHttp([multibyte90KB]);
    const pOver = handleVectorMemoryStore(utf8Over.res, utf8Over.req, () => store as never);
    utf8Over.dispatch();
    await pOver;
    expect(utf8Over.getResult().status).toBe(413);
    expect(utf8Over.getResult().destroyedBeforeResponse).toBe(false);
    expect(remember).not.toHaveBeenCalled();

    const reindexOver = makeMockHttp([
      Buffer.alloc(40 * 1024, 0x20),
      Buffer.alloc(35 * 1024, 0x20),
    ]);
    const pReindex = handleVectorMemoryReindex(
      reindexOver.res,
      reindexOver.req,
      () => store as never,
    );
    reindexOver.dispatch();
    await pReindex;
    expect(reindexOver.getResult().status).toBe(413);
    expect(reindexOver.getResult().destroyedBeforeResponse).toBe(false);

    // Split multi-byte UTF-8 across single-byte chunks
    const splitBytes = Buffer.from(JSON.stringify({ text: 'şema 🚀 testi' }), 'utf8');
    const splitReq = makeMockHttp(Array.from(splitBytes, (b) => Buffer.from([b])));
    const pSplit = handleVectorMemoryStore(splitReq.res, splitReq.req, () => store as never);
    splitReq.dispatch();
    await pSplit;
    expect(splitReq.getResult().status).toBe(200);
    expect(remember).toHaveBeenCalledWith({ text: 'şema 🚀 testi', tags: [] });

    for (const raw of ['null', '[1,2]', '"str"', '42']) {
      const m = makeMockHttp([Buffer.from(raw, 'utf8')]);
      const p = handleVectorMemoryStore(m.res, m.req, () => store as never);
      m.dispatch();
      await p;
      expect(m.getResult().status).toBe(400);
      expect(JSON.parse(m.getResult().body)).toEqual({ error: 'Malformed JSON body' });
    }
  });
});
