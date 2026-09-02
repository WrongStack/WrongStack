/**
 * Tests for the codebase-incoming-calls and codebase-outgoing-calls tools.
 *
 * These tools query the SQLite index's refs graph to find callers (incoming)
 * and callees (outgoing) of a named symbol. Tests verify:
 *   - Correct identification of incoming callers across files
 *   - Correct identification of outgoing callees
 *   - File scoping disambiguation
 *   - Empty results for unknown symbols
 *   - Limit enforcement
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetIndexStateForTesting } from '../src/codebase-index/background-indexer.js';
import { codebaseIncomingCallsTool } from '../src/codebase-index/codebase-incoming-calls-tool.js';
import { codebaseOutgoingCallsTool } from '../src/codebase-index/codebase-outgoing-calls-tool.js';
import { codebaseIndexTool } from '../src/codebase-index/codebase-index-tool.js';
import { indexStorePool } from '../src/codebase-index/writer.js';

process.env['WRONGSTACK_INDEX_INLINE'] = '1';

function mkCtx(root: string): Context {
  const messages: Context['messages'] = [];
  const todos: Context['todos'] = [];
  const readFiles = new Set<string>();
  const fileMtimes = new Map<string, number>();
  return {
    cwd: root,
    projectRoot: root,
    meta: { codebaseIndexDir: path.join(root, '.codebase-index') },
    readFiles,
    fileMtimes,
    hasRead(p: string) {
      return readFiles.has(p);
    },
    lastReadMtime(p: string) {
      return fileMtimes.get(p);
    },
    recordRead(p: string, m: number) {
      readFiles.add(p);
      fileMtimes.set(p, m);
    },
    todos,
    session: {
      id: 'test',
      parentSessionId: undefined,
      messages,
    },
  } as never as Context;
}

function newSignal(): AbortSignal {
  return new AbortController().signal;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('codebase-incoming-calls tool', () => {
  let tmpDir: string;
  let ctx: Context;

  beforeEach(async () => {
    resetIndexStateForTesting();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-cbic-'));
    ctx = mkCtx(tmpDir);
  });

  afterEach(async () => {
    indexStorePool.evict(tmpDir, path.join(tmpDir, '.codebase-index'));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('finds callers of a function across files', async () => {
    // Target: greet() is called from multiple files.
    await fs.writeFile(
      path.join(tmpDir, 'target.ts'),
      'export function greet(name: string): string { return `Hello, \u0024{name}`; }',
    );
    await fs.writeFile(
      path.join(tmpDir, 'caller-a.ts'),
      `import { greet } from './target.js';\nfunction callerA(): void { const msg = greet('world'); }`,
    );
    await fs.writeFile(
      path.join(tmpDir, 'caller-b.ts'),
      `import { greet } from './target.js';\nfunction callerB(): void { const msg = greet('there'); }`,
    );
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseIncomingCallsTool.execute({ symbol: 'greet' }, ctx, {
      signal: newSignal(),
    });

    expect(result.total).toBeGreaterThanOrEqual(2);
    // Every call site should reference 'greet' in its metadata
    for (const call of result.calls) {
      expect(call.callType).toBeDefined();
      expect(call.symbol.name).toBeDefined();
      expect(call.symbol.file).toBeDefined();
    }
  });

  it('returns empty for a symbol that has no callers', async () => {
    await fs.writeFile(path.join(tmpDir, 'orphan.ts'), 'export function orphanFunc(): void { }');
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseIncomingCallsTool.execute({ symbol: 'orphanFunc' }, ctx, {
      signal: newSignal(),
    });

    expect(result.total).toBe(0);
    expect(result.calls).toEqual([]);
  });

  it('returns empty for an unknown symbol', async () => {
    await fs.writeFile(path.join(tmpDir, 'any.ts'), 'function anyFunc(): void { }');
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseIncomingCallsTool.execute({ symbol: 'doesNotExist' }, ctx, {
      signal: newSignal(),
    });

    expect(result.total).toBe(0);
  });

  it('respects the limit parameter', async () => {
    // Create a target called from many places
    await fs.writeFile(path.join(tmpDir, 'target.ts'), 'export function popularFunc(): void { }');
    // Create 3 callers
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(
        path.join(tmpDir, `caller-${i}.ts`),
        `import { popularFunc } from './target.js';\nfunction caller${i}(): void { popularFunc(); }`,
      );
    }
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseIncomingCallsTool.execute(
      { symbol: 'popularFunc', limit: 1 },
      ctx,
      { signal: newSignal() },
    );

    expect(result.calls.length).toBeLessThanOrEqual(1);
  });

  it('scopes by a project-relative file path', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'target.ts'),
      'export function greet(): string { return "hi"; }',
    );
    await fs.writeFile(
      path.join(tmpDir, 'caller.ts'),
      `import { greet } from './target.js';\nfunction caller(): void { greet(); }`,
    );
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseIncomingCallsTool.execute(
      { symbol: 'greet', file: 'target.ts' },
      ctx,
      { signal: newSignal() },
    );

    expect(result.note).toBeUndefined();
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it('scopes by file when provided', async () => {
    // Same function name in two files, only one gets callers.
    await fs.writeFile(path.join(tmpDir, 'a.ts'), 'export function sharedName(): void { }');
    await fs.writeFile(path.join(tmpDir, 'b.ts'), 'export function sharedName(): void { }');
    await fs.writeFile(
      path.join(tmpDir, 'caller.ts'),
      `import { sharedName } from './a.js';\nfunction doCall(): void { sharedName(); }`,
    );
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseIncomingCallsTool.execute(
      { symbol: 'sharedName', file: path.join(tmpDir, 'a.ts') },
      ctx,
      { signal: newSignal() },
    );

    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it('does not silently drop callers when querying the non-canonical duplicate', async () => {
    // Ref resolution assigns to_id name-globally via MIN(id), so callers of
    // `sharedName` all resolve to the a.ts symbol (indexed first). Querying
    // the b.ts duplicate must still surface callers via name-level matching
    // instead of returning an empty result (writer-graph-reader.ts).
    await fs.writeFile(path.join(tmpDir, 'a.ts'), 'export function sharedName(): void { }');
    await fs.writeFile(path.join(tmpDir, 'b.ts'), 'export function sharedName(): void { }');
    await fs.writeFile(
      path.join(tmpDir, 'caller.ts'),
      `import { sharedName } from './a.js';\nfunction doCall(): void { sharedName(); }`,
    );
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseIncomingCallsTool.execute(
      { symbol: 'sharedName', file: path.join(tmpDir, 'b.ts') },
      ctx,
      { signal: newSignal() },
    );

    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.calls.some((c) => c.symbol.name === 'doCall')).toBe(true);
  });
});

describe('codebase-outgoing-calls tool', () => {
  let tmpDir: string;
  let ctx: Context;

  beforeEach(async () => {
    resetIndexStateForTesting();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-cboc-'));
    ctx = mkCtx(tmpDir);
  });

  afterEach(async () => {
    indexStorePool.evict(tmpDir, path.join(tmpDir, '.codebase-index'));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('finds callees of a function', async () => {
    // Source: orchestrator() calls helper() and transform().
    await fs.writeFile(
      path.join(tmpDir, 'helpers.ts'),
      'export function helper(): void { }\nexport function transform(): void { }',
    );
    await fs.writeFile(
      path.join(tmpDir, 'orchestrator.ts'),
      `import { helper, transform } from './helpers.js';\nexport function orchestrator(): void {\n  helper();\n  transform();\n}`,
    );
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseOutgoingCallsTool.execute({ symbol: 'orchestrator' }, ctx, {
      signal: newSignal(),
    });

    expect(result.total).toBeGreaterThanOrEqual(2);
    const calleeNames = result.calls.map((c) => c.symbol.name);
    expect(calleeNames).toContain('helper');
    expect(calleeNames).toContain('transform');
  });

  it('returns empty for a function with no dependencies', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'leaf.ts'),
      'export function leafFunc(): void { const x = 1; }',
    );
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseOutgoingCallsTool.execute({ symbol: 'leafFunc' }, ctx, {
      signal: newSignal(),
    });

    expect(result.total).toBe(0);
    expect(result.calls).toEqual([]);
  });

  it('returns empty for an unknown symbol', async () => {
    await fs.writeFile(path.join(tmpDir, 'any.ts'), 'function anyFunc(): void { }');
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseOutgoingCallsTool.execute({ symbol: 'nonExistent' }, ctx, {
      signal: newSignal(),
    });

    expect(result.total).toBe(0);
  });

  it('respects the limit parameter', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'deps.ts'),
      Array.from({ length: 5 }, (_, i) => `export function dep${i}(): void { }`).join('\n'),
    );
    await fs.writeFile(
      path.join(tmpDir, 'source.ts'),
      `import { ${Array.from({ length: 5 }, (_, i) => `dep${i}`).join(', ')} } from './deps.js';\nexport function source(): void {\n  ${Array.from({ length: 5 }, (_, i) => `dep${i}();`).join('\n  ')}\n}`,
    );
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseOutgoingCallsTool.execute({ symbol: 'source', limit: 2 }, ctx, {
      signal: newSignal(),
    });

    expect(result.calls.length).toBeLessThanOrEqual(2);
  });
});

// ─── Chunked query & ambiguity tests ──────────────────────────────────────────

describe('chunked query (900+ matching symbol IDs)', () => {
  let tmpDir: string;
  let ctx: Context;

  beforeEach(async () => {
    resetIndexStateForTesting();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-cbchunk-'));
    ctx = mkCtx(tmpDir);
  });

  afterEach(async () => {
    indexStorePool.evict(tmpDir, path.join(tmpDir, '.codebase-index'));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('handles incoming calls with 950+ duplicate symbols (exceeds MAX_SQL_VARS)', async () => {
    // Create 950 files each defining `target()`, plus one file that calls it.
    // This produces 950 symbol IDs for `target`, which exceeds MAX_SQL_VARS=900
    // and forces chunkedIdQuery to split across two chunks.
    const callers = Array.from({ length: 950 }, () => `export function target(): void { }`);
    for (let i = 0; i < callers.length; i++) {
      await fs.writeFile(path.join(tmpDir, `t-${i}.ts`), callers[i]!);
    }
    await fs.writeFile(
      path.join(tmpDir, 'caller.ts'),
      `import { target } from './t-0.js';\nfunction doCall(): void { target(); }`,
    );
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseIncomingCallsTool.execute({ symbol: 'target' }, ctx, {
      signal: newSignal(),
    });

    // Should find at least the one caller despite 950 symbol IDs
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.calls.some((c) => c.symbol.name === 'doCall')).toBe(true);
  });

  it('handles outgoing calls with 950+ matching source IDs', async () => {
    // Create one hub function that calls `dep()`, then create 950 files
    // also named `hub` so resolveSymbolIds returns 950+ IDs.
    await fs.writeFile(path.join(tmpDir, 'dep.ts'), 'export function dep(): void { }');
    await fs.writeFile(
      path.join(tmpDir, 'hub-0.ts'),
      `import { dep } from './dep.js';\nexport function hub(): void { dep(); }`,
    );
    for (let i = 1; i < 950; i++) {
      await fs.writeFile(path.join(tmpDir, `hub-${i}.ts`), 'export function hub(): void { }');
    }
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseOutgoingCallsTool.execute({ symbol: 'hub' }, ctx, {
      signal: newSignal(),
    });

    // Should find the dep() callee despite 950 source IDs
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.calls.some((c) => c.symbol.name === 'dep')).toBe(true);
  });
});

describe('ambiguous flag', () => {
  let tmpDir: string;
  let ctx: Context;

  beforeEach(async () => {
    resetIndexStateForTesting();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-cbamb-'));
    ctx = mkCtx(tmpDir);
  });

  afterEach(async () => {
    indexStorePool.evict(tmpDir, path.join(tmpDir, '.codebase-index'));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns ambiguous note when file-scoped name exists in multiple files', async () => {
    // `dupName` defined in two files; caller only calls the a.ts version.
    // When file=b.ts is specified, the tool detects ambiguity and warns.
    await fs.writeFile(path.join(tmpDir, 'a.ts'), 'export function dupName(): void { }');
    await fs.writeFile(path.join(tmpDir, 'b.ts'), 'export function dupName(): void { }');
    await fs.writeFile(
      path.join(tmpDir, 'caller.ts'),
      `import { dupName } from './a.js';\nfunction doCall(): void { dupName(); }`,
    );
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseIncomingCallsTool.execute(
      { symbol: 'dupName', file: path.join(tmpDir, 'b.ts') },
      ctx,
      { signal: newSignal() },
    );

    // Results should include callers (via name-level fallback)
    expect(result.total).toBeGreaterThanOrEqual(1);
    // Should carry an ambiguity warning note
    expect(result.note).toBeDefined();
    expect(result.note).toContain('multiple files');
  });

  it('does not set ambiguous note when name is unique', async () => {
    await fs.writeFile(path.join(tmpDir, 'uniq.ts'), 'export function uniqName(): void { }');
    await fs.writeFile(
      path.join(tmpDir, 'caller.ts'),
      `import { uniqName } from './uniq.js';\nfunction doCall(): void { uniqName(); }`,
    );
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseIncomingCallsTool.execute(
      { symbol: 'uniqName', file: path.join(tmpDir, 'uniq.ts') },
      ctx,
      { signal: newSignal() },
    );

    expect(result.total).toBeGreaterThanOrEqual(1);
    // No ambiguity note — name is unique
    expect(result.note).toBeUndefined();
  });

  it('does not set ambiguous note when file is not specified', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.ts'), 'export function multiName(): void { }');
    await fs.writeFile(path.join(tmpDir, 'b.ts'), 'export function multiName(): void { }');
    await fs.writeFile(
      path.join(tmpDir, 'caller.ts'),
      `import { multiName } from './a.js';\nfunction doCall(): void { multiName(); }`,
    );
    await codebaseIndexTool.execute({}, ctx, { signal: newSignal() });

    const result = await codebaseIncomingCallsTool.execute({ symbol: 'multiName' }, ctx, {
      signal: newSignal(),
    });

    expect(result.total).toBeGreaterThanOrEqual(1);
    // No ambiguity note — no file scope requested
    expect(result.note).toBeUndefined();
  });
});
