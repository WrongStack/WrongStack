/**
 * `codebase-impact-analysis` tool — calculate the blast radius and breaking change risk of modifying a symbol.
 *
 * Usage: codebase-impact-analysis({
 *   symbol: string,           // name of the function, method, class, or type to analyze
 *   file?: string,            // optional file path to disambiguate
 *   transitive?: boolean,     // traverse transitive callers (default: true)
 * })
 */

import * as path from 'node:path';
import type { Tool } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { incomingCallsService } from './background-indexer.js';
import type { CallSite } from './schema.js';
import { codebaseIndexDirOverride } from './writer.js';

interface ImpactAnalysisInput {
  /** The symbol name (function, method, class, interface, type) to analyze. */
  symbol: string;
  /** Optional file path to disambiguate when multiple symbols share a name. */
  file?: string | undefined;
  /** Whether to traverse transitive callers (callers of callers). Defaults to true. */
  transitive?: boolean | undefined;
}

interface ImpactCallSite {
  file: string;
  line: number;
  callerName: string;
  callerKind: string;
  callType: string;
  isTest: boolean;
}

interface ImpactAnalysisOutput {
  status: 'ok' | 'error';
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
  error?: string | undefined;
}

const TEST_FILE_REGEX = /(?:test|spec|mock|fixture|bench)[s]?[/\\._]/i;

export const codebaseImpactAnalysisTool: Tool<ImpactAnalysisInput, ImpactAnalysisOutput> = {
  name: 'codebase-impact-analysis',
  category: 'Project',
  icon: 'index',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
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
    try {
      const projectRoot = ctx.projectRoot;
      const indexDir = codebaseIndexDirOverride(ctx);
      const limit = 200;
      const transitive = input.transitive ?? true;

      let rawSites: CallSite[] = [];
      let symbolFound = true;
      let indexUnavailable = false;
      let indexError: string | undefined;
      try {
        const serviced = await incomingCallsService({
          projectRoot,
          indexDir,
          symbol: input.symbol,
          file: input.file,
          limit,
          transitive,
        });
        rawSites = serviced.calls;
        symbolFound = serviced.symbolFound;
      } catch (err) {
        // Fall back gracefully when index is cold/not yet built — but keep the
        // actual error so the remediation message distinguishes a missing
        // build from an endpoint-invalid or watchdog-timeout rejection.
        symbolFound = false;
        indexUnavailable = true;
        indexError = toErrorMessage(err);
      }

      if (indexUnavailable) {
        // An index outage is an operational failure, NOT "symbol not found":
        // callers that gate on `status` must see error so they retry after
        // rebuilding the index instead of concluding the symbol is missing.
        const detail = indexError ? ` (${indexError})` : '';
        const reason = `Index query failed for '${input.symbol}'. Run codebase-index, then retry.${detail}`;
        return {
          status: 'error',
          symbol: input.symbol,
          riskLevel: 'low',
          summary: reason,
          totalCallSites: 0,
          affectedProductionFiles: [],
          affectedTestFiles: [],
          callSites: [],
          recommendedActionPlan: [reason],
          symbolFound: false,
          error: reason,
        };
      }

      if (!symbolFound) {
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
      const callSites: ImpactCallSite[] = [];

      for (const site of rawSites) {
        const relPath = path.relative(projectRoot, site.symbol.file).replace(/\\/g, '/');
        const isTest = TEST_FILE_REGEX.test(relPath);

        if (isTest) {
          testFilesSet.add(relPath);
        } else {
          prodFilesSet.add(relPath);
        }

        callSites.push({
          file: relPath,
          line: site.line,
          callerName: site.symbol.name,
          callerKind: site.symbol.kind,
          callType: site.callType,
          isTest,
        });
      }

      const prodFiles = [...prodFilesSet];
      const testFiles = [...testFilesSet];
      const totalCallSites = callSites.length;

      // Determine risk level
      let riskLevel: 'low' | 'medium' | 'high' = 'low';
      if (prodFiles.length > 5 || totalCallSites > 10) {
        riskLevel = 'high';
      } else if (prodFiles.length > 1 || totalCallSites > 3) {
        riskLevel = 'medium';
      }

      // Generate action plan
      const recommendedActionPlan: string[] = [];
      if (prodFiles.length > 0) {
        recommendedActionPlan.push(
          `Update ${totalCallSites} call site(s) across ${prodFiles.length} production file(s): ${prodFiles.slice(0, 3).join(', ')}${prodFiles.length > 3 ? ` +${prodFiles.length - 3} more` : ''}`,
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

      const summary = `Blast Radius for '${input.symbol}': ${riskLevel.toUpperCase()} RISK (${totalCallSites} call sites in ${prodFiles.length} prod files, ${testFiles.length} test suites).`;

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
      };
    } catch (err) {
      return {
        status: 'error',
        symbol: input.symbol,
        riskLevel: 'low',
        summary: '',
        totalCallSites: 0,
        affectedProductionFiles: [],
        affectedTestFiles: [],
        callSites: [],
        recommendedActionPlan: [],
        symbolFound: false,
        error: toErrorMessage(err),
      };
    }
  },
};
