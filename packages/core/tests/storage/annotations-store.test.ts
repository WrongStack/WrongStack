import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '../../src/kernel/events.js';
import { AnnotationsStore } from '../../src/storage/annotations-store.js';

// vi.mock is hoisted above imports.  The factory uses vi.importActual to lazily
// get the real module, avoiding TDZ issues.  The returned plain object
// replaces 'node:fs/promises' before the second import runs.
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

  // In-memory store so writes and reads share state within a test.
  const store: Record<string, string> = {};

  const mockFs = {
    readFile: vi.fn(async (filepath: string | Buffer | URL) => {
      const k = String(filepath);
      if (store[k] !== undefined) return store[k];
      return await real.readFile(k, 'utf8');
    }),
    writeFile: vi.fn(async (filepath: string | Buffer | URL, data: string) => {
      const k = String(filepath);
      store[k] = data;
      await real.writeFile(k, data, 'utf8');
    }),
    mkdir: real.mkdir,
    mkdtemp: real.mkdtemp,
    rm: real.rm,
    access: real.access,
    rename: real.rename,
    unlink: real.unlink,
    open: real.open,
    close: real.close,
    readdir: real.readdir,
    chmod: real.chmod,
    copyFile: real.copyFile,
    stat: real.stat,
    read: real.read,
    write: real.write,
    fd: real.fd,
    fsync: real.fsync,
  };
  return mockFs;
});

import * as fs from 'node:fs/promises';

