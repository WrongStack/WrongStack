/**
 * `codebase-targeted-test` tool — automatically identify and run only the relevant tests for a modified symbol or file.
 *
 * Usage: codebase-targeted-test({
 *   symbol?: string,          // function/class/type name that was changed
 *   file?: string,            // source file that was changed
 *   testFiles?: string[],     // explicitly specified test files (optional)
 * })
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { spawnStream } from '../_spawn-stream.js';
import { normalizeCommandOutput, safeResolveProjectPath } from '../_util.js';
import { incomingCallsService } from './background-indexer.js';
import { isTestFilePath } from './codebase-impact-analysis-tool.js';
import { codebaseIndexDirOverride } from './writer.js';

export interface TargetedTestInput {
  /** Symbol name (function, class, method) whose tests should be discovered and run. */
  symbol?: string | undefined;
  /** Source file path whose corresponding test suite should be run. */
  file?: string | undefined;
  /** Optional explicit list of test files to run. */
  testFiles?: string[] | undefined;
}

export type CodebaseTargetedTestInput = TargetedTestInput;

export interface TargetedTestOutput {
  status: 'passed' | 'failed' | 'no_tests_found';
  discoveredSuites: string[];
  testsRun: number;
  passed: number;
  failed: number;
  durationMs: number;
  output: string;
}

export type CodebaseTargetedTestOutput = TargetedTestOutput;

/**
 * Pull pass/fail counts out of a runner's (ANSI-stripped) output.
 *
 * Vitest prints `Test Files  1 passed (1)` BEFORE `Tests  5 passed (5)`; the
 * old first-match regex reported the suite count as the test count. Scope to
 * the vitest `Tests` summary line when present, otherwise take the LAST
 * summary (pytest prints `== 3 passed, 1 failed in 0.2s ==` at the end).
 * Returns null when no counts are printed (e.g. `go test`).
 */
export function parseTestCounts(output: string): { passed: number; failed: number } | null {
  const vitestLine = output.match(/^\s*Tests\s+(.+)$/m)?.[1];
  const scope = vitestLine ?? output;
  const last = (re: RegExp): number | undefined => {
    let value: number | undefined;
    for (const m of scope.matchAll(re)) value = Number(m[1]);
    return value;
  };
  const passed = last(/(\d+)\s+passed/gi);
  const failed = last(/(\d+)\s+failed/gi);
  if (passed === undefined && failed === undefined) return null;
  return { passed: passed ?? 0, failed: failed ?? 0 };
}

/**
 * Locate candidate test files matching a source file path using common conventions.
 */
async function findConventionTestFiles(
  projectRoot: string,
  sourceRelPath: string,
): Promise<string[]> {
  const parsed = path.parse(sourceRelPath);
  const candidates = [
    path.join(parsed.dir, `${parsed.name}.test${parsed.ext}`),
    path.join(parsed.dir, `${parsed.name}.spec${parsed.ext}`),
    path.join(parsed.dir, `${parsed.name}_test${parsed.ext}`),
    path.join(parsed.dir, `test_${parsed.name}${parsed.ext}`),
    path.join('tests', `${parsed.name}.test${parsed.ext}`),
    path.join('tests', `${parsed.name}.spec${parsed.ext}`),
    path.join('test', `${parsed.name}.test${parsed.ext}`),
    path.join(parsed.dir, '__tests__', `${parsed.name}.test${parsed.ext}`),
    path.join(parsed.dir, '__tests__', `${parsed.name}${parsed.ext}`),
  ];

  const found: string[] = [];
  for (const cand of candidates) {
    const absPath = path.resolve(projectRoot, cand);
    try {
      const st = await fs.stat(absPath);
      if (st.isFile()) {
        found.push(cand.replace(/\\/g, '/'));
      }
    } catch {
      // file does not exist
    }
  }
  return found;
}

/** Call-graph discovery could not run and nothing else found a suite. */
class IndexDiscoveryError extends Error {
  override name = 'IndexDiscoveryError';
}

/**
 * Pick the runner for the discovered suites.
 *
 * - `go test` takes PACKAGES: handed `pkg/foo_test.go` it compiles that one
 *   file without the package's sources and fails on every undefined symbol.
 * - A jest project was run with `npx vitest run`, which is not installed there.
 * - Suites of different runners cannot share one command line; the old
 *   fallback handed `.py` files to vitest.
 */
