import assert from 'node:assert/strict';
import { parseSearch } from './src/query.js';

// CORE_SENTINEL_query-parser

assert.deepEqual(parseSearch(''), {});
assert.deepEqual(parseSearch('q=hello+world'), { q: 'hello world' });
assert.deepEqual(parseSearch('q=a%26b'), { q: 'a&b' });
assert.deepEqual(parseSearch('flag'), { flag: '' });
assert.deepEqual(parseSearch('limit=10'), { limit: 10 });
assert.deepEqual(parseSearch('tag=a&tag=b&q=x'), { tag: ['a', 'b'], q: 'x' });
assert.deepEqual(parseSearch('q=one&q=two'), { q: ['one', 'two'] });
assert.ok(!('missing' in parseSearch('q=1')));
