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

  it('matches a literal ] as the first class member ([]] / []x] / [!]])', async () => {
    // Regression for the empty-class bug: `[]]` used to compile to `[]`,
    // which never matches, so a file named `]` was unreachable by glob.
    await fs.writeFile(path.join(dir, ']'), '');
    await fs.writeFile(path.join(dir, 'x'), '');
    expect((await expandGlob('[]]')).map(base)).toEqual([']']);
    expect((await expandGlob('[]x]')).map(base).sort()).toEqual([']', 'x']);
    expect((await expandGlob('[!]]')).map(base)).toEqual(['x']);
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

  it('handles Windows backslash separators in glob patterns', async () => {
    const out = (await expandGlob('sub\\*.ts')).map(base);
    expect(out).toEqual(['d.ts']);
    const outGlobstar = (await expandGlob('**\\*.ts')).map(base).sort();
    expect(outGlobstar).toContain('a.ts');
    expect(outGlobstar).toContain('d.ts');
  });

  it('normalizes a leading ./ segment instead of matching it literally', async () => {
    // Regression: a `./`-prefixed pattern left the prefix in relPat, so walk()
    // looked for a directory literally named `.` — readdir never yields one —
    // and every match was silently dropped.
    expect((await expandGlob('./*.ts')).map(base).sort()).toEqual(['a.ts', 'b.ts']);
    expect((await expandGlob('./*.js')).map(base)).toEqual(['c.js']);
    const globstar = (await expandGlob('./**/*.ts')).map(base).sort();
    expect(globstar).toEqual(expect.arrayContaining(['a.ts', 'b.ts', 'd.ts']));
  });

  it('returns an existing path whose name holds glob characters (Next.js routes)', async () => {
    await fs.mkdir(path.join(dir, 'app', '[id]'), { recursive: true });
    await fs.writeFile(path.join(dir, 'app', '[id]', 'page.tsx'), '');
    expect(await expandGlob('app/[id]/page.tsx')).toEqual(['app/[id]/page.tsx']);
    expect(await expandGlob('app/[nope]/page.tsx')).toEqual([]);
  });

  it('resolves to file paths: directories are traversed, never returned', async () => {
    // Regression (bug-hunt round 14): the trailing-`**` and leaf-segment
    // branches added every readdir entry, so `expandGlob('**')` returned
    // directory paths as matches. Consumers that count the result as files
    // over-counted — `collab_debug` refused a target holding 3 files as
    // "5 files, which exceeds the limit".
    for (const pattern of ['**', '*', 'sub/*', './**']) {
      const directories: string[] = [];
      for (const result of await expandGlob(pattern)) {
        if ((await fs.stat(result)).isDirectory()) directories.push(result);
      }
      expect(directories, pattern).toEqual([]);
    }
    // Every file, including the nested one, is still found.
    expect((await expandGlob('**')).map(base).sort()).toEqual(['a.ts', 'b.ts', 'c.js', 'd.ts']);
    expect((await expandGlob('sub/*')).map(base)).toEqual(['d.ts']);
  });

  it('does not throw Invalid regular expression on unclosed [!]a* pattern (F959)', async () => {
    await expect(expandGlob('[!]a*')).resolves.toEqual([]);
  });
});
