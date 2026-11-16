import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { codebaseFlowTraceTool, runIndexer } from '../src/codebase-index/index.js';
import { indexStorePool } from '../src/codebase-index/writer.js';

it('traces ordinary and dot-prefixed production callees while excluding test callees', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-test-boundary-'));
  const indexDir = path.join(root, '.idx');
  try {
    for (const directory of ['src', '..legal', 'tests']) {
      await fs.mkdir(path.join(root, directory));
    }
    await fs.writeFile(
      path.join(root, 'src/production.ts'),
      'export function production() { return 1; }',
    );
    await fs.writeFile(
      path.join(root, '..legal/helper.ts'),
      'export function dotHelper() { return 2; }',
    );
    await fs.writeFile(
      path.join(root, 'tests/helper.test.ts'),
      'export function testOnly() { return 3; }',
    );
    await fs.writeFile(
      path.join(root, 'src/main.ts'),
      [
        "import { production } from './production';",
        "import { dotHelper } from '../..legal/helper';",
        "import { testOnly } from '../tests/helper.test';",
        'export function main() { production(); dotHelper(); testOnly(); }',
      ].join('\n'),
    );
    await runIndexer(undefined as never, { projectRoot: root, indexDir });
    const result = await codebaseFlowTraceTool.execute(
      { symbol: 'main', file: 'src/main.ts', maxDepth: 3, persist: false },
      { cwd: root, projectRoot: root, meta: { codebaseIndexDir: indexDir } } as never,
      { signal: new AbortController().signal },
    );
    const flow = result.flows.find((item) => item.entryFile === 'src/main.ts');
    expect(flow).toBeDefined();
    const names = flow!.steps.map((step) => step.symbol);
    expect(names).toContain('production');
    expect(names).toContain('dotHelper');
    expect(names).not.toContain('testOnly');
  } finally {
    indexStorePool.evict(root, indexDir);
    await fs.rm(root, { recursive: true, force: true });
  }
});
