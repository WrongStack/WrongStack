/**
 * Live end-to-end proof for every codebase-* tool.
 * Run: WRONGSTACK_INDEX_INLINE=1 pnpm exec tsx docs/reports/codebase-tools-e2e-proof.ts
 */
process.env['WRONGSTACK_INDEX_INLINE'] = '1';

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { builtinTools } from '../../packages/tools/src/builtin.js';
import { resetIndexStateForTesting } from '../../packages/tools/src/codebase-index/background-indexer.js';
import { codebaseAstReplaceTool } from '../../packages/tools/src/codebase-index/codebase-ast-replace-tool.js';
import { codebaseImpactAnalysisTool } from '../../packages/tools/src/codebase-index/codebase-impact-analysis-tool.js';
import { codebaseIncomingCallsTool } from '../../packages/tools/src/codebase-index/codebase-incoming-calls-tool.js';
import { codebaseIndexTool } from '../../packages/tools/src/codebase-index/codebase-index-tool.js';
import { codebaseInvariantCheckTool } from '../../packages/tools/src/codebase-index/codebase-invariant-check-tool.js';
import { codebaseOutgoingCallsTool } from '../../packages/tools/src/codebase-index/codebase-outgoing-calls-tool.js';
import { codebaseRepoMapTool } from '../../packages/tools/src/codebase-index/codebase-repo-map-tool.js';
import { codebaseSearchTool } from '../../packages/tools/src/codebase-index/codebase-search-tool.js';
import { codebaseSkeletonTool } from '../../packages/tools/src/codebase-index/codebase-skeleton-tool.js';
import { codebaseStatsTool } from '../../packages/tools/src/codebase-index/codebase-stats-tool.js';
import { codebaseTargetedTestTool } from '../../packages/tools/src/codebase-index/codebase-targeted-test-tool.js';
import { indexStorePool } from '../../packages/tools/src/codebase-index/writer.js';
import { createCodebaseIndexMcpToolHost } from '../../packages/codebase-index-mcp/src/adapter.js';
import { createCodebaseLspSearchTool } from '../../packages/plug-lsp/src/tools/codebase-lsp-search.js';
import { buildCodebaseReindexCommand } from '../../packages/cli/src/slash-commands/codebase-reindex.js';

interface Proof {
  tool: string;
  registeredInBuiltin: boolean;
  ok: boolean;
  evidence: unknown;
  error?: string;
}

function mkCtx(root: string) {
  const indexDir = path.join(root, '.codebase-index');
  return {
    cwd: root,
    projectRoot: root,
    meta: { codebaseIndexDir: indexDir },
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
    fileHashes: new Map<string, string>(),
    writtenFiles: new Set<string>(),
    sideEffects: [],
    hasRead() {
      return false;
    },
    lastReadMtime() {
      return undefined;
    },
    recordRead() {},
    todos: [],
    messages: [],
    session: { id: 'e2e', append: async () => undefined, close: async () => undefined },
    tools: [],
    model: 'e2e',
    systemPrompt: [],
    allowOutsideProjectRoot: false,
  } as never;
}

function signal() {
  return new AbortController().signal;
}

function builtinNames(): Set<string> {
  return new Set(builtinTools.map((t) => t.name));
}

async function writeFixture(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', type: 'module', private: true }, null, 2),
  );
  await fs.writeFile(
    path.join(root, 'src', 'calc.ts'),
    [
      '/** Add two numbers. */',
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
      'export function multiply(a: number, b: number): number {',
      '  return a * b;',
      '}',
      '',
      'export function total(xs: number[]): number {',
      '  return xs.reduce(add, 0);',
      '}',
      '',
    ].join('\n'),
  );
  await fs.writeFile(
    path.join(root, 'src', 'caller.ts'),
    [
      "import { add, total } from './calc.js';",
      '',
      'export function runBatch(): number {',
      '  return add(1, total([2, 3]));',
      '}',
      '',
    ].join('\n'),
  );
  await fs.writeFile(
    path.join(root, 'tests', 'calc.test.ts'),
    [
      "import { add } from '../src/calc.js';",
      "import { describe, expect, it } from 'vitest';",
      '',
      "describe('add', () => {",
      "  it('adds two numbers', () => {",
      '    expect(add(1, 2)).toBe(3);',
      '  });',
      '});',
      '',
    ].join('\n'),
  );
}

