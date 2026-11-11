import assert from 'node:assert/strict';
import { PatchError, applyPatch } from './src/patch.js';

// HARD_SENTINEL_json-patch

function failsAt(doc, patch, index) {
  const before = JSON.stringify(doc);
  assert.throws(
    () => applyPatch(doc, patch),
    (err) => err instanceof PatchError && err instanceof Error && err.index === index,
  );
  assert.equal(JSON.stringify(doc), before, 'failed patch must not mutate the input');
}

// add: object key, array insert (not overwrite), append with '-'.
assert.deepEqual(applyPatch({ a: 1 }, [{ op: 'add', path: '/b', value: 2 }]), { a: 1, b: 2 });
assert.deepEqual(applyPatch({ a: 1 }, [{ op: 'add', path: '/a', value: 9 }]), { a: 9 });
assert.deepEqual(applyPatch({ l: [1, 2, 3] }, [{ op: 'add', path: '/l/1', value: 'x' }]), {
  l: [1, 'x', 2, 3],
});
assert.deepEqual(applyPatch({ l: [1] }, [{ op: 'add', path: '/l/1', value: 2 }]), { l: [1, 2] });
assert.deepEqual(applyPatch({ l: [1] }, [{ op: 'add', path: '/l/-', value: 2 }]), { l: [1, 2] });
assert.deepEqual(applyPatch({ a: 1 }, [{ op: 'add', path: '', value: [7] }]), [7]);
failsAt({ l: [1] }, [{ op: 'add', path: '/l/2', value: 0 }], 0);
failsAt({ a: {} }, [{ op: 'add', path: '/missing/x', value: 0 }], 0);

// Pointer escaping: ~1 is '/', ~0 is '~', and '~01' decodes to '~1' (not '/').
assert.deepEqual(applyPatch({}, [{ op: 'add', path: '/a~1b', value: 1 }]), { 'a/b': 1 });
assert.deepEqual(applyPatch({}, [{ op: 'add', path: '/m~0n', value: 1 }]), { 'm~n': 1 });
assert.deepEqual(applyPatch({}, [{ op: 'add', path: '/~01', value: 1 }]), { '~1': 1 });
assert.deepEqual(applyPatch({ '': { '': 5 } }, [{ op: 'replace', path: '//', value: 6 }]), {
  '': { '': 6 },
});
failsAt({}, [{ op: 'add', path: 'a', value: 1 }], 0);

// Array index syntax: no leading zeros, no signs, '-' only for add.
failsAt({ l: [1, 2] }, [{ op: 'replace', path: '/l/01', value: 0 }], 0);
failsAt({ l: [1, 2] }, [{ op: 'replace', path: '/l/-', value: 0 }], 0);
failsAt({ l: [1, 2] }, [{ op: 'remove', path: '/l/2' }], 0);
failsAt({ l: [1, 2] }, [{ op: 'remove', path: '/l/-1' }], 0);

// remove / replace require an existing target; inherited properties do not count.
assert.deepEqual(applyPatch({ a: 1, b: 2 }, [{ op: 'remove', path: '/a' }]), { b: 2 });
assert.deepEqual(applyPatch([1, 2, 3], [{ op: 'remove', path: '/0' }]), [2, 3]);
failsAt({ a: 1 }, [{ op: 'replace', path: '/b', value: 1 }], 0);
failsAt({}, [{ op: 'remove', path: '/toString' }], 0);
assert.deepEqual(applyPatch({ a: 1 }, [{ op: 'replace', path: '', value: 'root' }]), 'root');

// move and copy.
assert.deepEqual(applyPatch({ a: { x: 1 }, b: {} }, [{ op: 'move', from: '/a/x', path: '/b/y' }]), {
  a: {},
  b: { y: 1 },
});
assert.deepEqual(applyPatch({ l: ['a', 'b', 'c'] }, [{ op: 'move', from: '/l/0', path: '/l/2' }]), {
  l: ['b', 'c', 'a'],
});
assert.deepEqual(applyPatch({ a: { b: 1 } }, [{ op: 'move', from: '/a', path: '/a' }]), {
  a: { b: 1 },
});
failsAt({ a: { b: {} } }, [{ op: 'move', from: '/a', path: '/a/b/c' }], 0);
assert.deepEqual(applyPatch({ ab: 1, a: {} }, [{ op: 'move', from: '/a', path: '/abc' }]), {
  ab: 1,
  abc: {},
});
{
  const out = applyPatch({ src: { deep: [1] } }, [{ op: 'copy', from: '/src', path: '/dst' }]);
  assert.deepEqual(out, { src: { deep: [1] }, dst: { deep: [1] } });
  out.dst.deep.push(2);
  assert.deepEqual(out.src.deep, [1], 'copy must be a deep copy');
}

// test: deep structural equality.
assert.deepEqual(
  applyPatch({ o: { a: 1, b: [1, { c: 2 }] } }, [
    { op: 'test', path: '/o', value: { b: [1, { c: 2 }], a: 1 } },
  ]),
  {
    o: { a: 1, b: [1, { c: 2 }] },
  },
);
failsAt({ v: 1 }, [{ op: 'test', path: '/v', value: '1' }], 0);
failsAt({ v: [1, 2] }, [{ op: 'test', path: '/v', value: [2, 1] }], 0);
failsAt({ v: null }, [{ op: 'test', path: '/v', value: {} }], 0);
failsAt({ v: { a: 1 } }, [{ op: 'test', path: '/v', value: { a: 1, b: undefined } }], 0);

// Unknown op and error index; atomicity across several ops.
failsAt(
  { a: 1 },
  [
    { op: 'add', path: '/b', value: 2 },
    { op: 'frobnicate', path: '/a' },
  ],
  1,
);
failsAt(
  { a: [1, 2] },
  [
    { op: 'remove', path: '/a/0' },
    { op: 'add', path: '/a/-', value: 3 },
    { op: 'test', path: '/a', value: [1, 2, 3] },
  ],
  2,
);

// No input mutation and no shared references with doc or patch values.
{
  const doc = { keep: { n: 1 }, list: [1, 2] };
  const value = { nested: [1] };
  const out = applyPatch(doc, [
    { op: 'add', path: '/v', value },
    { op: 'remove', path: '/list/0' },
  ]);
  assert.deepEqual(doc, { keep: { n: 1 }, list: [1, 2] });
  out.keep.n = 99;
  out.v.nested.push(2);
  assert.equal(doc.keep.n, 1);
  assert.deepEqual(value, { nested: [1] });
}

console.log('json-patch: all assertions passed');
