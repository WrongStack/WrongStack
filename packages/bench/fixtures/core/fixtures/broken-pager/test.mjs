import assert from 'node:assert/strict';
import { paginate } from './src/page.js';

// CORE_SENTINEL_broken-pager

const items = ['a', 'b', 'c', 'd', 'e'];

assert.throws(() => paginate(items, 0, 2));
assert.throws(() => paginate(items, 1, 0));

const p1 = paginate(items, 1, 2);
assert.deepEqual(p1.items, ['a', 'b']);
assert.equal(p1.total, 5);
assert.equal(p1.totalPages, 3);

const p3 = paginate(items, 3, 2);
assert.deepEqual(p3.items, ['e']);
assert.equal(p3.totalPages, 3);

const empty = paginate([], 1, 10);
assert.deepEqual(empty.items, []);
assert.equal(empty.total, 0);
assert.equal(empty.totalPages, 0);

const oob = paginate(items, 9, 2);
assert.deepEqual(oob.items, []);
assert.equal(oob.total, 5);
assert.equal(oob.totalPages, 3);
