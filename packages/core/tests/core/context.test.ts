import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Context, resolveEventSessionId } from '../../src/core/context.js';
import type { Provider, SessionWriter, TextBlock } from '../../src/index.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';

const fakeProvider = {} as Provider;
const fakeSession: SessionWriter = {
  id: 't',
  pendingToolUses: [],
  append: async () => undefined,
  appendBatch: async () => undefined,
  flush: async () => undefined,
  close: async () => undefined,
};

function mkContext(): Context {
  return new Context({
    systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
    provider: fakeProvider,
    session: fakeSession,
    signal: new AbortController().signal,
    tokenCounter: new DefaultTokenCounter(),
    cwd: '/tmp',
    projectRoot: '/tmp',
    model: 'm',
  });
}

describe('Context', () => {
  it('starts empty', () => {
    const ctx = mkContext();
    expect(ctx.messages).toEqual([]);
    expect(ctx.todos).toEqual([]);
    expect(ctx.readFiles.size).toBe(0);
    expect(ctx.meta).toEqual({});
  });

  it('persists the active Kanban identity in observable context metadata', () => {
    const ctx = mkContext();
    ctx.meta['kanban'] = { projectRoot: '/tmp', leaseId: 'lease-1' };
    const changes = vi.fn();
    ctx.state.onChange(changes);

    ctx.setCurrentKanbanTask('task-2', 'board-1');

    expect(ctx.currentKanbanTaskId).toBe('task-2');
    expect(ctx.currentKanbanBoardId).toBe('board-1');
    expect(ctx.meta['kanban']).toEqual({
      projectRoot: '/tmp',
      leaseId: 'lease-1',
      taskId: 'task-2',
      boardId: 'board-1',
    });
    expect(changes).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'meta_set', key: 'kanban' }),
      ctx.state,
    );
  });

  it('replaces and bounds provider memory evidence by source', () => {
    const ctx = mkContext();

    ctx.setMemoryEvidence('sage.tool-memory', ' first ');
    ctx.setMemoryEvidence('other', 'second');
    ctx.setMemoryEvidence('sage.tool-memory', 'x'.repeat(20), 5);

    expect(ctx.memoryEvidence).toEqual([
      { source: 'other', text: 'second' },
      { source: 'sage.tool-memory', text: 'xxxxx' },
    ]);
    ctx.clearMemoryEvidence('other');
    expect(ctx.memoryEvidence).toEqual([{ source: 'sage.tool-memory', text: 'xxxxx' }]);
    ctx.clearMemoryEvidence();
    expect(ctx.memoryEvidence).toEqual([]);
  });

  describe('run-pinned event session id', () => {
    it('falls back to the live session id outside a run', () => {
      const ctx = mkContext();
      expect(ctx.activeRunSessionId).toBeUndefined();
      expect(ctx.eventSessionId()).toBe('t');
      expect(resolveEventSessionId(ctx)).toBe('t');
    });

    it('prefers the pinned id while a run is active, then falls back after it clears', () => {
      // Regression: after a host-side session swap (WebUI session.new), late
      // events from the previous run must keep the old session id instead of
      // leaking into the new session's chat.
      const ctx = mkContext();
      ctx.activeRunSessionId = 'run-session-old';
      ctx.session = { ...fakeSession, id: 'session-new' };
      expect(ctx.eventSessionId()).toBe('run-session-old');
      expect(resolveEventSessionId(ctx)).toBe('run-session-old');

      ctx.activeRunSessionId = undefined;
      expect(ctx.eventSessionId()).toBe('session-new');
    });

    it('rejects stub contexts without a session id', () => {
      const stub = { activeRunSessionId: undefined, session: undefined } as unknown as Context;
      expect(() => resolveEventSessionId(stub)).toThrow(
        expect.objectContaining({ code: 'SESSION_ID_REQUIRED' }),
      );
    });

    it('persists late file events through the run-pinned writer after a session swap', () => {
      const oldAppend = vi.fn(async () => undefined);
      const newAppend = vi.fn(async () => undefined);
      const oldWriter: SessionWriter = { ...fakeSession, id: 'old', append: oldAppend };
      const newWriter: SessionWriter = { ...fakeSession, id: 'new', append: newAppend };
      const ctx = new Context({
        systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
        provider: { id: 'test-provider' } as Provider,
        session: oldWriter,
        signal: new AbortController().signal,
        tokenCounter: new DefaultTokenCounter(),
        cwd: '/tmp',
        projectRoot: '/tmp',
        model: 'm',
      });
      ctx.activeRunSessionId = oldWriter.id;
      ctx.activeRunSessionWriter = oldWriter;
      ctx.session = newWriter;

      ctx.recordFileEvent({
        operation: 'update',
        filePath: 'src/file.ts',
        absPath: '/tmp/src/file.ts',
        toolName: 'edit',
        toolUseId: 'tool-1',
      });

      expect(oldAppend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'file_event',
          sessionId: 'old',
        }),
      );
      expect(newAppend).not.toHaveBeenCalled();
      expect(ctx.fileEvents.at(-1)?.sessionId).toBe('old');
    });
  });

  it('recordRead tracks files + mtimes', () => {
    const ctx = mkContext();
    ctx.recordRead('/a/b.ts', 100);
    expect(ctx.hasRead('/a/b.ts')).toBe(true);
    expect(ctx.hasRead('/other')).toBe(false);
    expect(ctx.lastReadMtime('/a/b.ts')).toBe(100);
    expect(ctx.lastReadMtime('/missing')).toBeUndefined();
  });

  it('recordRead journals content hashes through capable session writers', () => {
    const observations: unknown[] = [];
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: {
        ...fakeSession,
        recordFileObservation: (input) => observations.push(input),
      },
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/tmp',
      projectRoot: '/tmp',
      model: 'm',
    });

    ctx.recordRead('/tmp/a.ts', 123, 'user', 'a'.repeat(64));
    expect(observations).toEqual([
      { path: '/tmp/a.ts', hash: 'a'.repeat(64), mtimeMs: 123, source: 'user' },
    ]);
  });

  it('usage delegates to tokenCounter', () => {
    const ctx = mkContext();
    ctx.tokenCounter.account({ input: 7, output: 3 }, 'm');
    const u = ctx.usage();
    expect(u.input).toBe(7);
    expect(u.output).toBe(3);
  });

  it('holds request creation until an in-flight model transition commits', async () => {
    const ctx = mkContext();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transition = ctx.runModelTransition(async () => {
      await gate;
      ctx.model = 'new-model';
    });
    let requestReady = false;
    const waiter = ctx.waitForModelTransition().then(() => {
      requestReady = true;
    });

    await Promise.resolve();
    expect(requestReady).toBe(false);
    release();
    await Promise.all([transition, waiter]);
    expect(requestReady).toBe(true);
    expect(ctx.model).toBe('new-model');
  });

  it('serializes overlapping model transitions in request order', async () => {
    const ctx = mkContext();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const first = ctx.runModelTransition(async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
    });
    const second = ctx.runModelTransition(() => {
      order.push('second');
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });
});

