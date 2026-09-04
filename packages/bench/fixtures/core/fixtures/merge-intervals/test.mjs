import assert from 'node:assert/strict';
import { mergeIntervals } from './src/merge.js';

// CORE_SENTINEL_merge-intervals

assert.deepEqual(mergeIntervals([]), []);
assert.deepEqual(mergeIntervals([[1, 3]]), [[1, 3]]);
assert.deepEqual(mergeIntervals([[1, 3], [2, 6], [8, 10], [15, 18]]), [
  [1, 6],
  [8, 10],
  [15, 18],
]);
assert.deepEqual(mergeIntervals([[1, 4], [4, 5]]), [[1, 5]]);
assert.deepEqual(mergeIntervals([[6, 8], [1, 3], [2, 4]]), [[1, 4], [6, 8]]);
assert.deepEqual(mergeIntervals([[1, 10], [2, 3], [4, 5]]), [[1, 10]]);
assert.deepEqual(mergeIntervals([[-2, 0], [-1, 2]]), [[-2, 2]]);
assert.deepEqual(mergeIntervals([[5, 5], [5, 6]]), [[5, 6]]);
