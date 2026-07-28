/**
 * StorePool residency bounds.
 *
 * `release()` used to be an explicit no-op and the pool had no size cap, so a
 * host that switched projects (webui-server, HQ, the project server) accumulated
 * one permanently open SQLite connection per project — each carrying a 128MiB
 * page cache and a 512MiB mmap reservation on the balanced profile.
 */
import { describe, expect, it } from 'vitest';
import { StorePool } from '../src/codebase-index/writer-store-pool.js';

class FakeStore {
  closed = false;
  constructor(public readonly label: string) {}
  close(): void {
    this.closed = true;
  }
}

function makePool(max: number) {
  const created: FakeStore[] = [];
  const pool = new StorePool<FakeStore>((projectRoot, opts) => {
    const store = new FakeStore(`${projectRoot}|${opts?.indexDir ?? ''}`);
    created.push(store);
    return store;
  }, max);
  return { pool, created };
}

describe('StorePool warm-connection bounds', () => {
  it('reuses the same connection for one project', () => {
    const { pool, created } = makePool(2);
    const a = pool.acquire('/p1');
    pool.release(a);
    const b = pool.acquire('/p1');
    pool.release(b);
    expect(a).toBe(b);
    expect(created).toHaveLength(1);
  });

  it('closes the least-recently-used idle connection past the cap', () => {
    const { pool } = makePool(2);
    const s1 = pool.acquire('/p1');
    pool.release(s1);
    const s2 = pool.acquire('/p2');
    pool.release(s2);
    // Touch p1 so p2 becomes the least recently used.
    pool.release(pool.acquire('/p1'));

    const s3 = pool.acquire('/p3');
    pool.release(s3);

    expect(pool.size).toBe(2);
    expect(s2.closed).toBe(true);
    expect(s1.closed).toBe(false);
    expect(s3.closed).toBe(false);
  });

  it('never closes a connection that is still checked out', () => {
    const { pool } = makePool(1);
    // Held open across the whole test — an in-flight search on /p1.
    const held = pool.acquire('/p1');

    const s2 = pool.acquire('/p2');
    pool.release(s2);
    const s3 = pool.acquire('/p3');
    pool.release(s3);

    expect(held.closed).toBe(false);
    // Releasing the holder finally lets the pool trim down to the cap.
    pool.release(held);
    expect(pool.size).toBeLessThanOrEqual(2);
  });

  it('balances refcounts across nested acquires of one project', () => {
    const { pool } = makePool(1);
    const a = pool.acquire('/p1');
    const b = pool.acquire('/p1');
    expect(a).toBe(b);

    const other = pool.acquire('/p2');
    pool.release(other);
    // /p1 still has two outstanding refs, so it cannot be evicted.
    expect(a.closed).toBe(false);

    pool.release(a);
    pool.release(b);
    pool.release(pool.acquire('/p3'));
    expect(pool.size).toBeLessThanOrEqual(1 + 1);
  });

  it('closeAll drains every connection', () => {
    const { pool, created } = makePool(4);
    pool.release(pool.acquire('/p1'));
    pool.release(pool.acquire('/p2'));
    pool.closeAll();
    expect(pool.size).toBe(0);
    expect(created.every((s) => s.closed)).toBe(true);
  });
});
