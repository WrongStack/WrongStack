import assert from 'node:assert/strict';
import { createFetcher, mapLimit, memoizeAsync } from './src/index.js';

// HARD_SENTINEL_async-pool

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
// Lets pending promise callbacks run; does not wait on wall-clock time.
const flush = () => new Promise((r) => setImmediate(r));

// ---- mapLimit ----

// Order of results, concurrency bound, and start order.
{
  const started = [];
  const pending = new Map();
  let active = 0;
  let maxActive = 0;
  const p = mapLimit(['a', 'b', 'c', 'd', 'e', 'f'], 2, (item, index) => {
    started.push(`${item}${index}`);
    active++;
    maxActive = Math.max(maxActive, active);
    const d = deferred();
    pending.set(index, d);
    return d.promise.finally(() => {
      active--;
    });
  });
  assert.deepEqual(started, ['a0', 'b1'], 'first `limit` calls start synchronously');
  pending.get(1).resolve('B');
  await flush();
  assert.deepEqual(started, ['a0', 'b1', 'c2']);
  pending.get(0).resolve('A');
  await flush();
  assert.deepEqual(started, ['a0', 'b1', 'c2', 'd3']);
  pending.get(3).resolve('D');
  await flush();
  pending.get(4).resolve('E');
  await flush();
  pending.get(5).resolve('F');
  await flush();
  pending.get(2).resolve('C');
  assert.deepEqual(await p, ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.equal(maxActive, 2);
  assert.deepEqual(started, ['a0', 'b1', 'c2', 'd3', 'e4', 'f5']);
}

// limit larger than the input; plain (non-promise) return values; empty input.
{
  const calls = [];
  const out = await mapLimit([10, 20, 30], 8, (x, i) => {
    calls.push(i);
    return x / 10;
  });
  assert.deepEqual(out, [1, 2, 3]);
  assert.deepEqual(calls, [0, 1, 2]);
  let called = false;
  assert.deepEqual(
    await mapLimit([], 3, () => {
      called = true;
    }),
    [],
  );
  assert.equal(called, false);
}

// Invalid limits reject with RangeError.
await assert.rejects(
  mapLimit([1], 0, (x) => x),
  RangeError,
);
await assert.rejects(
  mapLimit([1], 1.5, (x) => x),
  RangeError,
);
await assert.rejects(
  mapLimit([1], '2', (x) => x),
  RangeError,
);

// First failure rejects with the same reason and stops starting new items.
{
  const started = [];
  const pending = new Map();
  const boom = new Error('boom');
  const p = mapLimit([0, 1, 2, 3, 4], 2, (x, i) => {
    started.push(i);
    const d = deferred();
    pending.set(i, d);
    return d.promise;
  });
  const settled = p.then(
    () => 'resolved',
    (err) => err,
  );
  pending.get(1).reject(boom);
  await flush();
  pending.get(0).resolve('late');
  await flush();
  await flush();
  assert.equal(await settled, boom);
  assert.deepEqual(started, [0, 1], 'no new item may start after a failure');
}

// A synchronous throw from fn counts as that item's rejection.
{
  const err = new TypeError('sync');
  await assert.rejects(
    mapLimit([1, 2], 1, () => {
      throw err;
    }),
    (e) => e === err,
  );
}

// ---- memoizeAsync ----

// Concurrent calls share one in-flight promise; fn runs synchronously on the first call.
{
  let calls = 0;
  const d = deferred();
  const m = memoizeAsync((k) => {
    calls++;
    return d.promise;
  });
  const p1 = m('x');
  assert.equal(calls, 1, 'fn must be invoked synchronously');
  const p2 = m('x');
  assert.equal(p1, p2);
  d.resolve(42);
  assert.equal(await p1, 42);
  assert.equal(await m('x'), 42);
  assert.equal(calls, 1);
}

// Rejections are not cached; synchronous throws become rejections and are not cached either.
{
  let calls = 0;
  const m = memoizeAsync(async (k) => {
    calls++;
    if (calls === 1) throw new Error('flaky');
    return `ok:${k}`;
  });
  await assert.rejects(m('k'), /flaky/);
  assert.equal(await m('k'), 'ok:k');
  assert.equal(calls, 2);

  let syncCalls = 0;
  const s = memoizeAsync(() => {
    syncCalls++;
    if (syncCalls === 1) throw new Error('sync-fail');
    return Promise.resolve('fine');
  });
  const first = s('a');
  assert.ok(first instanceof Promise, 'must return a promise even when fn throws');
  await assert.rejects(first, /sync-fail/);
  assert.equal(await s('a'), 'fine');
}

// Arbitrary string keys, including ones that collide with Object.prototype.
{
  const seen = [];
  const m = memoizeAsync(async (k) => {
    seen.push(k);
    return `v:${k}`;
  });
  for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(await m(k), `v:${k}`);
    assert.equal(await m(k), `v:${k}`);
  }
  assert.deepEqual(seen, ['constructor', 'toString', '__proto__', 'hasOwnProperty']);
}

// Custom key function, clear(key) and clear().
{
  let calls = 0;
  const m = memoizeAsync(
    async (a, b) => {
      calls++;
      return a + b;
    },
    { key: (a, b) => `${a}|${b}` },
  );
  assert.equal(await m(1, 2), 3);
  assert.equal(await m(1, 3), 4);
  assert.equal(await m(1, 2), 3);
  assert.equal(calls, 2);
  m.clear('1|2');
  assert.equal(await m(1, 2), 3);
  assert.equal(calls, 3);
  m.clear();
  await m(1, 2);
  await m(1, 3);
  assert.equal(calls, 5);
}

// A stale rejection (from before clear) must not evict the newer in-flight entry.
{
  let calls = 0;
  const ds = [];
  const m = memoizeAsync(() => {
    calls++;
    const d = deferred();
    ds.push(d);
    return d.promise;
  });
  const old = m('k');
  old.catch(() => {});
  m.clear('k');
  const fresh = m('k');
  assert.equal(calls, 2);
  ds[0].reject(new Error('stale'));
  await flush();
  assert.equal(m('k'), fresh);
  assert.equal(calls, 2);
  ds[1].resolve('new');
  assert.equal(await fresh, 'new');
}

// ---- integration ----
{
  const loads = [];
  const fetcher = createFetcher(async (id) => {
    loads.push(id);
    return id.toUpperCase();
  }, 2);
  assert.deepEqual(await fetcher.fetchAll(['a', 'b', 'a', 'c', 'b']), ['A', 'B', 'A', 'C', 'B']);
  assert.deepEqual(loads, ['a', 'b', 'c']);
  fetcher.forget('a');
  assert.deepEqual(await fetcher.fetchAll(['a']), ['A']);
  assert.deepEqual(loads, ['a', 'b', 'c', 'a']);
}

console.log('async-pool: all assertions passed');
