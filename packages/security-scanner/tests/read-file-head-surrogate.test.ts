import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileHead } from '../src/file-gathering.js';

const ROCKET = '\u{1F680}';

/**
 * F2634: `readFileHead` caps decoded text with a plain `.slice(0, maxChars)`.
 * When the character at the cut is astral the head carries a lone surrogate,
 * and that head is scanned, reported and shown as the file's preview.
 */
describe('readFileHead keeps valid UTF-16 at the cut (F2634)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-head-surrogate-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('drops the orphaned high surrogate at the cap', async () => {
    const file = path.join(dir, 'straddle.txt');
    await fsp.writeFile(file, `${'a'.repeat(31)}${ROCKET}tail`, 'utf8');

    const head = await readFileHead(file, 32);

    expect(head.isWellFormed()).toBe(true);
    expect(head).toBe('a'.repeat(31));
  });

  it('keeps a whole emoji that ends exactly at the cap', async () => {
    const file = path.join(dir, 'fits.txt');
    await fsp.writeFile(file, `${'a'.repeat(30)}${ROCKET}tail`, 'utf8');

    const head = await readFileHead(file, 32);

    expect(head).toBe(`${'a'.repeat(30)}${ROCKET}`);
  });

  it('returns ASCII content unchanged (control)', async () => {
    const file = path.join(dir, 'plain.txt');
    await fsp.writeFile(file, 'hello world', 'utf8');

    expect(await readFileHead(file, 64)).toBe('hello world');
  });
});
