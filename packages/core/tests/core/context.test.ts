import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Context } from '../../src/core/context.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import type { Provider, SessionWriter, TextBlock } from '../../src/index.js';

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
    ctx.onWorkingDirChanged((n, o) => { newDir = n; oldDir = o; });

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
    const unsub = ctx.onWorkingDirChanged(() => { called = true; });

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
    ctx.onWorkingDirChanged(() => { count++; });
    ctx.onWorkingDirChanged(() => { count++; });

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
    ctx.onWorkingDirChanged(() => { throw new Error('boom'); });
    ctx.onWorkingDirChanged(() => { secondCalled = true; });

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
});
