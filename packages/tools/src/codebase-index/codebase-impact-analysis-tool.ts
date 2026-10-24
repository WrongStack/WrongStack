/**
 * `codebase-impact-analysis` tool — calculate the blast radius and breaking change risk of modifying a symbol.
 *
 * Usage: codebase-impact-analysis({
 *   symbol: string,           // name of the function, method, class, or type to analyze
 *   file?: string,            // optional file path to disambiguate
 *   transitive?: boolean,     // traverse transitive callers (default: true)
 * })
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { codebaseIndexStats, getIndexState, incomingCallsService } from './background-indexer.js';
import {
  type AnchoredFileHealth,
  type AnchoredSageInsight,
  findAnchoredSageMemories,
  findFileHealthAlerts,
} from './ecosystem-bridge.js';
import type { CallSite } from './schema.js';
import { codebaseIndexDirOverride } from './writer.js';

export interface ImpactAnalysisInput {
  /** The symbol name (function, method, class, interface, type) to analyze. */
  symbol: string;
  /** Optional file path to disambiguate when multiple symbols share a name. */
  file?: string | undefined;
  /** Whether to traverse transitive callers (callers of callers). Defaults to true. */
  transitive?: boolean | undefined;
}

export type CodebaseImpactAnalysisInput = ImpactAnalysisInput;

export interface ImpactCallSite {
  file: string;
  line: number;
  callerName: string;
  callerKind: string;
  callType: string;
  isTest: boolean;
  /** A caller of a caller: reached through the transitive tree, not a direct use. */
  indirect?: boolean | undefined;
}

export interface ImpactAnalysisOutput {
  status: 'ok';
  symbol: string;
  riskLevel: 'low' | 'medium' | 'high';
  summary: string;
  totalCallSites: number;
  affectedProductionFiles: string[];
  affectedTestFiles: string[];
  callSites: ImpactCallSite[];
  recommendedActionPlan: string[];
  /** False when the symbol could not be resolved in the index. */
  symbolFound?: boolean;
  /** True when a previous generation's cached answer was served during a refresh. */
  stale?: boolean | undefined;
  /** Active SAGE memories anchored to this symbol or its affected files. */
  relatedMemories?: AnchoredSageInsight[] | undefined;
  /** WrongTrace file fragility / thrashing / lock alerts for affected files. */
  fileHealthAlerts?: AnchoredFileHealth[] | undefined;
}

export type CodebaseImpactAnalysisOutput = ImpactAnalysisOutput;

/**
 * Test-like path segment: `tests/`, `__tests__/`, `foo.test.ts`, `foo_test.go`,
 * `test_foo.py`, `fixtures/`, `mocks/`, `benchmarks/`. The marker must be
 * delimited on BOTH sides — the old unanchored pattern classified
 * `inspect.ts` (`spec.`), `latest/` (`test/`) and `aspect.ts` as tests, which
 * hid production callers from the blast radius.
 */
const TEST_FILE_REGEX =
  /(?:^|[/\\._-])(?:tests?|specs?|mocks?|fixtures?|bench(?:es|marks?)?)(?:[/\\._-]|$)/i;

/** Whether a project-relative path looks like a test, fixture, mock, or bench file. */
export function isTestFilePath(relPath: string): boolean {
  return TEST_FILE_REGEX.test(relPath);
}

/**
 * Discover companion test files by naming convention (`foo.test.ts`,
 * `foo.spec.ts`, `__tests__/foo.test.ts`, `tests/foo.test.ts`, `foo_test.go`,
 * `test_foo.py`) that exist on disk under `projectRoot`.
 */
