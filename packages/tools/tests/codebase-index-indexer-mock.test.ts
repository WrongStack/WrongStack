import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drive the indexer's defensive catch/re-throw branches that real Node fs never
// reaches: fs.stat/readFile only throw a *DOMException*-flavoured AbortError when
// a signal-aware wrapper raises one (Node itself throws a plain AbortError that
// isAbortError() treats as an ordinary error), and the parsers swallow their own
// failures. We inject those conditions through module mocks.

interface FsCfg {
  statThrows?: unknown;
  readThrows?: unknown;
}
const fsCfg: FsCfg = {};

vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: vi.fn((p: string, o?: unknown) => {
      if (fsCfg.statThrows && p.endsWith('.ts')) throw fsCfg.statThrows;
      return (actual.stat as (p: string, o?: unknown) => unknown)(p, o);
    }),
    readFile: vi.fn((p: string, o?: unknown) => {
      if (fsCfg.readThrows && typeof p === 'string' && p.endsWith('.ts')) throw fsCfg.readThrows;
      return (actual.readFile as (p: string, o?: unknown) => unknown)(p, o);
    }),
  };
});

const parserCfg: { throw?: boolean } = {};
vi.mock('../src/codebase-index/ts-parser.js', async (orig) => {
  const actual = await orig<typeof import('../src/codebase-index/ts-parser.js')>();
  return {
    ...actual,
    parseSymbols: (input: Parameters<typeof actual.parseSymbols>[0]) => {
      if (parserCfg.throw) throw new Error('parser exploded');
      return actual.parseSymbols(input);
    },
  };
});

const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const mockedFs = await import('node:fs/promises');
const { runIndexer } = await import('../src/codebase-index/indexer.js');

const ctx = {} as Context;
let dir: string;
const indexDir = () => path.join(dir, '.codebase-index');

beforeEach(async () => {
  dir = await realFs.mkdtemp(path.join(os.tmpdir(), 'wstack-indexer-mock-'));
  fsCfg.statThrows = undefined;
  fsCfg.readThrows = undefined;
  parserCfg.throw = false;
});
afterEach(async () => {
  await realFs.rm(dir, { recursive: true, force: true });
});

describe('runIndexer defensive branches', () => {
  it('re-throws a DOMException AbortError from fs.stat', async () => {
    const f = path.join(dir, 'a.ts');
    await realFs.writeFile(f, 'export class A {}');
    fsCfg.statThrows = new DOMException('aborted', 'AbortError');
    await expect(
      runIndexer(ctx, { projectRoot: dir, indexDir: indexDir(), files: [f] }),
    ).rejects.toThrow(/aborted/);
  });

  it('re-throws a DOMException AbortError from fs.readFile', async () => {
    const f = path.join(dir, 'a.ts');
    await realFs.writeFile(f, 'export class A {}');
    fsCfg.readThrows = new DOMException('aborted', 'AbortError');
    await expect(
      runIndexer(ctx, { projectRoot: dir, indexDir: indexDir(), files: [f] }),
    ).rejects.toThrow(/aborted/);
  });

  it('records a parse error when a parser throws', async () => {
    const f = path.join(dir, 'a.ts');
    await realFs.writeFile(f, 'export class A {}');
    parserCfg.throw = true;
    const res = await runIndexer(ctx, { projectRoot: dir, indexDir: indexDir(), files: [f] });
    expect(res.filesIndexed).toBe(0);
    expect(res.errors.some((e) => /parse error/.test(e))).toBe(true);
  });

  it('content-validates targeted files without reparsing unchanged bytes', async () => {
    const f = path.join(dir, 'a.ts');
    await realFs.writeFile(f, 'export class A {}');
    const first = await runIndexer(ctx, { projectRoot: dir, indexDir: indexDir(), files: [f] });
    expect(first.filesIndexed).toBe(1);

    vi.mocked(mockedFs.readFile).mockClear();
    parserCfg.throw = true;
    const second = await runIndexer(ctx, { projectRoot: dir, indexDir: indexDir(), files: [f] });

    // P5.15: the mtime changed but content matched, so the file was
    // content-hash SKIPPED — not parsed. filesIndexed no longer counts it.
    expect(second.filesIndexed).toBe(0);
    expect(second.errors).toEqual([]);
    expect(mockedFs.readFile).toHaveBeenCalledWith(f, expect.anything());
  });
});