export async function selectTestRunner(
  projectRoot: string,
  suites: readonly string[],
): Promise<{ cmd: string; args: string[] }> {
  const runnerOf = (suite: string): 'go' | 'pytest' | 'js' =>
    suite.endsWith('_test.go') ? 'go' : suite.endsWith('.py') ? 'pytest' : 'js';
  const runners = new Set(suites.map(runnerOf));
  if (runners.size > 1) {
    throw new ToolValidationError({
      message: `codebase-targeted-test: the suites need different runners (${[...runners].join(', ')}): ${suites.join(', ')}. Run each language's suites in a separate call.`,
      field: 'testFiles',
    });
  }
  const runner = runners.values().next().value;
  if (runner === 'go') {
    const packages = [...new Set(suites.map((s) => `./${path.posix.dirname(s)}`))];
    return { cmd: 'go', args: ['test', ...packages.map((p) => (p === './.' ? '.' : p))] };
  }
  if (runner === 'pytest') return { cmd: 'pytest', args: [...suites] };
  // `--no`: stdin is not a TTY, so npx would otherwise assume --yes and
  // download + run whatever the registry serves as the runner's name.
  return { cmd: 'npx', args: ['--no', '--', ...(await jsRunnerArgs(projectRoot)), ...suites] };
}

async function jsRunnerArgs(projectRoot: string): Promise<string[]> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    const deps = { ...manifest?.dependencies, ...manifest?.devDependencies };
    if ('jest' in deps && !('vitest' in deps)) return ['jest'];
  } catch {
    // No readable manifest: vitest stays the default.
  }
  return ['vitest', 'run'];
}

