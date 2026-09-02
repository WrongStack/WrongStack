import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getJsonPath,
  isJsonObject,
  jsonObjectFileExists,
  readJsonObjectFile,
  removeJsonPath,
  removeJsonPathInFile,
  setJsonPath,
  setJsonPathInFile,
  updateJsonObjectFile,
  writeJsonObjectFile,
} from '../../src/utils/config-json.js';

let tmp = '';
beforeEach(async () => {
  tmp = path.join(os.tmpdir(), `config-json-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tmp, { recursive: true });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('isJsonObject', () => {
  it('accepts plain objects and rejects null/arrays/primitives', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject(undefined)).toBe(false);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(5)).toBe(false);
    expect(isJsonObject('x')).toBe(false);
  });
});

describe('file helpers', () => {
  it('readJsonObjectFile returns {} for missing/corrupt/non-object', async () => {
    const f = path.join(tmp, 'c.json');
    expect(await readJsonObjectFile(f)).toEqual({}); // missing
    await fs.writeFile(f, '{ not json');
    expect(await readJsonObjectFile(f)).toEqual({}); // corrupt
    await fs.writeFile(f, '[1,2,3]');
    expect(await readJsonObjectFile(f)).toEqual({}); // array
    await fs.writeFile(f, '42');
    expect(await readJsonObjectFile(f)).toEqual({}); // primitive
  });
  it('readJsonObjectFile returns the parsed object', async () => {
    const f = path.join(tmp, 'c.json');
    await fs.writeFile(f, JSON.stringify({ a: 1 }));
    expect(await readJsonObjectFile(f)).toEqual({ a: 1 });
  });
  it('jsonObjectFileExists reports presence', async () => {
    const f = path.join(tmp, 'c.json');
    expect(await jsonObjectFileExists(f)).toBe(false);
    await fs.writeFile(f, '{}');
    expect(await jsonObjectFileExists(f)).toBe(true);
  });
  it('writeJsonObjectFile round-trips through read', async () => {
    const f = path.join(tmp, 'c.json');
    await writeJsonObjectFile(f, { hello: 'world', n: 3 });
    expect(await readJsonObjectFile(f)).toEqual({ hello: 'world', n: 3 });
  });
  it('updateJsonObjectFile applies an in-place void mutator', async () => {
    const f = path.join(tmp, 'c.json');
    await writeJsonObjectFile(f, { a: 1 });
    const next = await updateJsonObjectFile(f, (c) => {
      (c as { a?: number }).a = 2;
    });
    expect(next).toEqual({ a: 2 });
    expect(await readJsonObjectFile(f)).toEqual({ a: 2 });
  });
  it('updateJsonObjectFile uses a returned replacement object', async () => {
    const f = path.join(tmp, 'c.json');
    await writeJsonObjectFile(f, { a: 1 });
    const next = await updateJsonObjectFile(f, () => ({ replaced: true }));
    expect(next).toEqual({ replaced: true });
  });
  it('updateJsonObjectFile ignores a non-object return and keeps the original', async () => {
    const f = path.join(tmp, 'c.json');
    await writeJsonObjectFile(f, { a: 1 });
    const next = await updateJsonObjectFile(f, () => 42 as never);
    expect(next).toEqual({ a: 1 });
  });
});

describe('getJsonPath', () => {
  it('traverses nested objects and arrays', () => {
    expect(getJsonPath({ a: { b: 1 } }, ['a', 'b'])).toBe(1);
    expect(getJsonPath({ a: [10, 20] }, ['a', 1])).toBe(20);
  });
  it('returns undefined for a numeric segment on a non-array', () => {
    expect(getJsonPath({ a: 5 }, ['a', 0])).toBeUndefined();
  });
  it('returns undefined for a string segment on a non-object', () => {
    expect(getJsonPath({ a: 5 }, ['a', 'b'])).toBeUndefined();
    expect(getJsonPath([1, 2], [0, 'x'])).toBeUndefined();
  });
});

describe('setJsonPath', () => {
  it('replaces the root when the path is empty', () => {
    expect(setJsonPath({ a: 1 }, [], { fresh: true })).toEqual({ fresh: true });
  });
  it('throws when replacing root with a non-object', () => {
    expect(() => setJsonPath({}, [], 5 as never)).toThrow(/Root config value must be an object/);
  });
  it('sets a string leaf, creating intermediate objects', () => {
    expect(setJsonPath({}, ['a', 'b'], 1)).toEqual({ a: { b: 1 } });
    expect(setJsonPath({ a: 5 }, ['a', 'b'], 1)).toEqual({ a: { b: 1 } }); // overwrite primitive
    expect(setJsonPath({ a: {} }, ['a', 'b'], 1)).toEqual({ a: { b: 1 } }); // existing container preserved
  });
  it('sets a numeric leaf on an array parent', () => {
    expect(setJsonPath({ a: [] }, ['a', 0], 9)).toEqual({ a: [9] });
  });
  it('throws setting a numeric leaf on a non-array parent', () => {
    expect(() => setJsonPath({ a: {} }, ['a', 0], 9)).toThrow(
      /Cannot set numeric segment 0 on non-array/,
    );
  });
  it('throws setting a string leaf on a non-object parent', () => {
    expect(() => setJsonPath({ a: [] }, ['a', 'b'], 9)).toThrow(
      /Cannot set property b on non-object/,
    );
  });
  it('creates intermediate arrays for numeric next-segments', () => {
    expect(setJsonPath({}, ['a', 0, 'b'], 1)).toEqual({ a: [{ b: 1 }] });
  });
  it('overwrites a primitive array element with a container when traversing', () => {
    // current[0]=5 (primitive) → replaced with {} so 'b' can be set under it.
    expect(setJsonPath({ a: [5] }, ['a', 0, 'b'], 1)).toEqual({ a: [{ b: 1 }] });
    // current[0] already an object → preserved (no overwrite).
    expect(setJsonPath({ a: [{}] }, ['a', 0, 'b'], 1)).toEqual({ a: [{ b: 1 }] });
  });
  it('throws traversing a numeric segment on a non-array', () => {
    expect(() => setJsonPath({}, [0, 'b'], 1)).toThrow(
      /Cannot traverse numeric segment 0 on non-array/,
    );
  });
  it('throws traversing a string segment on a non-object', () => {
    expect(() => setJsonPath([] as never, ['a', 'b'], 1)).toThrow(
      /Cannot traverse property a on non-object/,
    );
  });
});

describe('removeJsonPath', () => {
  it('returns false for an empty path', () => {
    expect(removeJsonPath({ a: 1 }, [])).toBe(false);
  });
  it('removes an object property', () => {
    const root = { a: 1, b: 2 };
    expect(removeJsonPath(root, ['a'])).toBe(true);
    expect(root).toEqual({ b: 2 });
  });
  it('returns false for a missing property', () => {
    expect(removeJsonPath({ a: 1 }, ['z'])).toBe(false);
  });
  it('returns false when the parent is not an object', () => {
    expect(removeJsonPath({ a: 5 }, ['a', 'b'])).toBe(false);
  });
  it('removes an array element by index', () => {
    const root = { a: [1, 2, 3] };
    expect(removeJsonPath(root, ['a', 1])).toBe(true);
    expect(root).toEqual({ a: [1, 3] });
  });
  it('returns false for an out-of-bounds numeric segment', () => {
    expect(removeJsonPath({ a: [1] }, ['a', 5])).toBe(false);
    expect(removeJsonPath({ a: [1] }, ['a', -1])).toBe(false);
  });
  it('returns false for a numeric segment on a non-array', () => {
    expect(removeJsonPath({ a: {} }, ['a', 0])).toBe(false);
  });
});

describe('file path operations', () => {
  it('setJsonPathInFile writes through and removeJsonPathInFile deletes', async () => {
    const f = path.join(tmp, 'c.json');
    await writeJsonObjectFile(f, {});
    await setJsonPathInFile(f, ['a', 'b'], 1);
    expect(await readJsonObjectFile(f)).toEqual({ a: { b: 1 } });
    await removeJsonPathInFile(f, ['a', 'b']);
    expect(await readJsonObjectFile(f)).toEqual({ a: {} });
  });
});
