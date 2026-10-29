import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { VectorMemoryStore } from '@wrongstack/vector-memory';
import { afterEach, expect, it } from 'vitest';
import {
  handleVectorMemoryReindex,
  handleVectorMemoryStatus,
} from '../src/server/http-server/vector-memory-handlers.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function response() {
  const out = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      out.status = status;
      return res;
    },
    end(body: string) {
      out.body = body;
    },
  };
  return { res: res as unknown as http.ServerResponse, out, json: () => JSON.parse(out.body) };
}

const request = (body: string) => Readable.from([body]) as unknown as http.IncomingMessage;

it('re-embeds entries that have no usable vector and reports coverage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrongstack-vm-reindex-'));
  roots.push(root);
  let failing = true;
  const store = new VectorMemoryStore({
    projectRoot: root,
    provider: {
      id: 'reindex-test',
      dimensions: 3,
      async embed(texts: string[]) {
        if (failing) throw Error('provider offline');
        return texts.map(() => new Float32Array([1, 0, 0]));
      },
    },
  });
  try {
    const entry = await store.remember({ text: 'stored while the provider was offline' });
    expect(entry.vector).toBeUndefined();
    const before = response();
    await handleVectorMemoryStatus(before.res, () => store);
    expect(before.json().coverage).toEqual({ entries: 1, covered: 0, missing: 1 });

    const invalid = response();
    await handleVectorMemoryReindex(invalid.res, request('{"onlyMissing":"yes"}'), () => store);
    expect(invalid.out.status).toBe(400);

    failing = false;
    const done = response();
    await handleVectorMemoryReindex(done.res, request('{"onlyMissing":true}'), () => store);
    expect(done.out.status).toBe(200);
    expect(done.json()).toEqual({
      processed: 1,
      errors: 0,
      coverage: { entries: 1, covered: 1, missing: 0 },
    });

    const none = response();
    await handleVectorMemoryReindex(none.res, request('{}'), () => undefined);
    expect(none.out.status).toBe(503);
  } finally {
    store.close();
  }
});