describe('Context.workingDir', () => {
  it('defaults to cwd when workingDir is not provided', () => {
    const ctx = mkContext();
    expect(ctx.workingDir).toBe('/tmp');
  });

  it('accepts an explicit workingDir in init', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/tmp',
      projectRoot: '/proj',
      workingDir: '/proj/src',
      model: 'm',
    });
    expect(ctx.workingDir).toBe('/proj/src');
  });
});

describe('Context.setWorkingDir', () => {
  it('refuses a working dir that spells inside the root but resolves outside it', () => {
    // Attacker goal: commit a symlink/junction to the repo, get the working
    // dir moved onto it, and every tool that resolves a relative path against
    // `workingDir` inherits the escape without ever naming a `../` path. This
    // setter is the amplifier for the whole lexical-containment class, so the
    // check has to be realpath-based, not spelling-based.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-wd-'));
    const root = path.join(base, 'proj');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    const link = path.join(root, 'escape');
    try {
      // Windows reports a junction as isSymbolicLink(); 'junction' is the only
      // link type creatable without elevation there.
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // no link privilege in this environment — nothing to assert
    }
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: root,
      projectRoot: root,
      model: 'm',
    });
    try {
      // `escape` is lexically inside `root` — the old check passed it.
      expect(() => ctx.setWorkingDir(link)).toThrow(/outside project root/);
      // A genuine subdirectory still works, so the guard is not just refusing
      // everything.
      const real = path.join(root, 'src');
      fs.mkdirSync(real);
      expect(ctx.setWorkingDir(real)).toBe(fs.realpathSync.native(real));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('changes workingDir to a subdirectory', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/proj',
      projectRoot: '/proj',
      model: 'm',
    });
    const result = ctx.setWorkingDir('/proj/src');
    // setWorkingDir returns path.resolve output — platform-native separators
    // (D:\proj\src on Windows), so build the expectation the same way.
    expect(result).toBe(path.resolve('/proj/src'));
    expect(ctx.workingDir).toBe(path.resolve('/proj/src'));
  });

  it('resolves relative paths against projectRoot', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/other',
      projectRoot: '/proj',
      model: 'm',
    });
    // 'src' relative → <projectRoot>/src
    const result = ctx.setWorkingDir('src');
    expect(result).toBe(path.resolve('/proj/src'));
    expect(ctx.workingDir).toBe(path.resolve('/proj/src'));
  });

  it('rejects paths outside projectRoot', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/proj',
      projectRoot: '/proj',
      model: 'm',
    });
    expect(() => ctx.setWorkingDir('/etc')).toThrow(/outside project root/);
  });

  it('rejects relative paths that escape via ..', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/proj',
      projectRoot: '/proj',
      model: 'm',
    });
    expect(() => ctx.setWorkingDir('../etc')).toThrow(/outside project root/);
  });

  it('returns the resolved path', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/proj',
      projectRoot: '/proj',
      model: 'm',
    });
    const result = ctx.setWorkingDir('/proj/src/lib');
    expect(result).toBe(path.resolve('/proj/src/lib'));
  });
});