export const codebaseTargetedTestTool: Tool<TargetedTestInput, TargetedTestOutput> = {
  name: 'codebase-targeted-test',
  category: 'Code Quality',
  icon: 'test',
  permission: 'confirm',
  mutating: false,
  capabilities: ['shell.restricted', 'fs.read'],
  timeoutMs: 60_000,
  description:
    'Smart targeted test runner. Automatically identifies and executes only the test suites that cover ' +
    'a specific symbol or file using Call Graph references and convention mapping. ' +
    'Executes in ~100-500ms rather than waiting minutes for the entire test suite.',
  usageHint:
    'CALL IMMEDIATELY AFTER MUTATING A FUNCTION OR FILE:\n\n' +
    '- Pass `symbol: "calculateDiscount"` or `file: "src/order-service.ts"`.\n' +
    '- Discovers covering tests via the call graph and conventions, then executes only those files.\n' +
    '- Returns instant test feedback and failure logs for self-healing loops.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Symbol name whose covering tests should be discovered and run.',
      },
      file: {
        type: 'string',
        description: 'Source file path whose covering tests should be run.',
      },
      testFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Explicit list of test files to execute.',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx, execOpts) {
    const projectRoot = ctx.projectRoot ?? ctx.cwd ?? process.cwd();
    const suitesSet = new Set<string>();

    // Suite paths become runner ARGV. A `-`-prefixed entry was a flag
    // (`--config=…`, `--reporter=…`) and an absolute/`../` path ran code
    // outside the project; both are validated before anything spawns.
    const toProjectRelative = async (raw: string, field: string): Promise<string> => {
      if (typeof raw !== 'string' || !raw.trim() || raw.trim().startsWith('-')) {
        throw new ToolValidationError({
          message: `codebase-targeted-test: invalid path ${JSON.stringify(raw)} — expected a project file path, not a flag.`,
          field,
        });
      }
      const resolved = await safeResolveProjectPath(raw.trim(), ctx);
      return path.relative(projectRoot, resolved).replace(/\\/g, '/');
    };
    const explicitSuites: string[] = [];
    if (input.testFiles !== undefined) {
      if (!Array.isArray(input.testFiles)) {
        throw new ToolValidationError({
          message: 'codebase-targeted-test: testFiles must be an array of file paths.',
          field: 'testFiles',
        });
      }
      for (const tf of input.testFiles)
        explicitSuites.push(await toProjectRelative(tf, 'testFiles'));
    }
    const sourceFile =
      input.file !== undefined ? await toProjectRelative(input.file, 'file') : undefined;
    if (explicitSuites.length === 0 && !input.symbol?.trim() && sourceFile === undefined) {
      throw new ToolValidationError({
        message: 'codebase-targeted-test: pass at least one of `symbol`, `file`, or `testFiles`.',
        field: 'symbol',
      });
    }

    const symbol = input.symbol?.trim();
    // Why call-graph discovery failed, if it did. Discovery stays best-effort
    // while conventions still find suites, but "no_tests_found" on top of an
    // unreadable index told the agent the change was untested when the index
    // simply could not answer.
    let discoveryError: unknown;

    try {
      // 1. Explicit test files
      for (const tf of explicitSuites) suitesSet.add(tf);

      // 2. Discover from symbol call-graph
      if (symbol) {
        try {
          const indexDir = codebaseIndexDirOverride(ctx);
          const serviced = await incomingCallsService({
            projectRoot,
            indexDir,
            symbol,
            file: input.file,
            limit: 100,
            transitive: true,
          });

          for (const site of serviced.calls) {
            const relPath = path.relative(projectRoot, site.symbol.file).replace(/\\/g, '/');
            // Never hand a path outside the project to the runner.
            if (relPath.startsWith('../') || path.isAbsolute(relPath)) continue;
            if (isTestFilePath(relPath)) {
              suitesSet.add(relPath);
            }
          }
        } catch (err) {
          // Index might not be ready, continue to conventions
          discoveryError = err;
        }
      }

      // 3. Discover from file convention
      if (sourceFile !== undefined) {
        const convFiles = await findConventionTestFiles(projectRoot, sourceFile);
        for (const cf of convFiles) suitesSet.add(cf);
      }

      const discoveredSuites = [...suitesSet];

      if (discoveredSuites.length === 0) {
        if (discoveryError !== undefined) {
          throw new IndexDiscoveryError(
            `Could not discover tests for '${symbol}': the codebase index query failed (${toErrorMessage(discoveryError)}). Run codebase-index, or pass \`file\`/\`testFiles\`.`,
            { cause: discoveryError },
          );
        }
        return {
          status: 'no_tests_found',
          discoveredSuites: [],
          testsRun: 0,
          passed: 0,
          failed: 0,
          durationMs: 0,
          output: 'No targeted test suites found for the given symbol or file.',
        };
      }

      // 4. Run the targeted tests
      const start = Date.now();

      const { cmd: runnerCmd, args: runnerArgs } = await selectTestRunner(
        projectRoot,
        discoveredSuites,
      );

      const signal = execOpts?.signal ?? ctx.signal ?? new AbortController().signal;
      const gen = spawnStream({
        cmd: runnerCmd,
        args: runnerArgs,
        cwd: projectRoot,
        signal,
        maxBytes: 100_000,
      });

      let genResult = await gen.next();
      while (!genResult.done) {
        genResult = await gen.next();
      }
      const streamRes = genResult.value;

      const durationMs = Date.now() - start;
      const rawOutput = `${streamRes.stdout}\n${streamRes.stderr}`.trim();
      const combinedOutput = normalizeCommandOutput(rawOutput, { maxBytes: 4000 });

      const isPassed = streamRes.exitCode === 0;

      // Count from the UNTRUNCATED output: the runner summary sits at the
      // end, exactly where the 4 KB head/tail cut can land.
      const counts = parseTestCounts(
        normalizeCommandOutput(rawOutput, { maxBytes: Number.MAX_SAFE_INTEGER }),
      );
      const passed = counts ? counts.passed : isPassed ? discoveredSuites.length : 0;
      const failed = counts ? counts.failed : isPassed ? 0 : 1;
      const testsRun = passed + failed;

      return {
        status: isPassed ? 'passed' : 'failed',
        discoveredSuites,
        testsRun,
        passed,
        failed,
        durationMs,
        output: combinedOutput,
      };
    } catch (err) {
      if (err instanceof IndexDiscoveryError || err instanceof ToolValidationError) throw err;
      // THROW, don't return `status: 'error'` — a returned payload is a
      // successful call to the executor (is_error:false, UI shows "ok").
      // A red test run is data ('failed'); a runner that could not start is not.
      const suites = suitesSet.size > 0 ? ` (discovered suites: ${[...suitesSet].join(', ')})` : '';
      throw new Error(`Targeted test run failed to execute: ${toErrorMessage(err)}${suites}`, {
        cause: err,
      });
    }
  },
};
