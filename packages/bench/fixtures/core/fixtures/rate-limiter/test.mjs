import assert from 'node:assert/strict';
import { TokenBucket } from './src/limiter.js';

// CORE_SENTINEL_rate-limiter

let t = 0;
const now = () => t;

const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1, now });
assert.equal(bucket.available(), 2);
assert.equal(bucket.tryRemove(2), true);
assert.equal(bucket.available(), 0);
assert.equal(bucket.tryRemove(1), false);
assert.equal(bucket.available(), 0);

t += 500;
assert.ok(bucket.available() >= 0.49 && bucket.available() <= 0.51);
assert.equal(bucket.tryRemove(1), false);

t += 500;
assert.ok(bucket.available() >= 0.99 && bucket.available() <= 1.01);
assert.equal(bucket.tryRemove(1), true);
assert.ok(bucket.available() < 0.01);

t += 10_000;
assert.equal(bucket.available(), 2);
assert.equal(bucket.tryRemove(3), false);
assert.equal(bucket.available(), 2);