export function discoverConventionTestFiles(
  projectRoot: string,
  prodRelFiles: readonly string[],
): string[] {
  const discovered = new Set<string>();
  for (const rel of prodRelFiles) {
    const norm = rel.replace(/\\/g, '/');
    if (!norm || isTestFilePath(norm)) continue;
    const ext = path.posix.extname(norm);
    if (!ext) continue;
    const dir = path.posix.dirname(norm);
    const stem = path.posix.basename(norm, ext);
    const candidates = [
      path.posix.join(dir, `${stem}.test${ext}`),
      path.posix.join(dir, `${stem}.spec${ext}`),
      path.posix.join(dir, '__tests__', `${stem}.test${ext}`),
      path.posix.join(dir, '__tests__', `${stem}.spec${ext}`),
      path.posix.join('tests', `${stem}.test${ext}`),
      path.posix.join('tests', `${stem}.spec${ext}`),
      path.posix.join('test', `${stem}.test${ext}`),
      ...(ext === '.go' ? [path.posix.join(dir, `${stem}_test.go`)] : []),
      ...(ext === '.py'
        ? [
            path.posix.join(dir, `test_${stem}.py`),
            path.posix.join(dir, `${stem}_test.py`),
            path.posix.join('tests', `test_${stem}.py`),
          ]
        : []),
    ];
    for (const candidate of candidates) {
      const clean = candidate.replace(/^\.\//, '');
      if (existsSync(path.resolve(projectRoot, clean))) {
        discovered.add(clean);
      }
    }
  }
  return [...discovered];
}

export const codebaseImpactAnalysisTool: Tool<ImpactAnalysisInput, ImpactAnalysisOutput> = {
  name: 'codebase-impact-analysis',
  category: 'Project',
  icon: 'index',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  // The index host has its own 30s read watchdog; leave headroom so its
  // structured timeout reaches the agent instead of a generic TOOL_TIMEOUT.
  timeoutMs: 35_000,
  description:
    'Perform a blast radius and impact analysis before modifying or refactoring a function, class, or type. ' +
    'Identifies all production call sites, affected test suites, and breaking change risks across the entire codebase.',
  usageHint:
    'CALL BEFORE MODIFYING FUNCTION SIGNATURES, PARAMETERS, OR RETURN TYPES:\n\n' +
    '- Pass `symbol: "calculateDiscount"` to get the complete blast radius.\n' +
    '- Groups affected code into production callers vs. test files.\n' +
    '- Provides a step-by-step action plan of every file and line that must be updated alongside the change.\n' +
    '- Pair with `codebase-targeted-test` to verify affected test suites afterwards.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'The function/method/class/type name to analyze.',
      },
      file: {
        type: 'string',
        description:
          'Optional file path to disambiguate when multiple symbols share the same name.',
      },
      transitive: {
        type: 'boolean',
        description:
          'Whether to traverse transitive callers (callers of callers). Defaults to true.',
      },
    },
    required: ['symbol'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const projectRoot = ctx.projectRoot ?? ctx.cwd ?? process.cwd();
    const indexDir = codebaseIndexDirOverride(ctx);
    const limit = 200;
    const transitive = input.transitive ?? true;

    if (!input?.symbol || typeof input.symbol !== 'string' || !input.symbol.trim()) {
      throw new ToolValidationError({
        message: 'codebase-impact-analysis: symbol is required and cannot be empty',
        field: 'symbol',
      });
    }

    const state = getIndexState();
    if (state.lastError) {
      const circuit = state.circuit;
      const retryHint =
        circuit.state === 'open'
          ? `Indexing is paused (circuit open, retry in ${Math.ceil(circuit.cooldownRemainingMs / 1000)}s).`
          : 'Try /codebase-reindex.';
      throw new Error(`Index build failed: ${state.lastError}. ${retryHint}`);
    }

    // An index outage is an operational failure, NOT "symbol not found": it
    // THROWS so the caller retries after rebuilding the index instead of
    // concluding the symbol has no callers — the most dangerous wrong answer
    // before a refactor. A returned `status: 'error'` payload was a
    // SUCCESSFUL call to the executor (the UI showed "ok").
    let serviced: Awaited<ReturnType<typeof incomingCallsService>>;
    try {
      serviced = await incomingCallsService({
        projectRoot,
        indexDir,
        symbol: input.symbol,
        file: input.file,
        limit,
        transitive,
      });
    } catch (err) {
      if ((err as { name?: string }).name === 'IndexRefreshInProgressError') {
        throw new Error(
          `Index refresh in progress (${state.currentFile}/${state.totalFiles} files); '${input.symbol}' has no cached answer yet — retry after the completed generation is published.`,
          { cause: err },
        );
      }
      throw new Error(
        `Index query failed for '${input.symbol}'. Run codebase-index, then retry. (${toErrorMessage(err)})`,
        { cause: err },
      );
    }
    const rawSites: CallSite[] = serviced.calls;
    const { symbolFound, totalMatches, stale } = serviced;

    if (!symbolFound) {
      // Process-local readiness resets on launch while the SQLite index may
      // never have been built. A never-built index must not be reported as a
      // LOW-risk "symbol not found" (mirrors codebase-incoming-calls).
      let hasPersistedIndex = state.ready;
      if (!hasPersistedIndex) {
        try {
          const stats = await codebaseIndexStats({ projectRoot, indexDir });
          hasPersistedIndex = stats.totalFiles > 0 || stats.lastIndexed !== null;
        } catch (err) {
          throw new Error(
            `Symbol '${input.symbol}' was not found and the persisted index could not be verified: ${toErrorMessage(err)}. Try /codebase-reindex.`,
            { cause: err },
          );
        }
      }
      if (!hasPersistedIndex) {
        throw new Error(
          'No persisted index data found. Run codebase-index to build it, then retry codebase-impact-analysis.',
        );
      }
      const reason =
        `Symbol '${input.symbol}' was not found in the index` +
        (input.file ? ` for file filter '${input.file}'` : '') +
        '. Use codebase-search to verify the name.';
      return {
        status: 'ok',
        symbol: input.symbol,
        riskLevel: 'low',
        summary: reason,
        totalCallSites: 0,
        affectedProductionFiles: [],
        affectedTestFiles: [],
        callSites: [],
        recommendedActionPlan: [reason],
        symbolFound: false,
      };
    }

    const prodFilesSet = new Set<string>();
    const testFilesSet = new Set<string>();
    const directProdFilesSet = new Set<string>();
    const indirectProdFilesSet = new Set<string>();
    const callSites: ImpactCallSite[] = [];

    for (const site of rawSites) {
      const relPath = path.relative(projectRoot, site.symbol.file).replace(/\\/g, '/');
      const isTest = isTestFilePath(relPath);
      // Deeper hops of the transitive tree carry no edge metadata (empty call
      // type): they call a caller, not the symbol, and need no edit of their own.
      const indirect = !site.callType;

      if (isTest) {
        testFilesSet.add(relPath);
      } else {
        prodFilesSet.add(relPath);
        (indirect ? indirectProdFilesSet : directProdFilesSet).add(relPath);
      }

      callSites.push({
        file: relPath,
        line: site.line,
        callerName: site.symbol.name,
        callerKind: site.symbol.kind,
        callType: site.callType,
        isTest,
        ...(indirect ? { indirect: true } : {}),
      });
    }

    for (const convTest of discoverConventionTestFiles(projectRoot, [
      ...(input.file ? [input.file] : []),
      ...directProdFilesSet,
    ])) {
      testFilesSet.add(convTest);
    }

    const prodFiles = [...prodFilesSet];
    const testFiles = [...testFilesSet];
    const directProdFiles = [...directProdFilesSet];
    const indirectOnlyProdFiles = [...indirectProdFilesSet].filter(
      (file) => !directProdFilesSet.has(file),
    );
    // Only direct sites are places to edit. Counting every transitive caller
    // here reported "Update 40 call site(s)" for a helper with two callers and
    // raised the risk level on files that need no change.
    const totalCallSites = callSites.filter((site) => !site.indirect).length;
    const indirectCallers = callSites.length - totalCallSites;

    // Determine risk level
    let riskLevel: 'low' | 'medium' | 'high' = 'low';
    if (directProdFiles.length > 5 || totalCallSites > 10) {
      riskLevel = 'high';
    } else if (directProdFiles.length > 1 || totalCallSites > 3) {
      riskLevel = 'medium';
    }
    // A wide transitive reach still widens the blast radius; it only raises.
    if (riskLevel === 'low' && prodFiles.length > 5) riskLevel = 'medium';

    // Generate action plan
    const recommendedActionPlan: string[] = [];
    if (directProdFiles.length > 0) {
      recommendedActionPlan.push(
        `Update ${totalCallSites} call site(s) across ${directProdFiles.length} production file(s): ${directProdFiles.slice(0, 3).join(', ')}${directProdFiles.length > 3 ? ` +${directProdFiles.length - 3} more` : ''}`,
      );
    }
    if (indirectOnlyProdFiles.length > 0) {
      recommendedActionPlan.push(
        `Re-verify ${indirectOnlyProdFiles.length} production file(s) that reach it only indirectly: ${indirectOnlyProdFiles.slice(0, 3).join(', ')}${indirectOnlyProdFiles.length > 3 ? ` +${indirectOnlyProdFiles.length - 3} more` : ''}`,
      );
    }
    if (testFiles.length > 0) {
      recommendedActionPlan.push(
        `Run targeted tests in ${testFiles.length} test suite(s): ${testFiles.join(', ')}`,
      );
    } else {
      recommendedActionPlan.push(
        `No existing test files directly cover '${input.symbol}'. Consider adding a test suite.`,
      );
    }

    // A capped result understates the blast radius: say so, and never let the
    // cap talk a HIGH-risk change down to a lower level.
    // Compared against every returned row: indirect callers are part of the
    // capped result even though they are not counted as call sites.
    const capped = totalMatches > callSites.length;
    if (capped) riskLevel = 'high';

    let summary = `Blast Radius for '${input.symbol}': ${riskLevel.toUpperCase()} RISK (${totalCallSites} call sites in ${directProdFiles.length} prod files, ${testFiles.length} test suites`;
    summary += indirectCallers > 0 ? `; ${indirectCallers} indirect caller(s)).` : ').';
    if (capped) {
      summary += ` Only the first ${callSites.length} of ${totalMatches} callers were analyzed; pass \`file\` to narrow.`;
    }
    if (stale) {
      summary += ` Index refresh in progress; served from the previous generation — call sites in files being indexed may lag.`;
    }

    const relatedMemories = findAnchoredSageMemories({
      projectRoot,
      files: [...(input.file ? [input.file] : []), ...directProdFiles.slice(0, 5)],
      symbols: [input.symbol],
      limit: 5,
    });
    if (relatedMemories.length > 0) {
      recommendedActionPlan.push(
        `Check ${relatedMemories.length} anchored SAGE memory insight(s): ${relatedMemories
          .map((m) => `[${m.kind}] ${m.text}`)
          .slice(0, 2)
          .join(' | ')}`,
      );
    }

    const fileHealthAlerts = findFileHealthAlerts(projectRoot, [
      ...(input.file ? [input.file] : []),
      ...directProdFiles.slice(0, 10),
    ]);
    if (fileHealthAlerts.some((h) => h.isFragile)) {
      if (riskLevel === 'low') riskLevel = 'medium';
      recommendedActionPlan.push(
        `Caution: ${fileHealthAlerts.filter((h) => h.isFragile).length} affected file(s) are flagged FRAGILE by WrongTrace (${fileHealthAlerts
          .map((h) => `${h.file} [score=${h.healthScore}, thrash=${h.recentThrashingCount}]`)
          .slice(0, 3)
          .join(', ')})`,
      );
    }

    return {
      status: 'ok',
      symbol: input.symbol,
      riskLevel,
      summary,
      totalCallSites,
      affectedProductionFiles: prodFiles,
      affectedTestFiles: testFiles,
      callSites,
      recommendedActionPlan,
      symbolFound: true,
      ...(stale ? { stale: true } : {}),
      ...(relatedMemories.length > 0 ? { relatedMemories } : {}),
      ...(fileHealthAlerts.length > 0 ? { fileHealthAlerts } : {}),
    };
  },
};
