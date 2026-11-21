// Two waiters read the same stale (dead-pid) claim-store lock. A breaks it,
// creates its own lock and enters; B, whose staleness check ran before A's
// rename, renames the path afterwards. B must capture A's live lock, link it
// back and keep waiting — renaming it away let both into the critical section.
// Gating: AsyncLocalStorage tags the actors, B's rename waits until A is inside
// the critical section, and B's next open('wx') is observed while A holds.
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const g = vi.hoisted(() => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  return {
    deferred,
    actor: undefined as unknown as { getStore(): string | undefined },
    lockPath: '',
    armed: false,
    aInCs: deferred(),
    bRenamed: false,
    bOpenAfterRename: deferred(),
    bOpenOk: undefined as boolean | undefined,
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: (async (from: unknown, to: unknown) => {
      if (g.armed && String(from) === g.lockPath && g.actor.getStore() === 'B' && !g.bRenamed) {
        await g.aInCs.promise; // B verified X earlier; rename only once A holds the lock
        g.bRenamed = true;
      }
      return real.rename(from as string, to as string);
    }) as typeof real.rename,
    open: (async (file: unknown, flags: unknown, ...rest: unknown[]) => {
      const call = (real.open as (...a: unknown[]) => Promise<unknown>)(file, flags, ...rest);
      if (
        g.armed &&
        String(file) === g.lockPath &&
        flags === 'wx' &&
        g.actor.getStore() === 'B' &&
        g.bRenamed &&
        g.bOpenOk === undefined
      ) {
        try {
          const handle = await call;
          g.bOpenOk = true;
          g.bOpenAfterRename.resolve();
          return handle;
        } catch (error) {
          g.bOpenOk = false;
          g.bOpenAfterRename.resolve();
          throw error;
        }
      }
      return call;
    }) as typeof real.open,
  };
});

g.actor = new AsyncLocalStorage<string>();
const actor = g.actor as AsyncLocalStorage<string>;
const { withStoreLock } = await import('../src/review-claim-store-lock.js');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DEAD_PID = 2_147_483_646; // never a live pid
// The race is about ordering, not the wait limit: B waits while A holds the lock, and on a
// loaded runner the default limit can run out first. A hang still fails at the test timeout.
const RACE_WAIT_MS = 60_000;

function staleStore(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'review-claim-lock-race-'));
  dirs.push(dir);
  g.lockPath = path.join(dir, 'review-claims.jsonl.lock');
  writeFileSync(g.lockPath, `${hostname()}:${DEAD_PID}`);
  return dir;
}

it('breaking a stale lock never displaces a fresh holder (gated race)', async () => {
  const dir = staleStore();
  g.armed = true;
  g.bRenamed = false;
  g.bOpenOk = undefined;
  g.aInCs = g.deferred();
  g.bOpenAfterRename = g.deferred();
  let holders = 0;
  let maxHolders = 0;
  const order: string[] = [];
  const releaseA = g.deferred();
  const b = actor.run('B', () =>
    withStoreLock(
      dir,
      async () => {
        holders++;
        maxHolders = Math.max(maxHolders, holders);
        order.push('B');
        holders--;
      },
      RACE_WAIT_MS,
    ),
  );
  const a = actor.run('A', () =>
    withStoreLock(
      dir,
      async () => {
        holders++;
        maxHolders = Math.max(maxHolders, holders);
        order.push('A');
        g.aInCs.resolve();
        await releaseA.promise;
        holders--;
      },
      RACE_WAIT_MS,
    ),
  );
  await g.bOpenAfterRename.promise;
  expect(g.bOpenOk).toBe(false);
  releaseA.resolve();
  await Promise.all([a, b]);
  g.armed = false;
  expect(maxHolders).toBe(1);
  expect(order).toEqual(['A', 'B']);
  expect(existsSync(g.lockPath), 'no orphaned lock file').toBe(false);
});
