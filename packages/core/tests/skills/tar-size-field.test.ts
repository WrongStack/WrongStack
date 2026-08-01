/**
 * WS-056 — the tar size field silently became 0, desynchronising the parser.
 *
 * The field was read as `parseInt(readTarString(...), 8) || 0`. GNU tar
 * encodes a size that does not fit 11 octal digits in "base-256": the high bit
 * of the first byte is set and the rest is a big-endian binary integer. Read as
 * an octal string that is binary garbage, so `parseInt` returned `NaN` and
 * `|| 0` quietly made the size 0.
 *
 * A zero size does not merely mis-report the entry — the loop advances by
 * `512 + ceil(size / 512) * 512`, so it advances ONE block and the entry's own
 * DATA is then parsed as the next tar header. Every subsequent "entry" is
 * attacker-chosen content that never appeared in the archive's real entry list,
 * and the extractor writes whatever those synthetic headers name.
 *
 * Scope, stated rather than implied: the zip-slip guard still applies to the
 * synthetic names, so this is NOT a path out of `destDir`. It is arbitrary file
 * creation *inside* it from data that no inspection of the archive's entries
 * would reveal. That is worth fixing, and worth not overstating.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { githubFetcherCoverage } from '../../src/skills/github-fetcher.js';

const { extractTar, readTarSize } = githubFetcherCoverage;

/** Build one 512-byte ustar header. */
function header(opts: {
  name: string;
  size?: number;
  typeflag?: string;
  /** Write the size as GNU base-256 instead of octal. */
  base256?: boolean;
  /** Raw override for the 12 size bytes. */
  rawSize?: Buffer;
}): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(opts.name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 8, 'utf8'); // mode
  h.write('0000000\0', 108, 8, 'utf8'); // uid
  h.write('0000000\0', 116, 8, 'utf8'); // gid

  const size = opts.size ?? 0;
  if (opts.rawSize) {
    opts.rawSize.copy(h, 124, 0, 12);
  } else if (opts.base256) {
    h[124] = 0x80;
    h.writeUIntBE(size, 130, 6);
  } else {
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  }

  h.write('00000000000\0', 136, 12, 'utf8'); // mtime
  h.write(opts.typeflag ?? '0', 156, 1, 'utf8');
  h.write('ustar\x0000', 257, 8, 'utf8');
  // Checksum: spaces during computation, then the octal sum. The extractor
  // does not verify it, but a well-formed fixture keeps the test honest.
  h.write('        ', 148, 8, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return h;
}

/** Pad a body to the next 512-byte boundary. */
function body(content: Buffer): Buffer {
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512, 0);
  content.copy(padded);
  return padded;
}

let dest: string;

beforeEach(async () => {
  dest = await mkdtemp(join(tmpdir(), 'tar-size-'));
});
afterEach(async () => {
  await rm(dest, { recursive: true, force: true });
});

describe('readTarSize (WS-056)', () => {
  it('reads an ordinary octal size', () => {
    const h = header({ name: 'top/a.txt', size: 1234 });
    expect(readTarSize(h, 124)).toBe(1234);
  });

  it('reads a GNU base-256 size instead of returning 0', () => {
    // The whole finding: this used to be NaN → 0.
    const h = header({ name: 'top/big.bin', size: 9_000_000_000, base256: true });
    expect(readTarSize(h, 124)).toBe(9_000_000_000);
  });

  it('treats an all-NUL field as a legitimate zero', () => {
    // Directory entries carry this; it must not become an error.
    const h = header({ name: 'top/d/', typeflag: '5', rawSize: Buffer.alloc(12, 0) });
    expect(readTarSize(h, 124)).toBe(0);
  });

  it('THROWS on a field that is neither valid octal nor base-256', () => {
    // The safety property. Returning 0 here is what desynchronises the parser,
    // so an unknown size must stop the extraction rather than be guessed.
    const h = header({ name: 'top/x', rawSize: Buffer.from('99999999999\0', 'utf8') });
    expect(() => readTarSize(h, 124)).toThrow(/unparseable size/);
  });

  it('rejects a negative base-256 size', () => {
    const raw = Buffer.alloc(12, 0);
    raw[0] = 0xff;
    const h = header({ name: 'top/x', rawSize: raw });
    expect(() => readTarSize(h, 124)).toThrow(/negative/);
  });

  it('rejects a base-256 size beyond the safe integer range', () => {
    // High bit set but NOT 0xff — 0xff means negative and is checked first.
    // 11 payload bytes is 88 bits, far past 2^53.
    const raw = Buffer.alloc(12, 0xff);
    raw[0] = 0x81;
    const h = header({ name: 'top/x', rawSize: raw });
    expect(() => readTarSize(h, 124)).toThrow(/safe integer/);
  });
});

describe('extractTar no longer desynchronises (WS-056)', () => {
  it('does not parse a base-256 entry body as the next header', async () => {
    // The smuggled header claims a file the real archive never lists. With the
    // old zero-size read, the parser landed on it and created that file.
    const smuggled = Buffer.concat([
      header({ name: 'top/SMUGGLED.txt', size: 5 }),
      body(Buffer.from('pwned')),
    ]);
    const archive = Buffer.concat([
      header({ name: 'top/decoy.bin', size: smuggled.length, base256: true }),
      body(smuggled),
      Buffer.alloc(1024, 0), // end-of-archive
    ]);

    await extractTar(archive, dest);

    const entries = await readdir(dest);
    expect(entries).toContain('decoy.bin');
    expect(entries).not.toContain('SMUGGLED.txt');
  });

  it('aborts rather than continuing past an unreadable size', async () => {
    const archive = Buffer.concat([
      header({ name: 'top/bad', rawSize: Buffer.from('99999999999\0', 'utf8') }),
      body(Buffer.from('x')),
      Buffer.alloc(1024, 0),
    ]);
    await expect(extractTar(archive, dest)).rejects.toThrow(/unparseable size/);
  });

  it('still extracts an ordinary archive correctly', async () => {
    const archive = Buffer.concat([
      header({ name: 'top/dir/', typeflag: '5' }),
      header({ name: 'top/dir/a.txt', size: 5 }),
      body(Buffer.from('hello')),
      Buffer.alloc(1024, 0),
    ]);
    await extractTar(archive, dest);
    expect(await readdir(join(dest, 'dir'))).toEqual(['a.txt']);
  });
});