let dir: string;
let store: AnnotationsStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'annotations-'));
  store = new AnnotationsStore({ dir });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('AnnotationsStore', () => {
  it('returns [] for a session with no file', async () => {
    expect(await store.list('fresh')).toEqual([]);
  });

  it('adds and reads back annotations in insertion order', async () => {
    const a = await store.add({ sessionId: 's1', atEventIndex: 1, authorId: 'p1', text: 'first' });
    const b = await store.add({ sessionId: 's1', atEventIndex: 2, authorId: 'p2', text: 'second' });
    expect(a.id).not.toBe(b.id);
    const list = await store.list('s1');
    expect(list).toHaveLength(2);
    expect(list[0]!.text).toBe('first');
    expect(list[1]!.text).toBe('second');
  });

  it('trims surrounding whitespace', async () => {
    const a = await store.add({ sessionId: 's1', atEventIndex: 1, authorId: 'p1', text: '  hi  ' });
    expect(a.text).toBe('hi');
  });

  it('persists across store instances', async () => {
    await store.add({ sessionId: 's1', atEventIndex: 1, authorId: 'p1', text: 'persistent' });
    const store2 = new AnnotationsStore({ dir });
    const list = await store2.list('s1');
    expect(list).toHaveLength(1);
    expect(list[0]!.text).toBe('persistent');
  });

  it('resolve marks an annotation resolved', async () => {
    const a = await store.add({ sessionId: 's1', atEventIndex: 5, authorId: 'p1', text: 'todo' });
    const r = await store.resolve({ sessionId: 's1', annotationId: a.id, resolvedBy: 'p2' });
    expect(r).not.toBeNull();
    expect(r!.resolved).toBe(true);
    expect(r!.resolvedBy).toBe('p2');
    expect(typeof r!.resolvedAt).toBe('string');
  });

  it('listOpen returns only unresolved, newest first', async () => {
    const a = await store.add({ sessionId: 's1', atEventIndex: 1, authorId: 'p1', text: 'old' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.add({ sessionId: 's1', atEventIndex: 2, authorId: 'p1', text: 'new' });
    await store.resolve({ sessionId: 's1', annotationId: a.id, resolvedBy: 'p1' });
    const open = await store.listOpen('s1');
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(b.id);
  });

  it('concurrent adds serialize without lost writes', async () => {
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.add({ sessionId: 's1', atEventIndex: i, authorId: `p${i}`, text: `t${i}` }),
      ),
    );
    const list = await store.list('s1');
    expect(list).toHaveLength(N);
    expect(new Set(list.map((a) => a.text)).size).toBe(N);
  });

  it('rejects path traversal in session ids', async () => {
    await expect(store.list('../escape')).rejects.toThrow(/invalid sessionid/i);
  });

  it('accepts date-sharded session ids', async () => {
    const sharded = '2026-06-11/sess_01JX2S9V7T5M6N7P8Q9R0STXVW';
    const added = await store.add({ sessionId: sharded, atEventIndex: 0, authorId: 'p1', text: 'sharded' });
    expect(added.sessionId).toBe(sharded);
    expect(await store.list(sharded)).toHaveLength(1);
  });

  it('corrupt JSON treated as empty store', async () => {
    await fs.mkdir(path.join(dir, '2026-06-11'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '2026-06-11', 's1.annotations.json'),
      '{not json',
    );
    expect(await store.list('2026-06-11/s1')).toEqual([]);
  });

  it('MAX_ANNOTATIONS eviction emits storage.write operation evict', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const loggedStore = new AnnotationsStore({ dir, events });
    for (let i = 0; i < 1001; i++) {
      await loggedStore.add({ sessionId: 's1', atEventIndex: i, authorId: 'p1', text: `t${i}` });
    }
    const evictCalls = (events.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev, payload]) =>
        ev === 'storage.write'
        && (payload as { operation: string }).operation === 'evict',
    );
    expect(evictCalls).toHaveLength(1);
  }, 20000);

  // ── storage.* event tests ─────────────────────────────────────────────────

  it('emits storage.read with outcome success when list() finds existing annotations', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    await fs.mkdir(path.join(dir, '2026-06-11'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '2026-06-11', 's1.annotations.json'),
      JSON.stringify({
        version: 1,
        annotations: [
          {
            id: 'a1',
            sessionId: '2026-06-11/s1',
            atEventIndex: 3,
            authorId: 'user1',
            authorRole: 'annotator',
            text: 'found me',
            createdAt: '2026-06-11T10:00:00.000Z',
            resolved: false,
          },
        ],
      }),
    );
    const loggedStore = new AnnotationsStore({ dir, events });
    const list = await loggedStore.list('2026-06-11/s1');
    expect(list).toHaveLength(1);
    expect(list[0]!.text).toBe('found me');
    expect(emitSpy).toHaveBeenCalledWith('storage.read', expect.objectContaining({
      store: 'annotations',
      operation: 'list',
      outcome: 'success',
      sessionId: '2026-06-11/s1',
    }));
  });

  it('emits storage.read with outcome success when list() finds no file (ENOENT)', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const loggedStore = new AnnotationsStore({ dir, events });
    const list = await loggedStore.list('brand-new');
    expect(list).toEqual([]);
    expect(emitSpy).toHaveBeenCalledWith('storage.read', expect.objectContaining({
      store: 'annotations',
      operation: 'list',
      outcome: 'success',
      sessionId: 'brand-new',
    }));
  });

  it('emits storage.read with outcome failure when list() encounters a disk I/O error', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const loggedStore = new AnnotationsStore({ dir, events });
    const fp = path.join(dir, 'io-error.annotations.json');
    await fs.writeFile(fp, JSON.stringify({ version: 1, annotations: [] }), 'utf8');
    // Make readFile reject for this file
    fs.readFile.mockRejectedValueOnce(
      Object.assign(new Error('EACCES permission denied'), { code: 'EACCES' }),
    );
    try {
      const list = await loggedStore.list('io-error');
      expect(list).toEqual([]);
      expect(emitSpy).toHaveBeenCalledWith('storage.read', expect.objectContaining({
        store: 'annotations',
        operation: 'list',
        outcome: 'failure',
        sessionId: 'io-error',
        error: expect.stringContaining('EACCES'),
      }));
    } finally {
      fs.readFile.mockReset();
    }
  });

  it('emits storage.write with operation add on successful add()', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const loggedStore = new AnnotationsStore({ dir, events });
    await loggedStore.add({ sessionId: 's1', atEventIndex: 1, authorId: 'alice', text: 'needs review' });
    expect(emitSpy).toHaveBeenCalledWith('storage.write', expect.objectContaining({
      store: 'annotations',
      operation: 'add',
      outcome: 'success',
      sessionId: 's1',
    }));
  });

  it('emits storage.write with operation evict when add() exceeds MAX_ANNOTATIONS', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const loggedStore = new AnnotationsStore({ dir, events });
    for (let i = 0; i < 1001; i++) {
      await loggedStore.add({ sessionId: 's1', atEventIndex: i, authorId: 'alice', text: `t${i}` });
    }
    const evict = emitSpy.mock.calls.find(
      ([ev, payload]) =>
        ev === 'storage.write'
        && (payload as { operation: string }).operation === 'evict',
    );
    expect(evict).toBeDefined();
    expect(evict![1]).toMatchObject({ store: 'annotations', operation: 'evict', outcome: 'success' });
  }, 20000);

  it('emits storage.write with operation resolve on successful resolve()', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const loggedStore = new AnnotationsStore({ dir, events });
    const added = await loggedStore.add({ sessionId: 's1', atEventIndex: 1, authorId: 'alice', text: 'fix this' });
    await loggedStore.resolve({ sessionId: 's1', annotationId: added.id, resolvedBy: 'bob' });
    expect(emitSpy).toHaveBeenCalledWith('storage.write', expect.objectContaining({
      store: 'annotations',
      operation: 'resolve',
      outcome: 'success',
      sessionId: 's1',
    }));
  });

  it('emits storage.error when add() encounters a write failure', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const loggedStore = new AnnotationsStore({ dir, events });
    fs.writeFile.mockRejectedValueOnce(
      Object.assign(new Error('ENOSPC no space left'), { code: 'ENOSPC' }),
    );
    try {
      await expect(
        loggedStore.add({ sessionId: 's1', atEventIndex: 1, authorId: 'alice', text: 'test' }),
      ).rejects.toThrow('ENOSPC');
      expect(emitSpy).toHaveBeenCalledWith('storage.error', expect.objectContaining({
        store: 'annotations',
        operation: 'add',
        outcome: 'failure',
        error: expect.stringContaining('ENOSPC'),
      }));
    } finally {
      fs.writeFile.mockReset();
    }
  });

  it('emits storage.error when resolve() encounters a write failure', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const loggedStore = new AnnotationsStore({ dir, events });
    const added = await loggedStore.add({ sessionId: 's1', atEventIndex: 1, authorId: 'alice', text: 'fix this' });
    fs.writeFile.mockRejectedValueOnce(
      Object.assign(new Error('ENOSPC no space left'), { code: 'ENOSPC' }),
    );
    try {
      await expect(
        loggedStore.resolve({ sessionId: 's1', annotationId: added.id, resolvedBy: 'bob' }),
      ).rejects.toThrow('ENOSPC');
      expect(emitSpy).toHaveBeenCalledWith('storage.error', expect.objectContaining({
        store: 'annotations',
        operation: 'resolve',
        outcome: 'failure',
        error: expect.stringContaining('ENOSPC'),
      }));
    } finally {
      fs.writeFile.mockReset();
    }
  });
});
