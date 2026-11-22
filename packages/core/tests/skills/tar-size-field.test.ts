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
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
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

describe('extractTar keeps zero-byte regular files (F1170)', () => {
  it('creates an empty regular file instead of silently dropping it', async () => {
    // Empty files are ordinary repo content (`__init__.py`, `py.typed`,
    // `.gitkeep`); the `size > 0` guard skipped them, so the installed skill
    // silently differed from its repository.
    const archive = Buffer.concat([
      header({ name: 'top/scripts/', typeflag: '5' }),
      header({ name: 'top/scripts/__init__.py', size: 0 }),
      header({ name: 'top/scripts/run.py', size: 5 }),
      body(Buffer.from('print')),
      Buffer.alloc(1024, 0),
    ]);
    await extractTar(archive, dest);
    expect((await readdir(join(dest, 'scripts'))).sort()).toEqual(['__init__.py', 'run.py']);
    const empty = await stat(join(dest, 'scripts', '__init__.py'));
    expect(empty.isFile()).toBe(true);
    expect(empty.size).toBe(0);
  });

  it('still treats an old-style NUL-typeflag entry ending in / as a directory', async () => {
    const archive = Buffer.concat([
      header({ name: 'top/legacy/', typeflag: '\0' }),
      Buffer.alloc(1024, 0),
    ]);
    await extractTar(archive, dest);
    expect((await stat(join(dest, 'legacy'))).isDirectory()).toBe(true);
  });
});

describe('extractTar honours pax path headers (F1185)', () => {
  /** One pax record: `<len> key=value\n`, where <len> counts itself. */
  function paxRecord(key: string, value: string): string {
    const rest = ` ${key}=${value}\n`;
    let len = Buffer.byteLength(rest);
    while (Buffer.byteLength(`${len}${rest}`) !== len) len = Buffer.byteLength(`${len}${rest}`);
    return `${len}${rest}`;
  }

  it('extracts a long-named file under its pax path instead of dropping it', async () => {
    // git archive (GitHub's tarball producer) stores a path no ustar name/prefix
    // split fits in a pax 'x' header and writes "<sha>.data" as the ustar name.
    const longName = `${'a'.repeat(110)}.md`;
    const pax = Buffer.from(paxRecord('path', `top/refs/${longName}`));
    const archive = Buffer.concat([
      header({ name: 'pax_global_header', size: 0, typeflag: 'g' }),
      header({ name: 'PaxHeader', size: pax.length, typeflag: 'x' }),
      body(pax),
      header({ name: `${'0'.repeat(40)}.data`, size: 4 }),
      body(Buffer.from('long')),
      header({ name: 'top/refs/short.md', size: 5 }),
      body(Buffer.from('short')),
      Buffer.alloc(1024, 0),
    ]);
    await extractTar(archive, dest);
    expect((await readdir(join(dest, 'refs'))).sort()).toEqual([longName, 'short.md'].sort());
    expect((await stat(join(dest, 'refs', longName))).size).toBe(4);
  });

  it('keeps the zip-slip guard for a pax path', async () => {
    const pax = Buffer.from(paxRecord('path', 'top/../escaped.md'));
    const inner = join(dest, 'inner');
    const archive = Buffer.concat([
      header({ name: 'PaxHeader', size: pax.length, typeflag: 'x' }),
      body(pax),
      header({ name: 'top/harmless.md', size: 3 }),
      body(Buffer.from('evl')),
      Buffer.alloc(1024, 0),
    ]);
    await extractTar(archive, inner);
    expect(await readdir(dest)).toEqual([]);
  });
});