describe('Context.onWorkingDirChanged', () => {
  it('fires callback when setWorkingDir is called', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/proj',
      projectRoot: '/proj',
      model: 'm',
    });

    let newDir = '';
    let oldDir = '';
    ctx.onWorkingDirChanged((n, o) => {
      newDir = n;
      oldDir = o;
    });

    ctx.setWorkingDir('/proj/src');
    expect(newDir).toBe(path.resolve('/proj/src'));
    expect(oldDir).toBe('/proj');
  });

  it('returns an unsubscribe function', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/proj',
      projectRoot: '/proj',
      model: 'm',
    });

    let called = false;
    const unsub = ctx.onWorkingDirChanged(() => {
      called = true;
    });

    // Unsubscribe before the change
    unsub();

    ctx.setWorkingDir('/proj/src');
    expect(called).toBe(false);
  });

  it('calls multiple subscribers', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/proj',
      projectRoot: '/proj',
      model: 'm',
    });

    let count = 0;
    ctx.onWorkingDirChanged(() => {
      count++;
    });
    ctx.onWorkingDirChanged(() => {
      count++;
    });

    ctx.setWorkingDir('/proj/src');
    expect(count).toBe(2);
  });

  it('swallows errors in callbacks so other listeners still fire', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/proj',
      projectRoot: '/proj',
      model: 'm',
    });

    let secondCalled = false;
    ctx.onWorkingDirChanged(() => {
      throw new Error('boom');
    });
    ctx.onWorkingDirChanged(() => {
      secondCalled = true;
    });

    // Should not throw — errors are swallowed
    expect(() => ctx.setWorkingDir('/proj/src')).not.toThrow();
    expect(secondCalled).toBe(true);
  });
});

describe('Context content-hash tracking', () => {
  it('recordRead stores the content hash when provided', () => {
    const ctx = mkContext();
    ctx.recordRead('/a/b.ts', 100, 'user', 'hash-1');
    expect(ctx.lastReadHash('/a/b.ts')).toBe('hash-1');
    expect(ctx.lastReadHash('/missing')).toBeUndefined();
  });

  it('a hash-less recordRead with the same mtime keeps the stored hash', () => {
    const ctx = mkContext();
    ctx.recordRead('/a/b.ts', 100, 'user', 'hash-1');
    ctx.recordRead('/a/b.ts', 100);
    expect(ctx.lastReadHash('/a/b.ts')).toBe('hash-1');
  });

  it('a hash-less recordRead with a different mtime drops the stale hash', () => {
    const ctx = mkContext();
    ctx.recordRead('/a/b.ts', 100, 'user', 'hash-1');
    ctx.recordRead('/a/b.ts', 200);
    expect(ctx.lastReadHash('/a/b.ts')).toBeUndefined();
    expect(ctx.lastReadMtime('/a/b.ts')).toBe(200);
  });

  it('write-tagged records also carry hashes', () => {
    const ctx = mkContext();
    ctx.recordRead('/a/b.ts', 100, 'write', 'hash-w');
    expect(ctx.lastReadHash('/a/b.ts')).toBe('hash-w');
    expect(ctx.hasRead('/a/b.ts')).toBe(false);
    expect(ctx.hasWritten('/a/b.ts')).toBe(true);
  });

  it('clearFileTracking clears hashes', () => {
    const ctx = mkContext();
    ctx.recordRead('/a/b.ts', 100, 'user', 'hash-1');
    ctx.clearFileTracking();
    expect(ctx.lastReadHash('/a/b.ts')).toBeUndefined();
  });

  it('recordFileEvent caps at MAX_FILE_EVENTS with oldest-first eviction', () => {
    const ctx = mkContext();
    const MAX = (Context as never as Record<string, number>)['MAX_FILE_EVENTS'] ?? 1000;
    const over = MAX + 10;

    for (let i = 0; i < over; i++) {
      ctx.recordFileEvent({
        operation: 'read',
        filePath: `src/file-${i}.ts`,
        absPath: `/tmp/src/file-${i}.ts`,
        toolName: 'read',
        toolUseId: `tu-${i}`,
      });
    }

    expect(ctx.fileEvents.length).toBeLessThanOrEqual(MAX);
    expect(ctx.fileEvents.length).toBe(MAX);

    // Oldest entries evicted; newest retained
    expect(ctx.fileEvents[0]?.toolUseId).toBe(`tu-${over - MAX}`);
    expect(ctx.fileEvents[MAX - 1]?.toolUseId).toBe(`tu-${over - 1}`);
  });
});
