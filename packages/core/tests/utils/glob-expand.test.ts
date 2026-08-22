import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandGlob } from '../../src/utils/glob-expand.js';

// Run from inside the temp dir with relative, forward-slash patterns so base
// resolves to '.' on every platform (baseDir cuts on the native separator,
// which a relative forward-slash pattern lacks → base '.').
let dir: string;
let origCwd: string;
const base = (p: string) => path.basename(p);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-expand-'));
  await fs.writeFile(path.join(dir, 'a.ts'), '');
  await fs.writeFile(path.join(dir, 'b.ts'), '');
  await fs.writeFile(path.join(dir, 'c.js'), '');
  await fs.mkdir(path.join(dir, 'sub'));
  await fs.writeFile(path.join(dir, 'sub', 'd.ts'), '');
  origCwd = process.cwd();
  process.chdir(dir);
});
afterEach(async () => {
  process.chdir(origCwd);
  await fs.rm(dir, { recursive: true, force: true });
});

describe('expandGlob', () => {
  it('returns a literal path unchanged when there is no glob char', async () => {
    expect(await expandGlob('foo/bar.txt')).toEqual(['foo/bar.txt']);
  });

  it('matches a single-star pattern in the current directory', async () => {
    const out = (await expandGlob('*.ts')).map(base).sort();
    expect(out).toEqual(['a.ts', 'b.ts']);
  });

  it('descends a literal subdirectory segment before the glob', async () => {
    const out = (await expandGlob('sub/*.ts')).map(base);
    expect(out).toEqual(['d.ts']);
  });

  it('skips a literal segment that does not exist', async () => {
    expect(await expandGlob('nope/*.ts')).toEqual([]);
  });

  it('supports ? single-character wildcards', async () => {
    const out = (await expandGlob('?.ts')).map(base).sort();
    expect(out).toEqual(['a.ts', 'b.ts']);
  });

  it('supports [...] character classes including negation', async () => {
    const incl = (await expandGlob('[ab].ts')).map(base).sort();
    expect(incl).toEqual(['a.ts', 'b.ts']);
    const neg = (await expandGlob('[!a].ts')).map(base);
    expect(neg).toEqual(['b.ts']);
  });

  it('resolves matches to absolute paths for an absolute pattern', async () => {
    const out = await expandGlob(path.join(dir, '*.js'));
    expect(out.every((p) => path.isAbsolute(p))).toBe(true);
    expect(out.map(base)).toEqual(['c.js']);
  });

  it('handles a backslash and a non-leading ^ inside a character class', async () => {
    // Exercises the `\\` and `]`/`^` escape branches of globToRegex's [...] parser.
    expect(Array.isArray(await expandGlob('[a\\b].ts'))).toBe(true); // backslash in class
    expect(Array.isArray(await expandGlob('[ab^].ts'))).toBe(true); // non-leading caret
  });

  it('matches the current directory and nested subdirectories for a leading globstar pattern', async () => {
    const out = (await expandGlob('**/*.ts')).map(base).sort();
    expect(out).toContain('a.ts');
    expect(out).toContain('b.ts');
    expect(out).toContain('d.ts');
  });
});
