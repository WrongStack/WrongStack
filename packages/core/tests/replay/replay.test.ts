import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { hashRequest, stableStringify } from '../../src/replay/hash.js';
import { ReplayLogStore } from '../../src/storage/replay-log-store.js';
import type { Request, Response } from '../../src/types/provider.js';

// vi.mock is hoisted above imports.  The factory uses vi.importActual to lazily
// get the real module, avoiding TDZ issues.  The returned plain object replaces
// 'node:fs/promises' before the second import runs.
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

  const mockFs = {
    mkdtemp: real.mkdtemp,
    // All fs operations delegate to real fs so that atomicWrite (temp+rename)
    // and concurrent appends stay coherent.  Wrapped in vi.fn() so that
    // error-injection tests can call .mockRejectedValueOnce() on them.
    readFile: vi.fn(real.readFile),
    appendFile: vi.fn(real.appendFile),
    writeFile: vi.fn(async (filepath: string | Buffer | URL, data: string) => {
      const k = String(filepath);
      try {
        await real.writeFile(k, data, 'utf8');
      } catch {
        /* best-effort real write */
      }
    }),
    rename: real.rename,
    access: real.access,
    unlink: real.unlink,
    mkdir: real.mkdir,
    readdir: real.readdir,
    rm: real.rm,
    open: real.open,
    close: real.close,
    fsync: real.fsync,
    chmod: real.chmod,
    copyFile: real.copyFile,
    stat: real.stat,
  };
  return mockFs;
});

import * as fs from 'node:fs/promises';

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    model: 'claude-test',
    system: [{ type: 'text', text: 'You are a helpful assistant.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 1024,
    temperature: 0,
    ...overrides,
  };
}

function makeResponse(overrides: Partial<Response> = {}): Response {
  return {
    content: [{ type: 'text', text: 'hello' }],
    stopReason: 'end_turn',
    usage: { input: 10, output: 5 },
    model: 'claude-test',
    ...overrides,
  };
}

