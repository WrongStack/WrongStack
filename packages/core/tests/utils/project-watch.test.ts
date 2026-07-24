import { describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  watchCalls: [] as string[],
  listeners: new Map<string, (eventType: string, filename: string | Buffer | null) => void>(),
  errorHandlers: new Map<string, (error: unknown) => void>(),
  closed: [] as string[],
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    watch: vi.fn(
      (
        root: string,
        _options: unknown,
        listener: (eventType: string, filename: string | Buffer | null) => void,
      ) => {
        io.watchCalls.push(root);
        io.listeners.set(root, listener);
        return {
          on: (event: string, handler: (error: unknown) => void) => {
            if (event === 'error') io.errorHandlers.set(root, handler);
          },
          close: () => {
            io.closed.push(root);
          },
          unref: vi.fn(),
        };
      },
    ),
  };
});

import * as path from 'node:path';
import { watchProjectTree } from '../../src/utils/project-watch.js';

/** Distinct fake roots per test so the process-wide registry never collides. */
let rootSeq = 0;
function freshRoot(): string {
  return path.resolve(`/watched/proj-${process.pid}-${rootSeq++}`);
}

describe('watchProjectTree', () => {
  it('shares one OS watcher across subscribers on the same root and fans events out', () => {
    const root = freshRoot();
    const seenA: Array<string | null> = [];
    const seenB: Array<string | null> = [];
    const subA = watchProjectTree(root, (e) => seenA.push(e.filename));
    const subB = watchProjectTree(root, (e) => seenB.push(e.filename));

    expect(io.watchCalls.filter((r) => r === root)).toHaveLength(1);

    io.listeners.get(root)?.('change', 'src/a.ts');
    expect(seenA).toEqual(['src/a.ts']);
    expect(seenB).toEqual(['src/a.ts']);

    // First close keeps the shared watcher alive for the remaining subscriber.
    subA.close();
    io.listeners.get(root)?.('rename', null);
    expect(seenA).toHaveLength(1);
    expect(seenB).toEqual(['src/a.ts', null]);

    // Last close tears the OS watcher down.
    subB.close();
    expect(io.closed).toContain(root);

    // A new subscriber after teardown gets a fresh OS watcher.
    const subC = watchProjectTree(root, () => {});
    expect(io.watchCalls.filter((r) => r === root)).toHaveLength(2);
    subC.close();
  });

  it('a throwing listener does not break other subscribers and reports via its own onError', () => {
    const root = freshRoot();
    const errors: unknown[] = [];
    const seen: Array<string | null> = [];
    const bad = watchProjectTree(
      root,
      () => {
        throw new Error('listener boom');
      },
      { onError: (e) => errors.push(e) },
    );
    const good = watchProjectTree(root, (e) => seen.push(e.filename));

    io.listeners.get(root)?.('change', 'x.ts');
    expect(seen).toEqual(['x.ts']);
    expect(errors).toHaveLength(1);
    bad.close();
    good.close();
  });

  it('a watcher error marks the entry dead, notifies subscribers, and allows a fresh watcher later', () => {
    const root = freshRoot();
    const errors: unknown[] = [];
    const sub = watchProjectTree(root, () => {}, { onError: (e) => errors.push(e) });

    io.errorHandlers.get(root)?.(new Error('EPERM'));
    expect(errors).toHaveLength(1);

    // The dead entry is not reused — a new acquire opens a new OS watcher.
    const sub2 = watchProjectTree(root, () => {});
    expect(io.watchCalls.filter((r) => r === root)).toHaveLength(2);
    sub.close();
    sub2.close();
  });
});
