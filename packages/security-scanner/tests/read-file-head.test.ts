/**
 * Scan prompts embed only a short head of each file. Reading the whole file and
 * slicing afterwards pulled a minified bundle or lockfile fully into memory to
 * keep a couple of kilobytes, so the read itself has to be bounded.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

/** Records every byte count requested through a file handle's `read`. */
const spy = vi.hoisted(() => ({ bytesRead: [] as number[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      const read = handle.read.bind(handle);
      handle.read = ((...readArgs: unknown[]) => {
        if (typeof readArgs[2] === 'number') spy.bytesRead.push(readArgs[2]);
        return (read as (...a: unknown[]) => unknown)(...readArgs);
      }) as typeof handle.read;
      return handle;
    },
  };
});

import { readFileHead } from '../src/file-gathering.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'read-head-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<string> {
  const file = path.join(tmp, name);
  await fs.writeFile(file, content, 'utf8');
  return file;
}

describe('readFileHead', () => {
  it('returns the whole file when it is shorter than the limit', async () => {
    const file = await write('small.txt', 'short content');
    expect(await readFileHead(file, 2000)).toBe('short content');
  });

  it('returns exactly the first maxChars characters of a longer file', async () => {
    const file = await write('big.txt', `${'a'.repeat(2000)}${'b'.repeat(50_000)}`);
    const head = await readFileHead(file, 2000);

    expect(head).toHaveLength(2000);
    expect(head).toBe('a'.repeat(2000));
    // The tail must not leak in: this is the property that made the old
    // read-everything-then-slice implementation wasteful rather than wrong.
    expect(head).not.toContain('b');
  });

  it('does not split a multi-byte character at the byte boundary', async () => {
    // The limit counts UTF-16 code units, matching the `String.slice` it
    // replaced. An astral code point is one character but two units, so 1000
    // units is 500 emoji — and the byte budget puts the last one right at the
    // end of the read buffer, which is where a naive decode emits U+FFFD.
    const file = await write('emoji.txt', '😀'.repeat(4000));
    const head = await readFileHead(file, 1000);

    expect(head).toHaveLength(1000);
    expect(head).toBe('😀'.repeat(500));
    expect(head).not.toContain('�');
  });

  it('handles a file whose head is multi-byte and tail is ASCII', async () => {
    const file = await write('mixed.txt', `${'ü'.repeat(500)}${'z'.repeat(10_000)}`);
    const head = await readFileHead(file, 600);

    expect(head).toHaveLength(600);
    expect(head.slice(0, 500)).toBe('ü'.repeat(500));
    expect(head.slice(500)).toBe('z'.repeat(100));
  });

  it('returns an empty string for an empty file', async () => {
    const file = await write('empty.txt', '');
    expect(await readFileHead(file, 2000)).toBe('');
  });

  it('rejects for a missing file rather than returning a partial read', async () => {
    await expect(readFileHead(path.join(tmp, 'absent.txt'), 100)).rejects.toThrow();
  });

  it('reads a bounded prefix rather than the whole file', async () => {
    // The point of the change: a 4 MiB file must cost the same as a 2 KiB one.
    // Assert on the bytes actually pulled off disk, so reverting to
    // `readFile().slice()` fails here instead of silently reintroducing the
    // memory spike that the returned value alone would not reveal.
    const file = await write('huge.txt', 'a'.repeat(4 * 1024 * 1024));
    spy.bytesRead.length = 0;

    const head = await readFileHead(file, 2000);

    expect(head).toHaveLength(2000);
    // Guard the guard: without this the assertion below passes vacuously if the
    // module mock ever stops applying and no read is recorded at all.
    expect(spy.bytesRead.length).toBeGreaterThan(0);
    const total = spy.bytesRead.reduce((sum, count) => sum + count, 0);
    expect(total).toBeLessThanOrEqual(2000 * 4);
  });

  it('rejects an absurdly large maxChars before allocating a buffer', async () => {
    // The byte buffer is sized as `maxChars * 4`, so an unbounded argument
    // (e.g. `Number.MAX_SAFE_INTEGER`) would force a multi-gigabyte
    // `Buffer.allocUnsafe` and OOM the process. The function must reject it
    // synchronously, without ever opening the file.
    const file = await write('any.txt', 'irrelevant');
    spy.bytesRead.length = 0;

    await expect(readFileHead(file, Number.MAX_SAFE_INTEGER)).rejects.toBeInstanceOf(RangeError);
    // No I/O should have happened on the rejection path.
    expect(spy.bytesRead.length).toBe(0);
  });

  it('rejects non-integer or negative maxChars', async () => {
    const file = await write('any.txt', 'irrelevant');

    await expect(readFileHead(file, -1)).rejects.toBeInstanceOf(RangeError);
    await expect(readFileHead(file, 1.5)).rejects.toBeInstanceOf(RangeError);
    await expect(readFileHead(file, Number.NaN)).rejects.toBeInstanceOf(RangeError);
    await expect(readFileHead(file, Number.POSITIVE_INFINITY)).rejects.toBeInstanceOf(RangeError);
  });
});
