/**
 * `codebase-flow-trace` tool — Entry-Point Discovery & Forward Execution Flow
 * Slicer (`Domain -> ExecutionFlow -> FlowStep[]`).
 *
 * Automatically discovers architectural entry points (HTTP handlers, CLI commands,
 * tool executors, main/server bootstraps, root orchestrators) or starts from a
 * caller-supplied `symbol`, then slices the forward outgoing call graph into
 * ordered, human-readable execution flows.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import { ensureAtlasDir, writeAtlasFile } from './atlas-projection.js';
import { isTestFilePath } from './codebase-impact-analysis-tool.js';
import {
  codebaseIndexDirOverride,
  type IndexStore,
  indexStorePool,
  resolveIndexDir,
} from './writer.js';
import { posixIndexPath } from './writer-helpers.js';

export type EntryPointKind =
  | 'http'
  | 'cli'
  | 'tool'
  | 'handler'
  | 'worker'
  | 'main'
  | 'orchestrator';

export interface DiscoveredEntryPoint {
  symbol: string;
  kind: string;
  entryKind: EntryPointKind;
  domain: string;
  file: string;
  line: number;
  score: number;
}

export interface ExecutionFlowStep {
  step: number;
  depth: number;
  symbol: string;
  kind: string;
  file: string;
  line: number;
  signature: string;
  calledFrom?: string | undefined;
  fileSummary?: string | undefined;
}

export interface ExecutionFlow {
  id: string;
  title: string;
  domain: string;
  entryKind: EntryPointKind;
  entrySymbol: string;
  entryFile: string;
  entryLine: number;
  steps: ExecutionFlowStep[];
}

export interface CodebaseFlowTraceInput {
  /** Optional starting symbol name. When omitted, auto-discovers top project entry points. */
  symbol?: string | undefined;
  /** Optional file filter to disambiguate `symbol` or scope entry-point discovery. */
  file?: string | undefined;
  /** Maximum call depth to trace from each entry point (1..10, default 4). */
  maxDepth?: number | undefined;
  /** Maximum number of execution flows to return (1..20, default 5). */
  maxFlows?: number | undefined;
  /** Maximum steps per execution flow (3..50, default 15). */
  maxSteps?: number | undefined;
  /** When true, persist the execution flows to `.wrongstack/atlas/{flows.json,FLOWS.md}`. */
  persist?: boolean | undefined;
}

export interface CodebaseFlowTraceOutput {
  status: 'ok';
  summary: string;
  entryPoints: DiscoveredEntryPoint[];
  flows: ExecutionFlow[];
  persistedPaths?: { jsonPath: string; markdownPath: string } | undefined;
}

export const ATLAS_FLOWS_JSON = '.wrongstack/atlas/flows.json';
export const ATLAS_FLOWS_MD = '.wrongstack/atlas/FLOWS.md';

const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']);
const MAIN_NAMES = new Set([
  'main',
  'bootstrap',
  'startServer',
  'createServer',
  'runServer',
  'runCli',
  'cli',
  'run',
  'execute',
]);

function classifyEntryPoint(
  sym: { name: string; kind: string; file: string; line: number },
  relFile: string,
): { entryKind: EntryPointKind; bonus: number } | null {
  if (isTestFilePath(relFile)) return null;
  if (
    sym.kind === 'type' ||
    sym.kind === 'interface' ||
    sym.kind === 'enum' ||
    sym.kind === 'property'
  ) {
    return null;
  }

  const lowerFile = relFile.toLowerCase();
  const name = sym.name;

  if (
    HTTP_VERBS.has(name) ||
    name === 'ServeHTTP' ||
    name === 'middleware' ||
    /(?:^|\/)(?:route|routes|router|controller|api|page|layout|middleware)\.[a-z]+$/i.test(
      lowerFile,
    )
  ) {
    return { entryKind: 'http', bonus: 30 };
  }
  if (name.endsWith('Tool') || lowerFile.endsWith('-tool.ts') || lowerFile.endsWith('-tool.js')) {
    return { entryKind: 'tool', bonus: 25 };
  }
  if (
    /(?:Consumer|Worker|Processor|Cron|Job)$/.test(name) ||
    /^(?:consume|processQueue|runJob|schedule)[A-Z_]/.test(name) ||
    /(?:^|\/)(?:worker|consumer|cron|queue)\.[a-z]+$/i.test(lowerFile)
  ) {
    return { entryKind: 'worker', bonus: 24 };
  }
  if (MAIN_NAMES.has(name) || /(?:^|\/)(?:main|cli|bin|server|app)\.[a-z]+$/i.test(lowerFile)) {
    return {
      entryKind: lowerFile.includes('cli') || lowerFile.includes('bin') ? 'cli' : 'main',
      bonus: 28,
    };
  }
  if (
    /^handle[A-Z_]/.test(name) ||
    /Handler$/.test(name) ||
    /Controller$/.test(name) ||
    /^on[A-Z]/.test(name)
  ) {
    return { entryKind: 'handler', bonus: 20 };
  }
  return null;
}