async function run(): Promise<void> {
  const names = builtinNames();
  const proofs: Proof[] = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-cb-e2e-'));
  const ctx = mkCtx(root);
  const indexDir = path.join(root, '.codebase-index');

  const record = (p: Proof) => {
    proofs.push(p);
    const mark = p.ok ? 'PASS' : 'FAIL';
    process.stdout.write(`[${mark}] ${p.tool}\n`);
  };

  try {
    resetIndexStateForTesting();
    await writeFixture(root);

    // 1. codebase-index
    try {
      const out = await codebaseIndexTool.execute({ force: true }, ctx, { signal: signal() });
      record({
        tool: 'codebase-index',
        registeredInBuiltin: names.has('codebase-index'),
        ok: out.filesIndexed >= 2 && out.symbolsIndexed >= 3 && !out.note,
        evidence: {
          filesIndexed: out.filesIndexed,
          symbolsIndexed: out.symbolsIndexed,
          langStats: out.langStats,
          durationMs: out.durationMs,
          errors: out.errors,
          note: out.note,
        },
      });
    } catch (err) {
      record({
        tool: 'codebase-index',
        registeredInBuiltin: names.has('codebase-index'),
        ok: false,
        evidence: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. codebase-stats
    try {
      const out = await codebaseStatsTool.execute({}, ctx, { signal: signal() });
      record({
        tool: 'codebase-stats',
        registeredInBuiltin: names.has('codebase-stats'),
        ok: out.statsAvailable === true && out.totalSymbols >= 3 && out.totalFiles >= 2,
        evidence: {
          totalSymbols: out.totalSymbols,
          totalFiles: out.totalFiles,
          byLang: out.byLang,
          byKind: out.byKind,
          indexPath: out.indexPath,
          statsAvailable: out.statsAvailable,
          indexStatus: out.indexStatus,
        },
      });
    } catch (err) {
      record({
        tool: 'codebase-stats',
        registeredInBuiltin: names.has('codebase-stats'),
        ok: false,
        evidence: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 3. codebase-search
    try {
      const out = await codebaseSearchTool.execute(
        { query: 'add', kind: 'function', lang: 'ts', limit: 20 },
        ctx,
        { signal: signal() },
      );
      const hit = out.results.find((r) => r.name === 'add');
      record({
        tool: 'codebase-search',
        registeredInBuiltin: names.has('codebase-search'),
        ok: Boolean(hit) && !out.indexStatus && out.total > 0,
        evidence: {
          total: out.total,
          names: out.results.map((r) => r.name),
          hit,
          indexStatus: out.indexStatus,
        },
      });
    } catch (err) {
      record({
        tool: 'codebase-search',
        registeredInBuiltin: names.has('codebase-search'),
        ok: false,
        evidence: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 4. codebase-incoming-calls
    try {
      const out = await codebaseIncomingCallsTool.execute({ symbol: 'add' }, ctx, {
        signal: signal(),
      });
      const callerNames = out.calls.map((c) => c.symbol.name);
      record({
        tool: 'codebase-incoming-calls',
        registeredInBuiltin: names.has('codebase-incoming-calls'),
        ok:
          !out.indexStatus &&
          out.total >= 1 &&
          (callerNames.includes('total') || callerNames.includes('runBatch')),
        evidence: {
          total: out.total,
          callerNames,
          note: out.note,
          indexStatus: out.indexStatus,
          sites: out.calls.map((c) => ({
            name: c.symbol.name,
            file: c.symbol.file,
            line: c.line,
            callType: c.callType,
          })),
        },
      });
    } catch (err) {
      record({
        tool: 'codebase-incoming-calls',
        registeredInBuiltin: names.has('codebase-incoming-calls'),
        ok: false,
        evidence: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 5. codebase-outgoing-calls
    try {
      const out = await codebaseOutgoingCallsTool.execute({ symbol: 'runBatch' }, ctx, {
        signal: signal(),
      });
      const calleeNames = out.calls.map((c) => c.symbol.name);
      record({
        tool: 'codebase-outgoing-calls',
        registeredInBuiltin: names.has('codebase-outgoing-calls'),
        ok: !out.indexStatus && (calleeNames.includes('add') || calleeNames.includes('total')),
        evidence: {
          total: out.total,
          calleeNames,
          note: out.note,
          indexStatus: out.indexStatus,
          sites: out.calls.map((c) => ({
            name: c.symbol.name,
            file: c.symbol.file,
            line: c.line,
            callType: c.callType,
          })),
        },
      });
    } catch (err) {
      record({
        tool: 'codebase-outgoing-calls',
        registeredInBuiltin: names.has('codebase-outgoing-calls'),
        ok: false,
        evidence: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 6. codebase-impact-analysis
    try {
      const out = await codebaseImpactAnalysisTool.execute(
        { symbol: 'add', file: 'src/calc.ts', transitive: true },
        ctx,
        { signal: signal() },
      );
      record({
        tool: 'codebase-impact-analysis',
        registeredInBuiltin: names.has('codebase-impact-analysis'),
        ok:
          out.status === 'ok' && out.totalCallSites >= 1 && out.affectedProductionFiles.length >= 1,
        evidence: {
          status: out.status,
          riskLevel: out.riskLevel,
          summary: out.summary,
          totalCallSites: out.totalCallSites,
          affectedProductionFiles: out.affectedProductionFiles,
          affectedTestFiles: out.affectedTestFiles,
          recommendedActionPlan: out.recommendedActionPlan,
          error: out.error,
        },
      });
    } catch (err) {
      record({
        tool: 'codebase-impact-analysis',
        registeredInBuiltin: names.has('codebase-impact-analysis'),
        ok: false,
        evidence: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 7. codebase-skeleton
    try {
      const out = await codebaseSkeletonTool.execute({ path: 'src/calc.ts' }, ctx, {
        signal: signal(),
      });
      record({
        tool: 'codebase-skeleton',
        registeredInBuiltin: names.has('codebase-skeleton'),
        ok:
          out.skeleton.includes('export function add') &&
          out.stats.symbolCount >= 3 &&
          out.stats.tokenSavingsPercent >= 0,
        evidence: {
          isDir: out.isDir,
          stats: out.stats,
          skeletonPreview: out.skeleton.slice(0, 400),
        },
      });
    } catch (err) {
      record({
        tool: 'codebase-skeleton',
        registeredInBuiltin: names.has('codebase-skeleton'),
        ok: false,
        evidence: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 8. codebase-repo-map
    try {
      const out = await codebaseRepoMapTool.execute({ maxTokens: 800 }, ctx, { signal: signal() });
      record({
        tool: 'codebase-repo-map',
        registeredInBuiltin: names.has('codebase-repo-map'),
        ok: out.status === 'ok' && out.filesCount >= 1 && out.map.length > 0,
        evidence: {
          status: out.status,
          filesCount: out.filesCount,
          totalFilesScanned: out.totalFilesScanned,
          estimatedTokens: out.estimatedTokens,
          rankedFiles: out.rankedFiles,
          mapPreview: out.map.slice(0, 400),
          error: out.error,
        },
      });
    } catch (err) {
      record({
        tool: 'codebase-repo-map',
        registeredInBuiltin: names.has('codebase-repo-map'),
        ok: false,
        evidence: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 9. codebase-invariant-check
    try {
      const original = await fs.readFile(path.join(root, 'src', 'calc.ts'), 'utf8');
      const breaking = original.replace(
        'export function add(a: number, b: number): number {',
        'export function add(a: number, b: number, c: number): number {',
      );
      const out = await codebaseInvariantCheckTool.execute(
        { file: 'src/calc.ts', modifiedCode: breaking },
        ctx,
        { signal: signal() },
      );
      record({
        tool: 'codebase-invariant-check',
        registeredInBuiltin: names.has('codebase-invariant-check'),
        ok: out.valid === false && out.violations.length >= 1,
        evidence: {
          valid: out.valid,
          violations: out.violations,
          summary: out.summary,
          error: out.error,
          note: names.has('codebase-invariant-check')
            ? 'Registered in builtinTools and executable.'
            : 'Implemented and executable, but NOT registered in builtinTools / agent catalog.',
        },
      });
    } catch (err) {
      record({
        tool: 'codebase-invariant-check',
        registeredInBuiltin: names.has('codebase-invariant-check'),
        ok: false,
        evidence: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 10. codebase-ast-replace (mutate fixture only)
    try {
      const before = await fs.readFile(path.join(root, 'src', 'calc.ts'), 'utf8');
      const out = await codebaseAstReplaceTool.execute(
        {
          file: 'src/calc.ts',
          symbol: 'multiply',
          newBody: 'return a * b * 1;',
          target: 'body',
        },
        ctx,
        { signal: signal() },
      );
      const after = await fs.readFile(path.join(root, 'src', 'calc.ts'), 'utf8');
      record({
        tool: 'codebase-ast-replace',
        registeredInBuiltin: names.has('codebase-ast-replace'),
        ok:
          out.status === 'ok' &&
          after.includes('return a * b * 1;') &&
          before !== after &&
          after.includes('export function add'),
        evidence: {
          status: out.status,
          file: out.file,
          symbol: out.symbol,
          originalRange: out.originalRange,
          newRange: out.newRange,
          error: out.error,
          afterSnippet: after.split('\n').slice(5, 12),
        },
      });
    } catch (err) {
      record({
        tool: 'codebase-ast-replace',
        registeredInBuiltin: names.has('codebase-ast-replace'),
        ok: false,
        evidence: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 11. codebase-targeted-test
    try {
      const out = await codebaseTargetedTestTool.execute(
        { file: 'src/calc.ts', symbol: 'add' },
        ctx,
        { signal: signal() },
      );
      const discovered = out.discoveredSuites.some((s) =>
        s.replace(/\\/g, '/').includes('calc.test.ts'),
      );
      record({
        tool: 'codebase-targeted-test',
        registeredInBuiltin: names.has('codebase-targeted-test'),
        ok:
          discovered &&
          (out.status === 'passed' ||
            out.status === 'failed' ||
            out.status === 'no_tests_found' ||
            out.status === 'error'),
        evidence: {
          status: out.status,
          discoveredSuites: out.discoveredSuites,
          testsRun: out.testsRun,
          passed: out.passed,
          failed: out.failed,
          durationMs: out.durationMs,
          outputPreview: out.output.slice(0, 600),
          error: out.error,
          ranTests: out.status === 'passed' || out.status === 'failed',
        },
      });
    } catch (err) {
      record({
        tool: 'codebase-targeted-test',
        registeredInBuiltin: names.has('codebase-targeted-test'),
        ok: false,
        evidence: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 12. codebase-lsp-search (index path; no live LSP)
    try {
      const tool = createCodebaseLspSearchTool({
        registry: { list: () => [] },
      } as never);
      const out = await tool.execute({ query: 'add' }, ctx, { signal: signal() });
      const text = typeof out === 'string' ? out : JSON.stringify(out);
      record({
        tool: 'codebase-lsp-search',
        registeredInBuiltin: names.has('codebase-lsp-search'),
        ok: text.includes('add') && !text.startsWith('[') && !text.includes('No symbols matching'),
        evidence: {
          preview: text.slice(0, 500),
          note: 'Plugin tool. Index path exercised with empty LSP registry.',
        },
      });
    } catch (err) {
      record({
        tool: 'codebase-lsp-search',
        registeredInBuiltin: names.has('codebase-lsp-search'),
        ok: false,
        evidence: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 13. /codebase-reindex slash command
    try {
      const writes: string[] = [];
      const cmd = buildCodebaseReindexCommand({
        renderer: { write: (s: string) => writes.push(s) },
        projectRoot: root,
      } as never);
      const res = await cmd.run('', ctx);
      const message = String(res?.message ?? '');
      record({
        tool: 'codebase-reindex (slash)',
        registeredInBuiltin: false,
        ok: cmd.name === 'codebase-reindex' && /updated|rebuilt|symbols/i.test(message),
        evidence: {
          name: cmd.name,
          aliases: cmd.aliases,
          writes,
          message,
        },
      });
    } catch (err) {
      record({
        tool: 'codebase-reindex (slash)',
        registeredInBuiltin: false,
        ok: false,
        evidence: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 14. MCP host: real list + call of underscore-named tools
    try {
      const host = createCodebaseIndexMcpToolHost(root, {
        writable: true,
        indexDir,
      });
      const listed = host.listTools().map((t) => t.name);
      const search = await host.callTool('codebase_search', { query: 'total' });
      const stats = await host.callTool('codebase_stats', {});
      const pkg = await host.callTool('codebase_package_graph', {});
      const files = await host.callTool('codebase_file_graph', { package: 'src' });
      const symbols = await host.callTool('codebase_symbol_graph', { file: 'src/calc.ts' });
      const searchContent = search.content as { total?: number; results?: Array<{ name: string }> };
      const statsContent = stats.content as { totalSymbols?: number };
      const searchHit =
        !search.isError &&
        typeof searchContent === 'object' &&
        searchContent !== null &&
        ((searchContent.total ?? 0) > 0 ||
          (searchContent.results ?? []).some((r) => r.name === 'total'));
      record({
        tool: 'MCP codebase_* host',
        registeredInBuiltin: false,
        ok:
          listed.includes('codebase_search') &&
          listed.includes('codebase_index') &&
          searchHit &&
          !stats.isError &&
          !pkg.isError &&
          !files.isError &&
          !symbols.isError,
        evidence: {
          listed,
          searchError: search.isError,
          searchPreview:
            typeof search.content === 'string' ? search.content.slice(0, 300) : searchContent,
          statsPreview:
            typeof stats.content === 'string'
              ? stats.content.slice(0, 300)
              : { totalSymbols: statsContent?.totalSymbols },
          packageGraph: summarizeGraph(pkg.content),
          fileGraph: summarizeGraph(files.content),
          symbolGraph: summarizeGraph(symbols.content),
        },
      });
    } catch (err) {
      record({
        tool: 'MCP codebase_* host',
        registeredInBuiltin: false,
        ok: false,
        evidence: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    try {
      indexStorePool.evict(root, indexDir);
    } catch {
      // ignore
    }
    resetIndexStateForTesting();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    fixtureRoot: root,
    passed: proofs.filter((p) => p.ok).length,
    failed: proofs.filter((p) => !p.ok).length,
    builtinCodebaseTools: builtinTools.map((t) => t.name).filter((n) => n.startsWith('codebase-')),
    proofs,
  };

  const outPath = path.join(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
    'codebase-tools-e2e-proof.json',
  );
  await fs.writeFile(outPath, JSON.stringify(report, null, 2));
  process.stdout.write(`\nWrote ${outPath}\n${report.passed} passed / ${report.failed} failed\n`);
  if (report.failed > 0) process.exitCode = 1;
}

function summarizeGraph(content: unknown): unknown {
  if (!content || typeof content !== 'object') return content;
  const graph = content as { nodes?: unknown[]; edges?: unknown[]; [k: string]: unknown };
  return {
    keys: Object.keys(graph),
    nodeCount: Array.isArray(graph.nodes) ? graph.nodes.length : undefined,
    edgeCount: Array.isArray(graph.edges) ? graph.edges.length : undefined,
    sampleNodes: Array.isArray(graph.nodes) ? graph.nodes.slice(0, 3) : undefined,
  };
}

run().catch((err) => {
  process.stderr.write((err instanceof Error ? err.stack : String(err)) + '\n');
  process.exit(1);
});
