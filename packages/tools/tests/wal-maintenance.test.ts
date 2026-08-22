import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Ref } from '../src/codebase-index/schema.js';
import { WalMaintenance } from '../src/codebase-index/wal-maintenance.js';
import { IndexStore } from '../src/codebase-index/writer.js';

// ─── Scheduler unit tests ────────────────────────────────────────────────────

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let seq = 0;
  return {
    setTimeoutFn: ((fn: () => void, _ms: number) => {
      const id = ++seq;
      pending.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutFn: ((id: unknown) => {
      pending.delete(id as number);
    }) as typeof clearTimeout,
    advance: () => {
      // Fire all pending timers (the scheduler holds at most one).
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    unrefed: [] as Array<{ unref?: () => void }>,
  };
}

describe('WalMaintenance scheduler', () => {
  it('fires checkpoint once after the idle window and never before', () => {
    const timers = fakeTimers();
    const checkpoint = vi.fn(() => true);
    const optimize = vi.fn();
    const m = new WalMaintenance({ checkpoint, optimize }, { ...timers });

    m.notifyWriteCompleted();
    expect(checkpoint).not.toHaveBeenCalled();
    timers.advance();
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(optimize).not.toHaveBeenCalled();
    expect(m.armed).toBe(false);
  });

  it('slides on repeated writes — a burst fires maintenance once, at the end', () => {
    const timers = fakeTimers();
    const checkpoint = vi.fn(() => true);
    const m = new WalMaintenance({ checkpoint, optimize: () => {} }, { ...timers });

    m.notifyWriteCompleted();
    // Second write arrives before the window elapses: timer re-arms.
    m.notifyWriteCompleted();
    m.notifyWriteCompleted();
    timers.advance();
    expect(checkpoint).toHaveBeenCalledTimes(1);
    // And no refire until the next write arms it again.
    timers.advance();
    expect(checkpoint).toHaveBeenCalledTimes(1);
  });

  it('runs optimize on the configured cadence, not every fire', () => {
    const timers = fakeTimers();
    const optimize = vi.fn();
    const m = new WalMaintenance(
      { checkpoint: () => true, optimize },
      { ...timers, optimizeEvery: 3 },
    );

    for (let i = 1; i <= 7; i++) {
      m.notifyWriteCompleted();
      timers.advance();
    }
    // Fires 1..7; optimize on 3 and 6.
    expect(optimize).toHaveBeenCalledTimes(2);
  });

  it('dispose cancels the pending timer and stops all maintenance', () => {
    const timers = fakeTimers();
    const checkpoint = vi.fn(() => true);
    const m = new WalMaintenance({ checkpoint, optimize: () => {} }, { ...timers });

    m.notifyWriteCompleted();
    expect(m.armed).toBe(true);
    m.dispose();
    expect(m.armed).toBe(false);
    timers.advance();
    expect(checkpoint).not.toHaveBeenCalled();
    // Notifications after dispose are ignored.
    m.notifyWriteCompleted();
    expect(m.armed).toBe(false);
  });

  it('a throwing checkpoint hook never escapes the fire', () => {
    const timers = fakeTimers();
    const optimize = vi.fn();
    const m = new WalMaintenance(
      {
        checkpoint: () => {
          throw new Error('boom');
        },
        optimize,
      },
      { ...timers, optimizeEvery: 1 },
    );
    m.notifyWriteCompleted();
    expect(() => timers.advance()).not.toThrow();
    expect(optimize).toHaveBeenCalledTimes(1);
  });
});

// ─── Store-level WAL shrink test ─────────────────────────────────────────────

const storeRoots: string[] = [];
afterAll(() => {
  for (const root of storeRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('IndexStore.checkpointWal (P4.14)', () => {
  it('truncates the WAL after write churn once readers are gone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wstack-wal-maint-'));
    storeRoots.push(root);
    const indexDir = path.join(root, '.idx');
    const dbPath = path.join(indexDir, 'index.db');
    const walPath = `${dbPath}-wal`;

    const store = new IndexStore(root, { indexDir });
    try {
      // Enough rows to leave real frames behind in the WAL.
      const symbol = (n: number) => ({
        id: 0,
        lang: 'ts' as const,
        kind: 'function' as const,
        name: `symbol_${n}`,
        file: `src/file_${n % 5}.ts`,
        line: n + 1,
        col: 1,
        signature: '',
        docComment: '',
        scope: '',
        text: `symbol_${n}`,
      });
      const ref = (n: number): Ref => ({
        id: 0,
        fromId: 0,
        toName: `symbol_${(n + 1) % 250}`,
        toId: undefined,
        callType: 'call' as const,
        line: n,
        lang: 'ts',
        module: undefined,
        toFile: undefined,
      });
      for (let batch = 0; batch < 5; batch++) {
        const entries = Array.from({ length: 50 }, (_, i) => {
          const n = batch * 50 + i;
          return {
            file: `src/file_${i}.ts`,
            lang: 'ts' as const,
            symbols: [symbol(n)],
            refs: [ref(n)],
            mtimeMs: Date.now(),
            symbolCount: 1,
            contentHash: `hash_${batch}_${i}`,
          };
        });
        store.commitBatch(entries, { deleteForFiles: entries.map((e) => e.file) });
      }
      const walSizeBefore = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
      expect(walSizeBefore).toBeGreaterThan(0);

      // No readers hold the WAL here — the checkpoint must complete and
      // reset the WAL file toward zero bytes.
      const ok = store.checkpointWal();
      expect(ok).toBe(true);
      const walSizeAfter = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
      expect(walSizeAfter).toBeLessThan(walSizeBefore);

      // Idempotent: a second checkpoint on a clean WAL still succeeds.
      expect(store.checkpointWal()).toBe(true);
      // Data survived: every batch's rows are queryable.
      const result = store.searchRanked('symbol_4', undefined, 5);
      expect(result.total).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});