function domainOfFile(packageLabel: string | undefined, relFile: string): string {
  if (packageLabel && packageLabel.trim().length > 0) return packageLabel;
  const parts = relFile.split('/').filter(Boolean);
  if (parts[0] === 'packages' && parts[1]) return parts[1];
  if (parts[0] === 'src' && parts.length > 2 && parts[1]) return `src/${parts[1]}`;
  return parts[0] ?? 'root';
}

/**
 * Discover architectural entry points in an indexed project.
 */
export function discoverEntryPoints(
  store: IndexStore,
  projectRoot: string,
  options: { fileFilter?: string | undefined; limit?: number | undefined } = {},
): DiscoveredEntryPoint[] {
  const limit = options.limit ?? 10;
  const fileFilter = options.fileFilter ? posixIndexPath(options.fileFilter.trim()) : undefined;
  const packages = store.getFilePackages();
  const fileRanks = store.getFileRankMap();

  // Out-degree and in-degree per symbol id from resolved refs
  const outDeg = new Map<number, number>();
  const inDeg = new Map<number, number>();
  for (const ref of store.getAllResolvedRefs()) {
    if (ref.callType === 'call') {
      outDeg.set(ref.fromId, (outDeg.get(ref.fromId) ?? 0) + 1);
      inDeg.set(ref.toId, (inDeg.get(ref.toId) ?? 0) + 1);
    }
  }

  const candidates: DiscoveredEntryPoint[] = [];
  for (const sym of store.getAllSymbols()) {
    const relFile = posixIndexPath(path.relative(projectRoot, sym.file));
    if (relFile.startsWith('..')) continue;
    if (fileFilter && !relFile.includes(fileFilter)) continue;
    if (isTestFilePath(relFile)) continue;

    const out = outDeg.get(sym.id) ?? 0;
    const inn = inDeg.get(sym.id) ?? 0;
    const classified = classifyEntryPoint(sym, relFile);

    if (!classified && (out < 2 || inn > 1)) continue;
    if (sym.kind !== 'function' && sym.kind !== 'method' && sym.kind !== 'class' && !classified) {
      continue;
    }

    const entryKind: EntryPointKind = classified ? classified.entryKind : 'orchestrator';
    const bonus = classified ? classified.bonus : 10;
    const fileRank = fileRanks.get(sym.file) ?? 0;
    const score = Number((bonus + out * 4 - inn * 1.5 + fileRank * 10).toFixed(2));
    if (score <= 0) continue;

    candidates.push({
      symbol: sym.name,
      kind: sym.kind,
      entryKind,
      domain: domainOfFile(packages.get(sym.file), relFile),
      file: relFile,
      line: sym.line,
      score,
    });
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line,
  );

  // Deduplicate by symbol+file
  const unique: DiscoveredEntryPoint[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = `${c.file}::${c.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
    if (unique.length >= limit) break;
  }
  return unique;
}

/**
 * Trace a forward execution flow starting from `entry` using BFS over outgoing
 * calls in `store`.
 */
export function sliceExecutionFlow(
  store: IndexStore,
  projectRoot: string,
  entry: DiscoveredEntryPoint,
  options: { maxDepth?: number | undefined; maxSteps?: number | undefined } = {},
): ExecutionFlow {
  const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 4, 10));
  const maxSteps = Math.max(2, Math.min(options.maxSteps ?? 15, 50));
  const summaries = store.getReadyConceptSummaries();

  const absEntryFile = path.resolve(projectRoot, entry.file);
  const entrySymbols = store.getFileSymbols(absEntryFile, 200);
  const matchedEntry = entrySymbols.find((s) => s.name === entry.symbol);

  const steps: ExecutionFlowStep[] = [];
  const visited = new Set<string>();

  const rootKey = `${entry.file}::${entry.symbol}`;
  visited.add(rootKey);

  const rootSummary = summaries.get(absEntryFile);
  steps.push({
    step: 1,
    depth: 0,
    symbol: entry.symbol,
    kind: entry.kind,
    file: entry.file,
    line: entry.line,
    signature: matchedEntry?.signature ?? `${entry.kind} ${entry.symbol}`,
    ...(rootSummary ? { fileSummary: rootSummary } : {}),
  });

  const queue: Array<{ symbol: string; file: string; depth: number }> = [
    { symbol: entry.symbol, file: entry.file, depth: 0 },
  ];

  while (queue.length > 0 && steps.length < maxSteps) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    const outgoing = store.findOutgoingCallsByName(current.symbol, current.file, 30);
    // Execution flows trace runtime call edges across executable symbols
    const orderedCalls = outgoing.calls
      .filter(
        (c) =>
          c.callType === 'call' &&
          c.symbol.kind !== 'interface' &&
          c.symbol.kind !== 'type' &&
          c.symbol.kind !== 'enum' &&
          c.symbol.kind !== 'property',
      )
      .sort((a, b) => a.line - b.line);

    for (const call of orderedCalls) {
      if (steps.length >= maxSteps) break;
      const callee = call.symbol;
      const relCalleeFile = posixIndexPath(path.relative(projectRoot, callee.file));
      if (relCalleeFile.startsWith('..') || isTestFilePath(relCalleeFile)) continue;

      const key = `${relCalleeFile}::${callee.name}`;
      if (visited.has(key)) continue;
      visited.add(key);

      const nextDepth = current.depth + 1;
      const fileSummary = summaries.get(callee.file);
      steps.push({
        step: steps.length + 1,
        depth: nextDepth,
        symbol: callee.name,
        kind: callee.kind,
        file: relCalleeFile,
        line: callee.line,
        signature: callee.signature || `${callee.kind} ${callee.name}`,
        calledFrom: current.symbol,
        ...(fileSummary ? { fileSummary } : {}),
      });

      if (nextDepth < maxDepth) {
        queue.push({
          symbol: callee.name,
          file: relCalleeFile,
          depth: nextDepth,
        });
      }
    }
  }

  return {
    id: `flow:${entry.domain}:${entry.symbol}`,
    title: `${entry.domain} / ${entry.symbol} (${entry.entryKind})`,
    domain: entry.domain,
    entryKind: entry.entryKind,
    entrySymbol: entry.symbol,
    entryFile: entry.file,
    entryLine: entry.line,
    steps,
  };
}

/**
 * Render a human-readable Markdown document describing the project's discovered
 * execution flows (`Domain -> Flow -> Step`).
 */
export function renderExecutionFlowsMarkdown(output: CodebaseFlowTraceOutput): string {
  const lines: string[] = [
    '# Codebase Execution Flows & Domain Processes',
    '',
    `> ${output.summary}`,
    '',
  ];
  for (const flow of output.flows) {
    lines.push(`## ${flow.title}`);
    lines.push(
      `- **Entry Point:** \`${flow.entrySymbol}\` (\`${flow.entryFile}:${flow.entryLine}\`)`,
    );
    lines.push(`- **Domain:** \`${flow.domain}\` · **Kind:** \`${flow.entryKind}\``);
    lines.push('');
    for (const s of flow.steps) {
      const indent = '  '.repeat(Math.max(0, s.depth));
      const via = s.calledFrom ? ` *(called from \`${s.calledFrom}\`)*` : '';
      lines.push(
        `${indent}${s.step}. **\`${s.symbol}\`** (\`${s.file}:${s.line}\`)${via} — \`${s.signature}\``,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Persist execution flows to `.wrongstack/atlas/flows.json` and `.wrongstack/atlas/FLOWS.md`.
 */
export async function writeExecutionFlowsAtlas(
  projectRoot: string,
  output: CodebaseFlowTraceOutput,
): Promise<{ jsonPath: string; markdownPath: string; markdown: string }> {
  const markdown = renderExecutionFlowsMarkdown(output);
  const dir = await ensureAtlasDir(projectRoot);
  await writeAtlasFile(
    dir,
    path.basename(ATLAS_FLOWS_JSON),
    `${JSON.stringify(output, null, 2)}\n`,
  );
  await writeAtlasFile(dir, path.basename(ATLAS_FLOWS_MD), markdown);
  return {
    jsonPath: ATLAS_FLOWS_JSON,
    markdownPath: ATLAS_FLOWS_MD,
    markdown,
  };
}

export const codebaseFlowTraceTool: Tool<CodebaseFlowTraceInput, CodebaseFlowTraceOutput> = {
  name: 'codebase-flow-trace',
  category: 'Project',
  icon: 'index',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  timeoutMs: 35_000,
  description:
    'Discover architectural entry points (HTTP routes, CLI commands, tools, handlers, main orchestrators) ' +
    'and trace their forward execution flows (`Domain -> Flow -> Step`) across the call graph.',
  usageHint:
    'USE TO UNDERSTAND END-TO-END EXECUTION PATHS:\n\n' +
    '- Call `codebase-flow-trace({})` to auto-discover top entry points and trace their execution flows.\n' +
    '- Pass `symbol: "handleLogin"` (and optional `file`) to trace a specific feature flow step-by-step.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description:
          'Optional symbol name to start the execution flow trace from. Omit to auto-discover project entry points.',
      },
      file: {
        type: 'string',
        description: 'Optional file path filter to disambiguate `symbol` or scope discovery.',
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum call depth to trace forward (1..10, default 4).',
      },
      maxFlows: {
        type: 'number',
        description: 'Maximum number of execution flows to return (1..20, default 5).',
      },
      maxSteps: {
        type: 'number',
        description: 'Maximum steps per execution flow (3..50, default 15).',
      },
      persist: {
        type: 'boolean',
        description:
          'When true, persist `.wrongstack/atlas/flows.json` and `.wrongstack/atlas/FLOWS.md`.',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const projectRoot = ctx.projectRoot ?? ctx.cwd ?? process.cwd();
    const indexDir = codebaseIndexDirOverride(ctx);
    const maxDepth = input?.maxDepth ?? 4;
    const maxFlows = Math.max(1, Math.min(input?.maxFlows ?? 5, 20));
    const maxSteps = input?.maxSteps ?? 15;

    const indexDbPath = path.join(resolveIndexDir(projectRoot, indexDir), 'index.db');
    if (!existsSync(indexDbPath)) {
      throw new Error(
        'No persisted index data found. Run codebase-index to build it, then retry codebase-flow-trace.',
      );
    }

    const store = indexStorePool.acquire(projectRoot, { indexDir });
    try {
      let entryPoints: DiscoveredEntryPoint[] = [];

      if (input?.symbol && input.symbol.trim().length > 0) {
        const targetName = input.symbol.trim();
        const matches = store.search(targetName, {
          ...(input.file ? { file: input.file } : {}),
        });
        const exact = matches.filter((m) => m.name === targetName);
        const chosen = exact.length > 0 ? exact : matches;
        const packages = store.getFilePackages();

        for (const m of chosen.slice(0, maxFlows)) {
          const relFile = posixIndexPath(path.relative(projectRoot, m.file));
          const classified = classifyEntryPoint(m, relFile);
          entryPoints.push({
            symbol: m.name,
            kind: m.kind,
            entryKind: classified?.entryKind ?? 'orchestrator',
            domain: domainOfFile(packages.get(m.file), relFile),
            file: relFile,
            line: m.line,
            score: Number(m.score.toFixed(2)),
          });
        }
      } else {
        entryPoints = discoverEntryPoints(store, projectRoot, {
          fileFilter: input?.file,
          limit: maxFlows,
        });
      }

      const flows = entryPoints.map((ep) =>
        sliceExecutionFlow(store, projectRoot, ep, { maxDepth, maxSteps }),
      );

      const totalSteps = flows.reduce((acc, f) => acc + f.steps.length, 0);
      const summary =
        flows.length === 0
          ? 'No matching entry points or execution flows found in the index.'
          : `Traced ${flows.length} execution flow(s) across ${totalSteps} total step(s) (maxDepth=${maxDepth}).`;

      const output: CodebaseFlowTraceOutput = {
        status: 'ok',
        summary,
        entryPoints,
        flows,
      };
      if (input?.persist === true) {
        const persisted = await writeExecutionFlowsAtlas(projectRoot, output);
        output.persistedPaths = {
          jsonPath: persisted.jsonPath,
          markdownPath: persisted.markdownPath,
        };
      }
      return output;
    } finally {
      indexStorePool.release(store);
    }
  },
};
