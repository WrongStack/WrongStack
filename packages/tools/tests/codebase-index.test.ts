/**
 * Tests for the codebase-index package:
 *   bm25.ts      — ranking correctness
 *   ts-parser   — symbol extraction
 *   writer.ts   — SQLite storage
 *   tools       — end-to-end integration
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetIndexStateForTesting } from '../src/codebase-index/background-indexer.js';
import {
  buildBm25Index,
  buildIndexableText,
  FTS_SIGNATURE_MAX_CHARS,
  tokenise,
} from '../src/codebase-index/bm25.js';
import { codebaseIndexTool } from '../src/codebase-index/codebase-index-tool.js';
import { codebaseSearchTool } from '../src/codebase-index/codebase-search-tool.js';
import { codebaseStatsTool } from '../src/codebase-index/codebase-stats-tool.js';
import { runIndexer } from '../src/codebase-index/indexer.js';
import {
  internalKindToLspKind,
  isLspKind,
  LSPSymbolKind,
  lspKindToInternalKind,
} from '../src/codebase-index/lsp-kind.js';
import { SCHEMA_VERSION } from '../src/codebase-index/schema.js';
import { detectLang, parseSymbols } from '../src/codebase-index/ts-parser.js';
import { IndexStore, indexStorePool } from '../src/codebase-index/writer.js';

// This suite drives the codebase index in-process. The project daemon now
// fails closed when its build cannot be located, so the in-process path has to
// be requested rather than fallen into — the same declaration a user would make
// with WRONGSTACK_INDEX_INLINE=1.
process.env['WRONGSTACK_INDEX_INLINE'] = '1';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function mkCtx(root: string): Context {
  const messages: Context['messages'] = [];
  const todos: Context['todos'] = [];
  return {
    cwd: root,
    projectRoot: root,
    // Redirect the index into the temp project dir so tests never touch the
    // real ~/.wrongstack home (the production default location).
    meta: { codebaseIndexDir: path.join(root, '.codebase-index') },
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
    hasRead(p: string) {
      return this.readFiles.has(p);
    },
    lastReadMtime(p: string) {
      return this.fileMtimes.get(p);
    },
    recordRead(p: string, m: number) {
      this.readFiles.add(p);
      this.fileMtimes.set(p, m);
    },
    todos,
    session: {
      id: 'test',
      append: async () => {},
      close: async () => {},
      recordFileChange: () => {},
    },
    messages,
  } as never as Context;
}

function newSignal(): AbortSignal {
  return new AbortController().signal;
}

// ─── BM25 Tests ────────────────────────────────────────────────────────────────

describe('BM25', () => {
  describe('tokenise', () => {
    it('splits on non-word characters and lowercases', async () => {
      expect(tokenise('Hello World-Foo bar_baz')).toEqual(['hello', 'world', 'foo', 'bar', 'baz']);
    });

    it('handles empty and whitespace-only strings', async () => {
      expect(tokenise('')).toEqual([]);
      expect(tokenise('   ')).toEqual([]);
    });

    it('handles unicode letters', async () => {
      const tokens = tokenise('café résumé');
      expect(tokens).toContain('café');
      expect(tokens).toContain('résumé');
    });

    it('preserves apostrophes and dollar signs, splits underscores', async () => {
      // Regression: a refactor accidentally dropped apostrophe from the
      // preserved character set, splitting "can't" into "can" + "t".
      expect(tokenise("can't")).toEqual(["can't"]);
      expect(tokenise("user's")).toEqual(["user's"]);
      // Dollar signs are preserved (common in JS/PHP identifiers).
      expect(tokenise('$apply')).toEqual(['$apply']);
      // Underscores are separators (snake_case → split).
      expect(tokenise('foo_bar_baz')).toEqual(['foo', 'bar', 'baz']);
    });
  });

  describe('buildBm25Index', () => {
    it('returns an empty index for empty docs', async () => {
      const idx = buildBm25Index([]);
      expect(idx.score('hello')).toEqual([]);
    });

    it('ranks a matching doc higher than a non-matching doc', async () => {
      const docs = [
        { id: 1, text: 'function parseJson(input: string): object' },
        { id: 2, text: 'class TreeNode' },
      ];
      const idx = buildBm25Index(docs);
      const results = idx.score('function');
      expect(results.length).toBeGreaterThan(0);
      const top = results.sort((a, b) => b.score - a.score)[0];
      expect(top.id).toBe(1);
    });

    it('handles multi-term queries', async () => {
      const docs = [
        { id: 1, text: 'async function fetchUserData(id: string): Promise<User>' },
        { id: 2, text: 'function saveUser(data: User): void' },
      ];
      const idx = buildBm25Index(docs);
      const results = idx.score('function fetch');
      expect(results.some((r) => r.id === 1)).toBe(true);
    });

    it('applies IDF — rare terms score higher than common ones', async () => {
      const docs = [
        { id: 1, text: 'blorbix widget frobble' },
        { id: 2, text: 'blorbix blorbix blorbix' },
      ];
      const idx = buildBm25Index(docs);
      const results = idx.score('frobble');
      expect(results[0]?.id).toBe(1);
    });

    it('extractSnippet returns a window around the match', async () => {
      const docs = [
        { id: 1, text: 'The authentication handler validates JWT tokens and creates sessions' },
      ];
      const idx = buildBm25Index(docs);
      const snippet = idx.extractSnippet(1, ['jwt']);
      expect(snippet.toLowerCase()).toContain('jwt');
    });

    it('score accepts a filter function', async () => {
      const docs = [
        { id: 1, text: 'function parseJson' },
        { id: 2, text: 'function parseXml' },
      ];
      const idx = buildBm25Index(docs);
      const results = idx.score('function', (id) => id === 2);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(2);
    });
  });
});

// ─── buildIndexableText FTS signature cap (P1) ────────────────────────────────

describe('buildIndexableText signature cap', () => {
  it('drops callable bodies but keeps the declaration header', () => {
    const sig = 'function process(items: string[]): number { const n = items.length; return n; }';
    const text = buildIndexableText('process', sig, '');
    expect(text).toContain('function process(items: string[]): number');
    expect(text).not.toContain('items.length');
  });

  it('keeps destructured parameters searchable', () => {
    const sig = 'function apply({ userId, mode }: Options): void { userId = mode; }';
    const text = buildIndexableText('apply', sig, '');
    expect(text).toContain('{ userId, mode }: Options');
    expect(text).not.toContain('userId = mode');
  });

  it('keeps object-shaped return types and cuts only the body', () => {
    const sig = 'function make(): { value: string } { return { value: "x" }; }';
    const text = buildIndexableText('make', sig, '');
    expect(text).toContain('{ value: string }');
    expect(text).not.toContain('"x"');
  });

  it('keeps declarations without parameter-list + body pairs whole', () => {
    const typeSig = 'type Result = { value: string; count: number }';
    expect(buildIndexableText('Result', typeSig, '')).toContain('value: string; count: number');
    const iface = 'interface Handler { handle(req: Request): Response }';
    expect(buildIndexableText('Handler', iface, '')).toContain('handle(req: Request): Response');
  });

  it('caps oversized headers at FTS_SIGNATURE_MAX_CHARS', () => {
    const long = `function big(${'a'.repeat(400)}: string): void {}`;
    const text = buildIndexableText('big', long, '');
    expect(text.length).toBeLessThan(long.length);
    expect(text).not.toContain('{}');
  });

  it('exports FTS_SIGNATURE_MAX_CHARS = 300', () => {
    expect(FTS_SIGNATURE_MAX_CHARS).toBe(300);
  });
});

// ─── TypeScript Parser Tests ────────────────────────────────────────────────────

describe('ts-parser', () => {
  describe('detectLang', () => {
    it('maps extensions correctly', async () => {
      expect(detectLang('foo.ts')).toBe('ts');
      expect(detectLang('foo.tsx')).toBe('tsx');
      expect(detectLang('foo.js')).toBe('js');
      expect(detectLang('foo.jsx')).toBe('jsx');
      expect(detectLang('foo.go')).toBe('go');
      expect(detectLang('foo.py')).toBe('py');
      expect(detectLang('foo.rs')).toBe('rs');
      expect(detectLang('foo.json')).toBe('json');
      expect(detectLang('foo.yaml')).toBe('yaml');
      expect(detectLang('foo.yml')).toBe('yaml');
      expect(detectLang('foo')).toBe(null);
    });
  });

  describe('parseSymbols', () => {
    it('extracts class declarations', async () => {
      const result = await parseSymbols({
        file: '/test/Test.ts',
        content: 'class UserService { }',
        lang: 'ts',
      });
      expect(result.symbols.length).toBeGreaterThanOrEqual(1);
      expect(result.symbols.find((s) => s.kind === 'class')?.name).toBe('UserService');
    });

    it('extracts function declarations', async () => {
      const result = await parseSymbols({
        file: '/test/utils.ts',
        content: `function greet(name: string): string { return \`Hello \${name}\`; }`,
        lang: 'ts',
      });
      expect(result.symbols.some((s) => s.kind === 'function' && s.name === 'greet')).toBe(true);
    });

    it('extracts interface declarations', async () => {
      const result = await parseSymbols({
        file: '/test/types.ts',
        content: 'interface User { id: string; name: string; }',
        lang: 'ts',
      });
      expect(result.symbols.some((s) => s.kind === 'interface' && s.name === 'User')).toBe(true);
    });

    it('extracts type aliases', async () => {
      const result = await parseSymbols({
        file: '/test/types.ts',
        content: 'type Maybe<T> = T | null;',
        lang: 'ts',
      });
      expect(result.symbols.some((s) => s.kind === 'type' && s.name === 'Maybe')).toBe(true);
    });

    it('extracts const declarations', async () => {
      const result = await parseSymbols({
        file: '/test/constants.ts',
        content: 'const MAX_RETRIES = 5;',
        lang: 'ts',
      });
      expect(result.symbols.some((s) => s.name === 'MAX_RETRIES')).toBe(true);
    });

    it('extracts method declarations inside classes', async () => {
      const result = await parseSymbols({
        file: '/test/Service.ts',
        content: 'class Service { async fetchAll(): Promise<void> { } }',
        lang: 'ts',
      });
      expect(result.symbols.some((s) => s.kind === 'method' && s.name === 'fetchAll')).toBe(true);
    });

    it('extracts enum declarations', async () => {
      const result = await parseSymbols({
        file: '/test/enums.ts',
        content: 'enum Color { Red, Green, Blue }',
        lang: 'ts',
      });
      expect(result.symbols.some((s) => s.kind === 'enum' && s.name === 'Color')).toBe(true);
    });

    it('includes line numbers (1-based)', async () => {
      const result = await parseSymbols({
        file: '/test/test.ts',
        content: 'class Foo { }\nclass Bar { }',
        lang: 'ts',
      });
      const barSymbol = result.symbols.find((s) => s.name === 'Bar');
      expect(barSymbol?.line).toBe(2);
    });

    it('handles invalid source gracefully', async () => {
      const result = await parseSymbols({ file: '/test/bad.ts', content: '', lang: 'ts' });
      expect(result.symbols).toEqual([]);
    });
  });
});

// ─── IndexStore Tests ──────────────────────────────────────────────────────────

describe('IndexStore', () => {
  let store: IndexStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-idx-'));
    store = new IndexStore(tmpDir, { indexDir: path.join(tmpDir, '.codebase-index') });
  });

  afterEach(async () => {
    store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('starts empty', async () => {
    const stats = store.getStats();
    expect(stats.totalSymbols).toBe(0);
    expect(stats.totalFiles).toBe(0);
  });

  it('inserts symbols and returns them with assigned ids', async () => {
    const inserted = store.insertSymbols([
      {
        id: 0,
        lang: 'ts',
        kind: 'class',
        name: 'Foo',
        file: '/p/Foo.ts',
        line: 1,
        col: 0,
        signature: 'class Foo',
        docComment: '',
        scope: '',
        text: 'class Foo',
      },
      {
        id: 0,
        lang: 'ts',
        kind: 'function',
        name: 'bar',
        file: '/p/foo.ts',
        line: 2,
        col: 0,
        signature: 'function bar()',
        docComment: '',
        scope: '',
        text: 'function bar()',
      },
    ]);
    expect(inserted).toHaveLength(2);
    expect(inserted[0].id).toBe(1);
    expect(inserted[1].id).toBe(2);
  });

  it('persists data across store reopens', async () => {
    store.insertSymbols(
      [
        {
          id: 0,
          lang: 'ts',
          kind: 'class',
          name: 'Persisted',
          file: '/p/P.ts',
          line: 1,
          col: 0,
          signature: 'class Persisted',
          docComment: '',
          scope: '',
          text: 'class Persisted',
        },
      ],
      1,
    );
    store.close();
    const store2 = new IndexStore(tmpDir, { indexDir: path.join(tmpDir, '.codebase-index') });
    const stats = store2.getStats();
    expect(stats.totalSymbols).toBe(1);
    store2.close();
  });

  it('deletes symbols for a file', async () => {
    store.insertSymbols(
      [
        {
          id: 0,
          lang: 'ts',
          kind: 'class',
          name: 'A',
          file: '/p/A.ts',
          line: 1,
          col: 0,
          signature: 'class A',
          docComment: '',
          scope: '',
          text: 'class A',
        },
        {
          id: 0,
          lang: 'ts',
          kind: 'class',
          name: 'B',
          file: '/p/B.ts',
          line: 1,
          col: 0,
          signature: 'class B',
          docComment: '',
          scope: '',
          text: 'class B',
        },
      ],
      1,
    );
    store.deleteSymbolsForFile('/p/A.ts');
    const stats = store.getStats();
    expect(stats.totalSymbols).toBe(1);
    const remaining = store.search('');
    expect(remaining.every((s) => s.file !== '/p/A.ts')).toBe(true);
  });

  it('upsertFile and getFileMeta work', async () => {
    store.upsertFile({
      file: '/p/test.ts',
      lang: 'ts',
      mtimeMs: 1000,
      symbolCount: 5,
      lastIndexed: 2000,
    });
    const meta = store.getFileMeta('/p/test.ts');
    expect(meta?.symbolCount).toBe(5);
    expect(meta?.lang).toBe('ts');
  });

  it('search returns matches filtered by kind', async () => {
    store.insertSymbols(
      [
        {
          id: 0,
          lang: 'ts',
          kind: 'class',
          name: 'Foo',
          file: '/p/Foo.ts',
          line: 1,
          col: 0,
          signature: 'class Foo',
          docComment: '',
          scope: '',
          text: 'Foo class Foo',
        },
      ],
      1,
    );
    const results = store.search('foo', { kind: 'class' });
    expect(results.length).toBe(1);
  });

  it('search returns matches filtered by lang', async () => {
    store.insertSymbols(
      [
        {
          id: 0,
          lang: 'ts',
          kind: 'class',
          name: 'TsClass',
          file: '/p/a.ts',
          line: 1,
          col: 0,
          signature: 'class TsClass',
          docComment: '',
          scope: '',
          text: 'TsClass class TsClass',
        },
        {
          id: 0,
          lang: 'go',
          kind: 'class',
          name: 'GoClass',
          file: '/p/b.go',
          line: 1,
          col: 0,
          signature: 'type GoClass struct',
          docComment: '',
          scope: '',
          text: 'GoClass type GoClass',
        },
      ],
      1,
    );
    const results = store.search('class', { lang: 'go' });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('GoClass');
  });

  it('clearAll removes everything', async () => {
    store.insertSymbols(
      [
        {
          id: 0,
          lang: 'ts',
          kind: 'class',
          name: 'X',
          file: '/p/X.ts',
          line: 1,
          col: 0,
          signature: 'class X',
          docComment: '',
          scope: '',
          text: 'class X',
        },
      ],
      1,
    );
    store.clearAll();
    expect(store.getStats().totalSymbols).toBe(0);
  });

  it('setLastIndexed and getStats reflect it', async () => {
    const ts = 1_700_000_000_000;
    store.setLastIndexed(ts);
    const stats = store.getStats();
    expect(stats.lastIndexed).toBe(ts);
  });

  it('sizeBytes returns non-zero after inserts', async () => {
    store.insertSymbols(
      [
        {
          id: 0,
          lang: 'ts',
          kind: 'class',
          name: 'X',
          file: '/p/X.ts',
          line: 1,
          col: 0,
          signature: 'class X',
          docComment: '',
          scope: '',
          text: 'class X',
        },
      ],
      1,
    );
    expect(store.getStats().sizeBytes).toBeGreaterThan(0);
  });
});

// ─── Ranked search (FTS5) ──────────────────────────────────────────────────────

describe('IndexStore.searchRanked', () => {
  let store: IndexStore;
  let tmpDir: string;

  function sym(
    id: number,
    name: string,
    kind: 'class' | 'function',
    signature: string,
  ): Parameters<IndexStore['insertSymbols']>[0][number] {
    return {
      id,
      lang: 'ts',
      kind,
      name,
      file: `/p/${name}.ts`,
      line: 1,
      col: 0,
      signature,
      docComment: '',
      scope: '',
      text: `${name} ${signature}`,
    };
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-fts-'));
    store = new IndexStore(tmpDir, { indexDir: path.join(tmpDir, '.codebase-index') });
  });

  afterEach(async () => {
    store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('matches camelCase parts of a symbol name with score and snippet', async () => {
    store.insertSymbols(
      [
        sym(0, 'complexOperation', 'function', 'function complexOperation(): Promise<void>'),
        sym(0, 'TreeNode', 'class', 'class TreeNode'),
      ],
      1,
    );
    const { results, total } = store.searchRanked('complex', undefined, 20);
    expect(total).toBe(1);
    expect(results[0]?.name).toBe('complexOperation');
    expect(results[0]?.score).toBeGreaterThan(0);
    expect(results[0]?.snippet.length).toBeGreaterThan(0);
  });

  it('matches prefixes (old LIKE recall: "user" finds "users")', async () => {
    store.insertSymbols([sym(0, 'users', 'function', 'function users(): User[]')], 1);
    const { results } = store.searchRanked('user', undefined, 20);
    expect(results.some((r) => r.name === 'users')).toBe(true);
  });

  it('applies kind/lang filters on top of the match', async () => {
    store.insertSymbols(
      [
        sym(0, 'fooHandler', 'function', 'function fooHandler()'),
        sym(0, 'FooHandler', 'class', 'class FooHandler'),
      ],
      1,
    );
    const { results } = store.searchRanked('handler', { kind: 'class' }, 20);
    expect(results.length).toBe(1);
    expect(results[0]?.kind).toBe('class');
  });

  it('empty query lists by filter only (legacy search("") semantics)', async () => {
    store.insertSymbols(
      [sym(0, 'A', 'class', 'class A'), sym(0, 'b', 'function', 'function b()')],
      1,
    );
    const { results, total } = store.searchRanked('', { kind: 'class' }, 20);
    expect(total).toBe(1);
    expect(results[0]?.name).toBe('A');
  });

  it('respects the limit while reporting the full total', async () => {
    store.insertSymbols(
      Array.from({ length: 10 }, (_, i) =>
        sym(0, `widget${i}`, 'function', `function widget${i}()`),
      ),
      1,
    );
    const { results, total } = store.searchRanked('widget', undefined, 3);
    expect(results.length).toBe(3);
    expect(total).toBe(10);
  });

  it('FTS rows follow symbol deletion', async () => {
    store.insertSymbols([sym(0, 'Gone', 'class', 'class Gone')], 1);
    store.deleteSymbolsForFile('/p/Gone.ts');
    const { total } = store.searchRanked('gone', undefined, 20);
    expect(total).toBe(0);
  });

  it('FTS query syntax in input is neutralised, not executed', async () => {
    store.insertSymbols([sym(0, 'Safe', 'class', 'class Safe')], 1);
    // NEAR/AND/parens/quotes must not produce an FTS syntax error.
    expect(() => store.searchRanked('safe" OR (NEAR "x', undefined, 20)).not.toThrow();
  });
});

describe('schema migration', () => {
  it('drops and rebuilds the index when the stored version mismatches', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-mig-'));
    const indexDir = path.join(tmpDir, '.codebase-index');
    try {
      const store = new IndexStore(tmpDir, { indexDir });
      store.insertSymbols(
        [
          {
            id: 0,
            lang: 'ts',
            kind: 'class',
            name: 'Old',
            file: '/p/Old.ts',
            line: 1,
            col: 0,
            signature: 'class Old',
            docComment: '',
            scope: '',
            text: 'class Old',
          },
        ],
        1,
      );
      // Simulate a database written by an older schema.
      (store as never as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
        .prepare('UPDATE metadata SET value = ? WHERE key = ?')
        .run('1', 'version');
      store.close();

      const reopened = new IndexStore(tmpDir, { indexDir });
      try {
        expect(reopened.getStats().totalSymbols).toBe(0);
        expect(reopened.getStats().version).toBe(SCHEMA_VERSION);
      } finally {
        reopened.close();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── Tool Integration Tests ────────────────────────────────────────────────────

describe('codebase-index tool', () => {
  let tmpDir: string;
  let ctx: Context;

  beforeEach(async () => {
    resetIndexStateForTesting();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-cbi-'));
    ctx = mkCtx(tmpDir);
  });

  afterEach(async () => {
    indexStorePool.evict(tmpDir, path.join(tmpDir, '.codebase-index'));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('indexes a TypeScript file and returns stats', async () => {
    await fs.writeFile(path.join(tmpDir, 'Foo.ts'), 'class Foo { }\nfunction bar(): void { }');

    const result = await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    expect(result.filesIndexed).toBeGreaterThanOrEqual(1);
    expect(result.symbolsIndexed).toBeGreaterThanOrEqual(2);
    expect(result.errors).toHaveLength(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('force reindex clears old data', async () => {
    await fs.writeFile(path.join(tmpDir, 'A.ts'), 'class A { }');
    const first = await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });
    expect(first.symbolsIndexed).toBeGreaterThanOrEqual(1);

    const second = await codebaseIndexTool.execute({ force: true }, ctx, { signal: newSignal() });
    expect(second.errors).toHaveLength(0);
  });

  it('incremental reindex skips unchanged files', async () => {
    const filePath = path.join(tmpDir, 'B.ts');
    await fs.writeFile(filePath, 'class B { }');

    const first = await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });
    const firstSymCount = first.symbolsIndexed;

    // Stamp the persisted row with a sentinel. An unchanged incremental run
    // must reuse that metadata; reparsing the file would overwrite it with
    // Date.now(). This checks the skip contract directly instead of comparing
    // wall-clock durations, which is flaky under Windows coverage contention.
    const indexDir = path.join(tmpDir, '.codebase-index');
    const store = indexStorePool.acquire(tmpDir, { indexDir });
    try {
      const firstMeta = store.getFileMeta(filePath);
      expect(firstMeta).not.toBeNull();
      if (firstMeta !== null) store.upsertFile({ ...firstMeta, lastIndexed: 1 });
    } finally {
      indexStorePool.release(store);
    }

    const second = await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });
    expect(second.symbolsIndexed).toBe(firstSymCount);

    const verificationStore = indexStorePool.acquire(tmpDir, { indexDir });
    try {
      expect(verificationStore.getFileMeta(filePath)?.lastIndexed).toBe(1);
    } finally {
      indexStorePool.release(verificationStore);
    }
  });

  it('reindexing a low-id file after others were added does not collide ids', async () => {
    // Regression: ids were allocated from COUNT(*), so once a changed file's
    // rows were deleted the count dropped below MAX(id) and the new ids landed
    // on surviving rows → "UNIQUE constraint failed: symbols.id". Allocation now
    // uses MAX(id)+1. Sequence below deterministically triggered the old bug.
    const aPath = path.join(tmpDir, 'A.ts');
    const bPath = path.join(tmpDir, 'B.ts');

    // 1. A has 1 symbol → gets the low id.
    await fs.writeFile(aPath, 'class A1 {}');
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    // 2. B adds 3 symbols → higher ids; A stays unchanged (skipped).
    await fs.writeFile(bPath, 'class B1 {}\nclass B2 {}\nclass B3 {}');
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    // 3. Grow A to 3 symbols and force a newer mtime so it is reindexed.
    await fs.writeFile(aPath, 'class A1 {}\nclass A2 {}\nclass A3 {}');
    const future = new Date(Date.now() + 5000);
    await fs.utimes(aPath, future, future);

    const result = await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });
    expect(result.errors).toHaveLength(0);

    // The new symbols are searchable and nothing was lost.
    const found = await codebaseSearchTool.execute({ query: 'A3' }, ctx, { signal: newSignal() });
    expect(found.results.some((r) => r.name === 'A3')).toBe(true);
    const foundB = await codebaseSearchTool.execute({ query: 'B2' }, ctx, { signal: newSignal() });
    expect(foundB.results.some((r) => r.name === 'B2')).toBe(true);
  });

  it('skips files and directories matched by .gitignore', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'ignored-dir/\nsecret.ts\n');
    await fs.mkdir(path.join(tmpDir, 'ignored-dir'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'ignored-dir', 'Hidden.ts'), 'class HiddenSymbol {}');
    await fs.writeFile(path.join(tmpDir, 'secret.ts'), 'class SecretSymbol {}');
    await fs.writeFile(path.join(tmpDir, 'Visible.ts'), 'class VisibleSymbol {}');

    const result = await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });
    expect(result.errors).toHaveLength(0);

    const visible = await codebaseSearchTool.execute({ query: 'VisibleSymbol' }, ctx, {
      signal: newSignal(),
    });
    expect(visible.results.some((r) => r.name === 'VisibleSymbol')).toBe(true);

    const hidden = await codebaseSearchTool.execute({ query: 'HiddenSymbol' }, ctx, {
      signal: newSignal(),
    });
    expect(hidden.results.some((r) => r.name === 'HiddenSymbol')).toBe(false);

    const secret = await codebaseSearchTool.execute({ query: 'SecretSymbol' }, ctx, {
      signal: newSignal(),
    });
    expect(secret.results.some((r) => r.name === 'SecretSymbol')).toBe(false);
  });

  it('skips a gitignored file passed explicitly (watcher / per-edit path)', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'generated.ts\n');
    const gen = path.join(tmpDir, 'generated.ts');
    await fs.writeFile(gen, 'class GeneratedSymbol {}');

    // The per-edit / watcher path calls runIndexer directly with an explicit
    // file list (the tool itself never forwards `files`).
    const result = await runIndexer(ctx, {
      projectRoot: tmpDir,
      files: [gen],
      indexDir: path.join(tmpDir, '.codebase-index'),
    });
    expect(result.filesIndexed).toBe(0);
    expect(result.symbolsIndexed).toBe(0);
  });
});

describe('codebase-stats tool', () => {
  let tmpDir: string;
  let ctx: Context;

  beforeEach(async () => {
    resetIndexStateForTesting();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-cbs-'));
    ctx = mkCtx(tmpDir);
  });

  afterEach(async () => {
    indexStorePool.evict(tmpDir, path.join(tmpDir, '.codebase-index'));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns zero stats when no index exists', async () => {
    const stats = await codebaseStatsTool.execute({}, ctx, { signal: newSignal() });
    expect(stats.totalSymbols).toBe(0);
    expect(stats.version).toBe(SCHEMA_VERSION);
  });

  it('reflects indexed symbols', async () => {
    await fs.writeFile(path.join(tmpDir, 'C.ts'), 'class C { }');
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const stats = await codebaseStatsTool.execute({}, ctx, { signal: newSignal() });
    expect(stats.totalSymbols).toBeGreaterThanOrEqual(1);
    expect(stats.totalFiles).toBeGreaterThanOrEqual(1);
    expect(stats.byLang).toHaveProperty('ts');
  });
});

describe('codebase-search tool', () => {
  let tmpDir: string;
  let ctx: Context;

  beforeEach(async () => {
    resetIndexStateForTesting();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-cbsea-'));
    ctx = mkCtx(tmpDir);
  });

  afterEach(async () => {
    indexStorePool.evict(tmpDir, path.join(tmpDir, '.codebase-index'));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('finds a class by name', async () => {
    await fs.writeFile(path.join(tmpDir, 'UserService.ts'), 'class UserService { }');
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseSearchTool.execute({ query: 'UserService' }, ctx, {
      signal: newSignal(),
    });

    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0].name).toBe('UserService');
    expect(result.results[0].kind).toBe('class');
    expect(result.results[0].score).toBeGreaterThan(0);
  });

  it('finds functions by signature keyword', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'math.ts'),
      'function add(a: number, b: number): number { return a + b; }',
    );
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseSearchTool.execute({ query: 'number' }, ctx, {
      signal: newSignal(),
    });

    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it('filters by kind', async () => {
    await fs.writeFile(path.join(tmpDir, 'mixed.ts'), 'class Foo { }\nfunction bar(): void { }');
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseSearchTool.execute(
      { query: 'class function', kind: 'function' },
      ctx,
      { signal: newSignal() },
    );

    for (const r of result.results) {
      expect(r.kind).toBe('function');
    }
  });

  it('returns empty results for an unknown query', async () => {
    await fs.writeFile(path.join(tmpDir, 'D.ts'), 'class D { }');
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseSearchTool.execute({ query: 'zzznomatchzzz' }, ctx, {
      signal: newSignal(),
    });
    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 20; i++) {
      await fs.writeFile(path.join(tmpDir, `File${i}.ts`), `class Class${i} { }`);
    }
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseSearchTool.execute({ query: 'class', limit: 5 }, ctx, {
      signal: newSignal(),
    });
    expect(result.results.length).toBeLessThanOrEqual(5);
  });

  it('includes a snippet in results', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'E.ts'),
      'function complexOperation(): Promise<void> { return Promise.resolve(); }',
    );
    const indexResult = await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });
    expect(indexResult.errors, indexResult.errors.join('\n')).toHaveLength(0);
    expect(indexResult.symbolsIndexed).toBeGreaterThan(0);

    const result = await codebaseSearchTool.execute({ query: 'complex' }, ctx, {
      signal: newSignal(),
    });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]).toBeDefined();
    expect(result.query).toBe('complex');
    expect(result.total).toBeGreaterThan(0);
    expect(result.results[0].snippet).toBeTruthy();
    expect(result.results[0].snippet.length).toBeGreaterThan(0);
  });
});

// ─── LSP Kind Mapping Tests ─────────────────────────────────────────────────────

describe('lspKindToInternalKind', () => {
  it('maps LSP Class (5) to class', async () => {
    expect(lspKindToInternalKind(LSPSymbolKind.Class)).toBe('class');
  });

  it('maps LSP Function (12) to function', async () => {
    expect(lspKindToInternalKind(LSPSymbolKind.Function)).toBe('function');
  });

  it('maps LSP Interface (11) to interface', async () => {
    expect(lspKindToInternalKind(LSPSymbolKind.Interface)).toBe('interface');
  });

  it('maps LSP Enum (10) to enum', async () => {
    expect(lspKindToInternalKind(LSPSymbolKind.Enum)).toBe('enum');
  });

  it('maps LSP Method (6) to method', async () => {
    expect(lspKindToInternalKind(LSPSymbolKind.Method)).toBe('method');
  });

  it('maps LSP Property (7) to property', async () => {
    expect(lspKindToInternalKind(LSPSymbolKind.Property)).toBe('property');
  });

  it('maps LSP Field (8) to property', async () => {
    expect(lspKindToInternalKind(LSPSymbolKind.Field)).toBe('property');
  });

  it('maps LSP Variable (13) to var', async () => {
    expect(lspKindToInternalKind(LSPSymbolKind.Variable)).toBe('var');
  });

  it('maps LSP Constant (14) to const', async () => {
    expect(lspKindToInternalKind(LSPSymbolKind.Constant)).toBe('const');
  });

  it('maps LSP Namespace (3) to namespace', async () => {
    expect(lspKindToInternalKind(LSPSymbolKind.Namespace)).toBe('namespace');
  });

  it('maps LSP TypeParameter (26) to type', async () => {
    expect(lspKindToInternalKind(LSPSymbolKind.TypeParameter)).toBe('type');
  });

  it('maps LSP Constructor (9) to class', async () => {
    expect(lspKindToInternalKind(LSPSymbolKind.Constructor)).toBe('class');
  });

  it('maps LSP EnumMember (22) to enum', async () => {
    expect(lspKindToInternalKind(LSPSymbolKind.EnumMember)).toBe('enum');
  });

  it('returns null for unmapped LSP kinds (String, Number, etc.)', async () => {
    expect(lspKindToInternalKind(LSPSymbolKind.String)).toBeNull();
    expect(lspKindToInternalKind(LSPSymbolKind.Number)).toBeNull();
    expect(lspKindToInternalKind(LSPSymbolKind.Boolean)).toBeNull();
    expect(lspKindToInternalKind(LSPSymbolKind.Array)).toBeNull();
    expect(lspKindToInternalKind(LSPSymbolKind.Object)).toBeNull();
    expect(lspKindToInternalKind(LSPSymbolKind.Null)).toBeNull();
    expect(lspKindToInternalKind(LSPSymbolKind.Struct)).toBeNull();
    expect(lspKindToInternalKind(LSPSymbolKind.Event)).toBeNull();
    expect(lspKindToInternalKind(LSPSymbolKind.Operator)).toBeNull();
  });

  it('returns null for invalid numbers', async () => {
    expect(lspKindToInternalKind(0)).toBeNull();
    expect(lspKindToInternalKind(-1)).toBeNull();
    expect(lspKindToInternalKind(27)).toBeNull();
    expect(lspKindToInternalKind(100)).toBeNull();
  });
});

describe('internalKindToLspKind', () => {
  it('reverses class to Class (5)', async () => {
    expect(internalKindToLspKind('class')).toBe(LSPSymbolKind.Class);
  });

  it('reverses function to Function (12)', async () => {
    expect(internalKindToLspKind('function')).toBe(LSPSymbolKind.Function);
  });

  it('reverses interface to Interface (11)', async () => {
    expect(internalKindToLspKind('interface')).toBe(LSPSymbolKind.Interface);
  });

  it('reverses enum to Enum (10)', async () => {
    expect(internalKindToLspKind('enum')).toBe(LSPSymbolKind.Enum);
  });

  it('reverses method to Method (6)', async () => {
    expect(internalKindToLspKind('method')).toBe(LSPSymbolKind.Method);
  });

  it('reverses property to Property (7)', async () => {
    expect(internalKindToLspKind('property')).toBe(LSPSymbolKind.Property);
  });

  it('reverses var to Variable (13)', async () => {
    expect(internalKindToLspKind('var')).toBe(LSPSymbolKind.Variable);
  });

  it('reverses const to Constant (14)', async () => {
    expect(internalKindToLspKind('const')).toBe(LSPSymbolKind.Constant);
  });

  it('reverses let to Variable (13)', async () => {
    expect(internalKindToLspKind('let')).toBe(LSPSymbolKind.Variable);
  });

  it('reverses namespace to Namespace (3)', async () => {
    expect(internalKindToLspKind('namespace')).toBe(LSPSymbolKind.Namespace);
  });

  it('reverses type to TypeParameter (26)', async () => {
    expect(internalKindToLspKind('type')).toBe(LSPSymbolKind.TypeParameter);
  });

  it('returns null for unmapped internal kinds', async () => {
    expect(internalKindToLspKind('parameter')).toBeNull();
  });
});

describe('isLspKind', () => {
  it('returns true for valid LSP kind numbers 1–26', async () => {
    for (let k = 1; k <= 26; k++) {
      expect(isLspKind(k)).toBe(true);
    }
  });

  it('returns false for numbers outside 1–26', async () => {
    expect(isLspKind(0)).toBe(false);
    expect(isLspKind(-1)).toBe(false);
    expect(isLspKind(27)).toBe(false);
    expect(isLspKind(100)).toBe(false);
  });

  it('returns false for non-integers', async () => {
    expect(isLspKind(5.5)).toBe(false);
    expect(isLspKind(Number.NaN)).toBe(false);
    expect(isLspKind(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('search with lspKind filter', () => {
  let store: IndexStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-lsp-'));
    store = new IndexStore(tmpDir, { indexDir: path.join(tmpDir, '.codebase-index') });
  });

  afterEach(async () => {
    store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('filters by LSP kind number (class → 5)', async () => {
    store.insertSymbols(
      [
        {
          id: 0,
          lang: 'ts',
          kind: 'class',
          name: 'FooClass',
          file: '/p/Foo.ts',
          line: 1,
          col: 0,
          signature: 'class FooClass',
          docComment: '',
          scope: '',
          text: 'FooClass class',
        },
        {
          id: 0,
          lang: 'ts',
          kind: 'function',
          name: 'barFn',
          file: '/p/bar.ts',
          line: 1,
          col: 0,
          signature: 'function barFn()',
          docComment: '',
          scope: '',
          text: 'barFn function',
        },
      ],
      1,
    );
    const results = store.search('', { lspKind: LSPSymbolKind.Class });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('FooClass');
    expect(results[0].kind).toBe('class');
    expect(results[0].lspKind).toBe(LSPSymbolKind.Class);
  });

  it('filters by LSP kind number (function → 12)', async () => {
    store.insertSymbols(
      [
        {
          id: 0,
          lang: 'ts',
          kind: 'class',
          name: 'FooClass',
          file: '/p/Foo.ts',
          line: 1,
          col: 0,
          signature: 'class FooClass',
          docComment: '',
          scope: '',
          text: 'FooClass class',
        },
        {
          id: 0,
          lang: 'ts',
          kind: 'function',
          name: 'barFn',
          file: '/p/bar.ts',
          line: 1,
          col: 0,
          signature: 'function barFn()',
          docComment: '',
          scope: '',
          text: 'barFn function',
        },
      ],
      1,
    );
    const results = store.search('', { lspKind: LSPSymbolKind.Function });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('barFn');
    expect(results[0].kind).toBe('function');
    expect(results[0].lspKind).toBe(LSPSymbolKind.Function);
  });

  it('filters by LSP kind number (enum → 10)', async () => {
    store.insertSymbols(
      [
        {
          id: 0,
          lang: 'ts',
          kind: 'enum',
          name: 'Status',
          file: '/p/enums.ts',
          line: 1,
          col: 0,
          signature: 'enum Status',
          docComment: '',
          scope: '',
          text: 'Status enum',
        },
      ],
      1,
    );
    const results = store.search('', { lspKind: LSPSymbolKind.Enum });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('Status');
    expect(results[0].kind).toBe('enum');
  });

  it('returns empty array when LSP kind has no internal mapping', async () => {
    store.insertSymbols(
      [
        {
          id: 0,
          lang: 'ts',
          kind: 'class',
          name: 'FooClass',
          file: '/p/Foo.ts',
          line: 1,
          col: 0,
          signature: 'class FooClass',
          docComment: '',
          scope: '',
          text: 'FooClass class',
        },
      ],
      1,
    );
    // String (15) has no internal mapping
    const results = store.search('', { lspKind: LSPSymbolKind.String });
    expect(results.length).toBe(0);
  });

  it('lspKind is undefined in result when no lspKind filter was applied', async () => {
    store.insertSymbols(
      [
        {
          id: 0,
          lang: 'ts',
          kind: 'class',
          name: 'FooClass',
          file: '/p/Foo.ts',
          line: 1,
          col: 0,
          signature: 'class FooClass',
          docComment: '',
          scope: '',
          text: 'FooClass class',
        },
      ],
      1,
    );
    const results = store.search('', { kind: 'class' });
    expect(results[0].lspKind).toBeUndefined();
  });
});
