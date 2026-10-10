/**
 * Regressions found by driving the codebase tools against a real index
 * (not mocks): each case failed on the index a user actually gets.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadRuntimeDatabaseSync as loadTestDatabaseSync } from '@wrongstack/persistence';

const DatabaseSync = loadTestDatabaseSync();

import { ToolValidationError } from '@wrongstack/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codebaseAstReplaceTool } from '../src/codebase-index/codebase-ast-replace-tool.js';
import { codebaseImpactAnalysisTool } from '../src/codebase-index/codebase-impact-analysis-tool.js';
import { runIndexer } from '../src/codebase-index/indexer.js';
import { indexStorePool } from '../src/codebase-index/writer.js';

const SOURCES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'probe', main: 'src/index.ts' }, null, 2),
  'src/index.ts': "export { main } from './a';\n",
  'src/a.ts': [
    "import { helper, Store } from './b';",
    'export function main(): number {',
    '  const store = new Store();',
    '  return helper(store.size());',
    '}',
    '',
  ].join('\n'),
  'src/b.ts': [
    'export function helper(value: number): number {',
    '  return value + 1;',
    '}',
    '',
    'export class Store {',
    '  size(): number {',
    '    return 0;',
    '  }',
    '}',
    '',
    'export function unused(): void {}',
    '',
  ].join('\n'),
};

describe('codebase tools on a real index', () => {
  let root: string;
  let indexDir: string;
  let previousInline: string | undefined;
  const ctx = () =>
    ({ projectRoot: root, cwd: root, meta: { codebaseIndexDir: indexDir } }) as never;

  beforeAll(async () => {
    previousInline = process.env['WRONGSTACK_INDEX_INLINE'];
    process.env['WRONGSTACK_INDEX_INLINE'] = '1';
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-tools-real-'));
    indexDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-tools-real-idx-'));
    for (const [rel, text] of Object.entries(SOURCES)) {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), text);
    }
    const run = await runIndexer({} as never, { projectRoot: root, indexDir });
    expect(run.errors).toEqual([]);
  });

  afterAll(async () => {
    if (previousInline === undefined) delete process.env['WRONGSTACK_INDEX_INLINE'];
    else process.env['WRONGSTACK_INDEX_INLINE'] = previousInline;
    indexStorePool.evict(root, indexDir);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(indexDir, { recursive: true, force: true });
  });

  it('reports the real line and call type of a direct caller in impact analysis', async () => {
    const out = await codebaseImpactAnalysisTool.execute({ symbol: 'helper' }, ctx(), {} as never);
    expect(out.callSites.filter((site) => !site.indirect)).toEqual([
      expect.objectContaining({ file: 'src/a.ts', callerName: 'main', line: 4, callType: 'call' }),
    ]);
    // The entry barrel re-exports `main`: a real dependent, invisible while
    // files that declare nothing owned no refs.
    expect(out.callSites.filter((site) => site.indirect).map((site) => site.file)).toEqual([
      'src/index.ts',
    ]);
  });

  it('records `new Class()` as a call reference', () => {
    const db = new DatabaseSync(path.join(indexDir, 'index.db'), { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT line FROM refs WHERE to_name = 'Store' AND call_type = 'call'")
        .all() as Array<{ line: number }>;
      expect(rows.map((r) => r.line)).toEqual([3]);
    } finally {
      db.close();
    }
  });

  it('rejects a missing ast-replace field as a validation error', async () => {
    await expect(
      codebaseAstReplaceTool.execute(
        { file: 'src/b.ts', symbol: 'unused' } as never,
        ctx(),
        {} as never,
      ),
    ).rejects.toThrow(expect.objectContaining({ message: expect.stringContaining('newBody') }));
    await expect(
      codebaseAstReplaceTool.execute(
        { file: 'src/b.ts', symbol: 'unused' } as never,
        ctx(),
        {} as never,
      ),
    ).rejects.toBeInstanceOf(ToolValidationError);
    await expect(
      codebaseAstReplaceTool.execute(
        { file: 'src/b.ts', symbol: 'unused', newBody: '', target: 'whole' } as never,
        ctx(),
        {} as never,
      ),
    ).rejects.toBeInstanceOf(ToolValidationError);
  });
});