describe('hashRequest', () => {
  it('produces a stable sha256-prefixed hash for the same request', () => {
    const a = makeRequest();
    const b = makeRequest();
    expect(hashRequest(a)).toBe(hashRequest(b));
    expect(hashRequest(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('hash changes when model changes', () => {
    const a = makeRequest();
    const b = makeRequest({ model: 'claude-other' });
    expect(hashRequest(a)).not.toBe(hashRequest(b));
  });

  it('hash changes when message content changes', () => {
    const a = makeRequest();
    const b = makeRequest({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'bye' }] }],
    });
    expect(hashRequest(a)).not.toBe(hashRequest(b));
  });

  it('hash changes when system prompt changes', () => {
    const a = makeRequest();
    const b = makeRequest({ system: [{ type: 'text', text: 'different' }] });
    expect(hashRequest(a)).not.toBe(hashRequest(b));
  });

  it('hash changes when tools change', () => {
    const a = makeRequest();
    const b = makeRequest({
      tools: [
        {
          name: 'read',
          description: 'Read a file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    });
    expect(hashRequest(a)).not.toBe(hashRequest(b));
  });

  it('ignores the local message fields the provider never sees', () => {
    // `Request.messages` is the live `ctx.messages` array. Its entries carry
    // `ts` (wall clock), `_estTokens` (a mutation-time cache) and `origin`,
    // none of which reach the provider. Hashing them made the digest a
    // function of *when* the run happened, so a recorded response could never
    // be looked up again and `mode: 'replay'` threw on its first call.
    const bare = makeRequest({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });
    const decorated = makeRequest({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          ts: '2026-08-11T10:00:00.000Z',
          _estTokens: 7,
          origin: 'user_input',
        },
      ],
    });
    const decoratedLater = makeRequest({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          ts: '2026-08-12T22:31:04.000Z',
          _estTokens: 9,
          origin: 'runtime',
        },
      ],
    });
    expect(hashRequest(decorated)).toBe(hashRequest(bare));
    expect(hashRequest(decoratedLater)).toBe(hashRequest(bare));
  });

  it('hash is stable across key insertion order (deep sort)', () => {
    const a = {
      model: 'm',
      system: undefined,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      maxTokens: 100,
      tools: undefined,
    } as never as Request;
    const b = {
      maxTokens: 100,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      model: 'm',
    } as never as Request;
    expect(hashRequest(a)).toBe(hashRequest(b));
  });

  it('stableStringify sorts nested object keys', () => {
    const a = stableStringify({ b: 1, a: { d: 2, c: 3 } });
    const b = stableStringify({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it('stableStringify preserves array order (arrays are sequences)', () => {
    expect(stableStringify([1, 2, 3])).toBe('[1,2,3]');
    expect(stableStringify([3, 2, 1])).toBe('[3,2,1]');
  });
});

describe('ReplayLogStore', () => {
  let dir: string;
  let store: ReplayLogStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-log-'));
    store = new ReplayLogStore({ dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns empty when no file exists', async () => {
    expect(await store.load('s1')).toEqual([]);
    expect(await store.lookup('s1', 'sha256:00')).toBeNull();
  });

  it('records a request/response and looks it up by computed hash', async () => {
    const req = makeRequest();
    const res = makeResponse();
    const hash = await store.record({ sessionId: 's1', request: req, response: res });
    expect(hash).toMatch(/^sha256:/);
    const entry = await store.lookup('s1', hash);
    expect(entry).not.toBeNull();
    expect(entry!.request.model).toBe('claude-test');
    expect(entry!.response.content[0]).toMatchObject({ type: 'text', text: 'hello' });
    expect(typeof entry!.ts).toBe('string');
  });

  it('record is idempotent on hash — second call for same hash is a no-op', async () => {
    const req = makeRequest();
    const res1 = makeResponse({ content: [{ type: 'text', text: 'first' }] });
    const res2 = makeResponse({ content: [{ type: 'text', text: 'second' }] });
    const h1 = await store.record({ sessionId: 's1', request: req, response: res1 });
    const h2 = await store.record({ sessionId: 's1', request: req, response: res2 });
    expect(h1).toBe(h2);
    const entries = await store.load('s1');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.response.content[0]).toMatchObject({ text: 'first' });
  });

  it('persists across store instances', async () => {
    const req = makeRequest();
    await store.record({ sessionId: 's1', request: req, response: makeResponse() });
    const store2 = new ReplayLogStore({ dir });
    const entries = await store2.load('s1');
    expect(entries).toHaveLength(1);
  });

  it('isolates sessions — recording for s1 does not leak to s2', async () => {
    const req = makeRequest();
    await store.record({ sessionId: 's1', request: req, response: makeResponse() });
    expect(await store.load('s2')).toEqual([]);
    const hash = hashRequest(req);
    expect(await store.lookup('s2', hash)).toBeNull();
  });

  it('rejects path-traversal session ids', async () => {
    await expect(store.load('../escape')).rejects.toThrow(/invalid sessionid/i);
  });

  it('corrupt JSON line is skipped (does not crash load)', async () => {
    await fs.writeFile(
      path.join(dir, 's1.replay.jsonl'),
      '{"hash":"sha256:00","ts":"2026-01-01T00:00:00Z","request":{"model":"m","messages":[],"maxTokens":1},"response":{"content":[],"stopReason":"end_turn","usage":{"input":0,"output":0},"model":"m"}}\n{not json\n',
      'utf8',
    );
    const store2 = new ReplayLogStore({ dir });
    const entries = await store2.load('s1');
    expect(entries).toHaveLength(1);
  });

  it('serializes concurrent records to the same session (no lost writes)', async () => {
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.record({
          sessionId: 's1',
          request: makeRequest({
            messages: [{ role: 'user', content: [{ type: 'text', text: `m${i}` }] }],
          }),
          response: makeResponse(),
        }),
      ),
    );
    const entries = await store.load('s1');
    expect(entries).toHaveLength(N);
  });

  it('lookup hydrates only the matched entry instead of reading the whole file', async () => {
    const reqA = makeRequest({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }],
    });
    const reqB = makeRequest({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'b' }] }],
    });
    const hashA = await store.record({
      sessionId: 's1',
      request: reqA,
      response: makeResponse({ content: [{ type: 'text', text: 'first' }] }),
    });
    await store.record({
      sessionId: 's1',
      request: reqB,
      response: makeResponse({ content: [{ type: 'text', text: 'second' }] }),
    });

    const readFileSpy = vi.spyOn(fs, 'readFile');
    const entry = await store.lookup('s1', hashA);

    expect(entry?.response.content[0]).toMatchObject({ text: 'first' });
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('appends to file rather than rewriting entire file on each record', async () => {
    for (let i = 0; i < 5; i++) {
      await store.record({
        sessionId: 's1',
        request: makeRequest({
          messages: [{ role: 'user', content: [{ type: 'text', text: `m${i}` }] }],
        }),
        response: makeResponse(),
      });
    }
    const filePath = path.join(dir, 's1.replay.jsonl');
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(5);
    // Verify entries are in insertion order.
    const entries = await store.load('s1');
    expect(entries).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(entries[i]!.request.messages[0]!.content).toMatchObject([
        { type: 'text', text: `m${i}` },
      ]);
    }
  });

  it('compacts when maxEntries is exceeded, keeping only the most recent entries', async () => {
    const smallStore = new ReplayLogStore({ dir, maxEntries: 5 });
    for (let i = 0; i < 8; i++) {
      await smallStore.record({
        sessionId: 's1',
        request: makeRequest({
          messages: [{ role: 'user', content: [{ type: 'text', text: `m${i}` }] }],
        }),
        response: makeResponse(),
      });
    }
    const entries = await smallStore.load('s1');
    expect(entries).toHaveLength(5);
    expect(entries[0]!.request.messages[0]!.content).toMatchObject([{ type: 'text', text: 'm3' }]);
    expect(entries[4]!.request.messages[0]!.content).toMatchObject([{ type: 'text', text: 'm7' }]);
  });

  it('fresh store instance loads compacted file and returns correct count', async () => {
    const smallStore = new ReplayLogStore({ dir, maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      await smallStore.record({
        sessionId: 's1',
        request: makeRequest({
          messages: [{ role: 'user', content: [{ type: 'text', text: `m${i}` }] }],
        }),
        response: makeResponse(),
      });
    }
    const freshStore = new ReplayLogStore({ dir });
    const entries = await freshStore.load('s1');
    expect(entries).toHaveLength(3);
    expect(entries[0]!.request.messages[0]!.content).toMatchObject([{ type: 'text', text: 'm2' }]);
    expect(entries[2]!.request.messages[0]!.content).toMatchObject([{ type: 'text', text: 'm4' }]);
  });

  // ── storage.* event emissions ───────────────────────────────────────────

  it('emits storage.write with operation record on successful record()', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const loggedStore = new ReplayLogStore({ dir, events });
    const req = makeRequest();
    const res = makeResponse();
    const hash = await loggedStore.record({ sessionId: 's1', request: req, response: res });
    expect(hash).toMatch(/^sha256:/);
    expect(events.emit).toHaveBeenCalledWith(
      'storage.write',
      expect.objectContaining({
        store: 'replay',
        operation: 'record',
        outcome: 'success',
        sessionId: 's1',
      }),
    );
  });

  it('emits storage.read with outcome failure when load() encounters an unreadable file', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const loggedStore = new ReplayLogStore({ dir, events });
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await realFs.writeFile(
      path.join(dir, 's1.replay.jsonl'),
      '{"hash":"sha256:' +
        '0'.repeat(64) +
        '","ts":"2026-01-01T00:00:00Z","request":{"model":"m","messages":[],"maxTokens":1},"response":{"content":[],"stopReason":"end_turn","usage":{"input":0,"output":0},"model":"m"}}\n',
      'utf8',
    );
    const openSpy = vi
      .spyOn(fs, 'open')
      .mockRejectedValueOnce(
        Object.assign(new Error('Permission denied'), { code: 'EACCES' }) as never,
      );
    try {
      await expect(loggedStore.load('s1')).rejects.toThrow('Permission denied');
      expect(events.emit).toHaveBeenCalledWith(
        'storage.read',
        expect.objectContaining({
          store: 'replay',
          operation: 'load',
          outcome: 'failure',
          sessionId: 's1',
          error: expect.stringContaining('EACCES'),
        }),
      );
    } finally {
      openSpy.mockRestore();
    }
  });

  it('emits storage.write with operation compact when record() evicts oldest entries', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const smallStore = new ReplayLogStore({ dir, maxEntries: 3, events });
    for (let i = 0; i < 5; i++) {
      await smallStore.record({
        sessionId: 's1',
        request: makeRequest({
          messages: [{ role: 'user', content: [{ type: 'text', text: `m${i}` }] }],
        }),
        response: makeResponse(),
      });
    }
    const compactCalls = (events.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([event, payload]) =>
        event === 'storage.write' &&
        (payload as { operation: string }).operation === 'compact' &&
        (payload as { sessionId: string }).sessionId === 's1',
    );
    expect(compactCalls.length).toBeGreaterThanOrEqual(1);
    expect(compactCalls[0]![1]).toMatchObject({
      store: 'replay',
      operation: 'compact',
      outcome: 'success',
    });
  });

  it('emits storage.error when record() encounters a write failure', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const loggedStore = new ReplayLogStore({ dir, events });
    fs.appendFile.mockRejectedValueOnce(
      Object.assign(new Error('No space left on device'), { code: 'ENOSPC' }),
    );
    try {
      await expect(
        loggedStore.record({ sessionId: 's1', request: makeRequest(), response: makeResponse() }),
      ).rejects.toThrow('No space left on device');
      expect(events.emit).toHaveBeenCalledWith(
        'storage.error',
        expect.objectContaining({
          store: 'replay',
          operation: 'record',
          outcome: 'failure',
          sessionId: 's1',
          error: expect.stringContaining('ENOSPC'),
        }),
      );
    } finally {
      fs.appendFile.mockReset();
    }
  });

  it('emits storage.read with outcome success when lookup() finds a matching entry', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const loggedStore = new ReplayLogStore({ dir, events });
    const req = makeRequest();
    const res = makeResponse();
    const hash = await loggedStore.record({ sessionId: 's1', request: req, response: res });
    events.emit = vi.fn(); // clear record() emissions
    await loggedStore.lookup('s1', hash);
    expect(events.emit).toHaveBeenCalledWith(
      'storage.read',
      expect.objectContaining({
        store: 'replay',
        operation: 'lookup',
        outcome: 'success',
        sessionId: 's1',
      }),
    );
  });

  it('emits storage.read with outcome failure when lookup() encounters an unreadable file', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const loggedStore = new ReplayLogStore({ dir, events });
    const req = makeRequest();
    const hash = hashRequest(req);
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await realFs.writeFile(
      path.join(dir, 's1.replay.jsonl'),
      JSON.stringify({
        hash,
        ts: '2026-01-01T00:00:00Z',
        request: { model: 'm', messages: [], maxTokens: 1 },
        response: {
          content: [],
          stopReason: 'end_turn',
          usage: { input: 0, output: 0 },
          model: 'm',
        },
      }) + '\n',
      'utf8',
    );
    const openSpy = vi
      .spyOn(fs, 'open')
      .mockRejectedValueOnce(
        Object.assign(new Error('EACCES permission denied'), { code: 'EACCES' }) as never,
      );
    try {
      await expect(loggedStore.lookup('s1', hash)).rejects.toThrow('EACCES');
      expect(events.emit).toHaveBeenCalledWith(
        'storage.read',
        expect.objectContaining({
          store: 'replay',
          operation: 'lookup',
          outcome: 'failure',
          error: expect.stringContaining('EACCES'),
        }),
      );
    } finally {
      openSpy.mockRestore();
    }
  });
});
