import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { documentTool } from '../src/document.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-tool-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const makeCtx = () => ({ cwd: tmpDir, tools: [], projectRoot: tmpDir }) as any;

describe('documentTool', () => {
  it('has correct metadata', () => {
    expect(documentTool.name).toBe('document');
    // `document` is currently a PREVIEW-ONLY tool: it scans files and
    // returns candidate docstrings with `status: 'skipped'`, but does
    // NOT call fs.writeFile/atomicWrite anywhere. As such it must be
    // `mutating: false` and `permission: 'auto'`. The H7 invariant
    // test (`permission-mutating-invariant.test.ts`) enforces this.
    expect(documentTool.permission).toBe('auto');
    expect(documentTool.mutating).toBe(false);
  });

  it('returns empty results when no files specified', async () => {
    const ctx = makeCtx();
    const result = await documentTool.execute({ target: 'function' }, ctx);
    expect(result.files_processed).toBe(0);
    expect(result.items_documented).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('returns error for non-existent file', async () => {
    const ctx = makeCtx();
    const result = await documentTool.execute(
      { target: 'all', path: path.join(tmpDir, 'nonexistent.ts') },
      ctx,
    );
    expect(result.results[0].status).toBe('error');
    expect(result.results[0].error).toBeDefined();
  });

  it('uses jsdoc style by default', async () => {
    const ctx = makeCtx();
    const result = await documentTool.execute(
      { target: 'all', path: path.join(tmpDir, 'test.ts') },
      ctx,
    );
    expect(result.style).toBe('jsdoc');
  });

  it('uses tsdoc style when specified', async () => {
    const ctx = makeCtx();
    const result = await documentTool.execute(
      { target: 'all', path: path.join(tmpDir, 'test.ts'), style: 'tsdoc' },
      ctx,
    );
    expect(result.style).toBe('tsdoc');
  });

  it('uses block style when specified', async () => {
    const ctx = makeCtx();
    const result = await documentTool.execute(
      { target: 'all', path: path.join(tmpDir, 'test.ts'), style: 'block' },
      ctx,
    );
    expect(result.style).toBe('block');
  });

  it('respects overwrite flag', async () => {
    const ctx = makeCtx();
    const result = await documentTool.execute(
      { target: 'all', path: path.join(tmpDir, 'test.ts'), overwrite: true },
      ctx,
    );
    expect(result).toHaveProperty('style');
  });

  it('processes functions in a real file', async () => {
    const filePath = path.join(tmpDir, 'funcs.ts');
    await fs.writeFile(
      filePath,
      'export function hello() {}\nexport async function world() {}',
      'utf8',
    );
    const ctx = makeCtx();
    const result = await documentTool.execute({ target: 'function', files: 'funcs.ts' }, ctx);
    expect(result.files_processed).toBe(1);
    expect(result.items_documented).toBe(0); // still skipped, just detected
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('detects functions and arrow functions (target: function)', async () => {
    const filePath = path.join(tmpDir, 'fns.ts');
    await fs.writeFile(
      filePath,
      ['function plain(a) {}', 'const arrow = (b) => b', 'class NotIncluded {}'].join('\n'),
      'utf8',
    );
    const ctx = makeCtx();
    const result = await documentTool.execute({ target: 'function', files: 'fns.ts' }, ctx);
    const names = result.results.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['plain', 'arrow']));
    expect(names).not.toContain('NotIncluded'); // class excluded under target=function
    expect(result.results.every((r) => r.status === 'skipped')).toBe(true);
    expect(result.results[0]?.docstring).toMatch(/documented at line/);
  });

  it('detects classes (target: class)', async () => {
    const filePath = path.join(tmpDir, 'cls.ts');
    await fs.writeFile(filePath, 'class Alpha {}\nclass Beta {}', 'utf8');
    const ctx = makeCtx();
    const result = await documentTool.execute({ target: 'class', files: 'cls.ts' }, ctx);
    expect(result.results.map((r) => r.name)).toEqual(expect.arrayContaining(['Alpha', 'Beta']));
  });

  it('detects types and interfaces (target: type)', async () => {
    const filePath = path.join(tmpDir, 'types.ts');
    // The detector requires `=` or `<` after the name, so the interface is generic.
    await fs.writeFile(filePath, 'type Foo = number;\ninterface Bar<T> {}', 'utf8');
    const ctx = makeCtx();
    const result = await documentTool.execute({ target: 'type', files: 'types.ts' }, ctx);
    expect(result.results.map((r) => r.name)).toEqual(expect.arrayContaining(['Foo', 'Bar']));
  });

  it('detects everything under target: all', async () => {
    const filePath = path.join(tmpDir, 'mixed.ts');
    await fs.writeFile(filePath, 'function f() {}\nclass C {}\ntype T = string;', 'utf8');
    const ctx = makeCtx();
    const result = await documentTool.execute({ target: 'all', files: 'mixed.ts' }, ctx);
    const names = result.results.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['f', 'C', 'T']));
  });

  it('resolves a comma-separated file list and skips directories', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.ts'), 'function a() {}', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'b.ts'), 'function b() {}', 'utf8');
    await fs.mkdir(path.join(tmpDir, 'adir'));
    const ctx = makeCtx();
    const result = await documentTool.execute(
      { target: 'function', files: 'a.ts, b.ts, adir, missing.ts' },
      ctx,
    );
    // a.ts + b.ts processed; the directory and the missing file are skipped.
    expect(result.files_processed).toBe(2);
  });

  it('rejects files entries that escape the project root (relative and absolute)', async () => {
    // A file that really exists outside the project root must not be readable
    // through the `files` list — neither via `../` traversal nor via an
    // absolute path (POSIX or Windows style).
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-outside-'));
    try {
      const secret = path.join(outside, 'secret.ts');
      await fs.writeFile(secret, 'function leaked() {}', 'utf8');
      const ctx = makeCtx();
      const rel = path.relative(tmpDir, secret); // ../doc-outside-…/secret.ts
      const result = await documentTool.execute(
        { target: 'function', files: `${rel},${secret}` },
        ctx,
      );
      expect(result.files_processed).toBe(0);
      expect(result.results).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('accepts files passed as an array', async () => {
    await fs.writeFile(path.join(tmpDir, 'arr.ts'), 'function z() {}', 'utf8');
    const ctx = makeCtx();
    const result = await documentTool.execute({ target: 'function', files: ['arr.ts'] }, ctx);
    expect(result.files_processed).toBe(1);
    expect(result.results.map((r) => r.name)).toContain('z');
  });
});
