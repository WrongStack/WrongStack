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
import type { Tool } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { spawnStream } from '../_spawn-stream.js';
import { normalizeCommandOutput } from '../_util.js';
import { incomingCallsService } from './background-indexer.js';
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
  status: 'passed' | 'failed' | 'no_tests_found' | 'error';
  discoveredSuites: string[];
  testsRun: number;
  passed: number;
  failed: number;
  durationMs: number;
  output: string;
  error?: string | undefined;
}

export type CodebaseTargetedTestOutput = TargetedTestOutput;

const TEST_FILE_REGEX = /(?:test|spec|mock|fixture|bench)[s]?[/\\._]/i;

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

    try {
      // 1. Explicit test files
      if (input.testFiles) {
        for (const tf of input.testFiles) suitesSet.add(tf.replace(/\\/g, '/'));
      }

      // 2. Discover from symbol call-graph
      if (input.symbol) {
        try {
          const indexDir = codebaseIndexDirOverride(ctx);
          const serviced = await incomingCallsService({
            projectRoot,
            indexDir,
            symbol: input.symbol,
            file: input.file,
            limit: 100,
            transitive: true,
          });

          for (const site of serviced.calls) {
            const relPath = path.relative(projectRoot, site.symbol.file).replace(/\\/g, '/');
            if (TEST_FILE_REGEX.test(relPath)) {
              suitesSet.add(relPath);
            }
          }
        } catch {
          // Index might not be ready, continue to conventions
        }
      }

      // 3. Discover from file convention
      if (input.file) {
        const convFiles = await findConventionTestFiles(projectRoot, input.file);
        for (const cf of convFiles) suitesSet.add(cf);
      }

      const discoveredSuites = [...suitesSet];

      if (discoveredSuites.length === 0) {
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

      // Check package.json to see test runner
      let runnerCmd = 'npx';
      let runnerArgs: string[] = ['vitest', 'run', ...discoveredSuites];

      // Detect Python / Go if all suites are py / go
      if (discoveredSuites.every((s) => s.endsWith('.py'))) {
        runnerCmd = 'pytest';
        runnerArgs = discoveredSuites;
      } else if (discoveredSuites.every((s) => s.endsWith('_test.go'))) {
        runnerCmd = 'go';
        runnerArgs = ['test', ...discoveredSuites];
      }

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
      const combinedOutput = normalizeCommandOutput(
        `${streamRes.stdout}\n${streamRes.stderr}`.trim(),
        { maxBytes: 4000 },
      );

      const isPassed = streamRes.exitCode === 0;

      // Extract basic test numbers if possible
      const passMatch = combinedOutput.match(/(\d+)\s+passed/i);
      const failMatch = combinedOutput.match(/(\d+)\s+failed/i);

      const passed = passMatch
        ? parseInt(passMatch[1] ?? '0', 10)
        : isPassed
          ? discoveredSuites.length
          : 0;
      const failed = failMatch ? parseInt(failMatch[1] ?? '0', 10) : isPassed ? 0 : 1;
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
      return {
        status: 'error',
        discoveredSuites: [...suitesSet],
        testsRun: 0,
        passed: 0,
        failed: 0,
        durationMs: 0,
        output: '',
        error: toErrorMessage(err),
      };
    }
  },
};
