process.env['WRONGSTACK_INDEX_INLINE'] = '1';

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetIndexStateForTesting } from '../../packages/tools/src/codebase-index/background-indexer.js';
import { codebaseImpactAnalysisTool } from '../../packages/tools/src/codebase-index/codebase-impact-analysis-tool.js';
import { codebaseIncomingCallsTool } from '../../packages/tools/src/codebase-index/codebase-incoming-calls-tool.js';
import { codebaseIndexTool } from '../../packages/tools/src/codebase-index/codebase-index-tool.js';
import { indexStorePool } from '../../packages/tools/src/codebase-index/writer.js';
import { createCodebaseIndexMcpToolHost } from '../../packages/codebase-index-mcp/src/adapter.js';

function mkCtx(root: string) {
  return {
    cwd: root,
    projectRoot: root,
    meta: { codebaseIndexDir: path.join(root, '.codebase-index') },
    tools: [],
    model: 'e2e',
    systemPrompt: [],
    allowOutsideProjectRoot: false,
  } as never;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-cb-follow-'));
  const indexDir = path.join(root, '.codebase-index');
  const ctx = mkCtx(root);
  try {
    resetIndexStateForTesting();
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', type: 'module', private: true }),
    );
    await fs.writeFile(
      path.join(root, 'src', 'calc.ts'),
      'export function add(a: number, b: number): number { return a + b; }\n',
    );
    await fs.writeFile(
      path.join(root, 'src', 'caller.ts'),
      "import { add } from './calc.js';\nexport function runBatch(): number { return add(1, 2); }\n",
    );
    await codebaseIndexTool.execute({ force: true }, ctx, { signal: new AbortController().signal });

    const noFile = await codebaseImpactAnalysisTool.execute(
      { symbol: 'add', transitive: true },
      ctx,
      { signal: new AbortController().signal },
    );
    const relativeFile = await codebaseImpactAnalysisTool.execute(
      { symbol: 'add', file: 'src/calc.ts', transitive: true },
      ctx,
      { signal: new AbortController().signal },
    );
    const absFile = await codebaseImpactAnalysisTool.execute(
      { symbol: 'add', file: path.join(root, 'src', 'calc.ts'), transitive: true },
      ctx,
      { signal: new AbortController().signal },
    );
    const incomingRel = await codebaseIncomingCallsTool.execute(
      { symbol: 'add', file: 'src/calc.ts' },
      ctx,
      { signal: new AbortController().signal },
    );
    const incomingAbs = await codebaseIncomingCallsTool.execute(
      { symbol: 'add', file: path.join(root, 'src', 'calc.ts') },
      ctx,
      { signal: new AbortController().signal },
    );

    const host = createCodebaseIndexMcpToolHost(root, { writable: true, indexDir });
    const fileGraphWrong = await host.callTool('codebase_file_graph', { package: 'src' });
    const fileGraphRight = await host.callTool('codebase_file_graph', { package: 'fixture' });
    const symbolWrong = await host.callTool('codebase_symbol_graph', { file: 'src/calc.ts' });
    const symbolRight = await host.callTool('codebase_symbol_graph', {
      file: path.join(root, 'src', 'calc.ts'),
    });

    const report = {
      impactNoFile: {
        status: noFile.status,
        totalCallSites: noFile.totalCallSites,
        files: noFile.affectedProductionFiles,
        summary: noFile.summary,
      },
      impactRelativeFile: {
        status: relativeFile.status,
        totalCallSites: relativeFile.totalCallSites,
        summary: relativeFile.summary,
      },
      impactAbsoluteFile: {
        status: absFile.status,
        totalCallSites: absFile.totalCallSites,
        files: absFile.affectedProductionFiles,
        summary: absFile.summary,
      },
      incomingRelative: {
        total: incomingRel.total,
        note: incomingRel.note,
        indexStatus: incomingRel.indexStatus,
      },
      incomingAbsolute: { total: incomingAbs.total, note: incomingAbs.note },
      fileGraphPackageSrc: summarize(fileGraphWrong.content),
      fileGraphPackageFixture: summarize(fileGraphRight.content),
      symbolGraphRelative: summarize(symbolWrong.content),
      symbolGraphAbsolute: summarize(symbolRight.content),
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    await fs.writeFile(
      path.resolve('docs/reports/codebase-tools-e2e-followup.json'),
      JSON.stringify(report, null, 2),
    );
  } finally {
    indexStorePool.evict(root, indexDir);
    resetIndexStateForTesting();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

function summarize(content: unknown) {
  if (!content || typeof content !== 'object') return content;
  const g = content as { nodes?: unknown[]; edges?: unknown[] };
  return { nodeCount: g.nodes?.length, edgeCount: g.edges?.length, sample: g.nodes?.slice(0, 4) };
}

main().catch((err) => {
  process.stderr.write((err instanceof Error ? err.stack : String(err)) + '\n');
  process.exit(1);
});
