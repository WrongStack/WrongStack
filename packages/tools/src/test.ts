import * as path from 'node:path';
import type { Tool, ToolStreamEvent } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import { stripAnsi } from '@wrongstack/core/utils';
import { spawnStream } from './_spawn-stream.js';
import { normalizeCommandOutput, safeResolveReal } from './_util.js';
import { tryLegacyCodeOperation } from './languages/legacy-bridge.js';

export type TestRunnerName = 'vitest' | 'jest' | 'mocha' | 'auto';

export interface TestInput {
  files?: string | string[] | undefined;
  runner?: TestRunnerName | undefined;
  /** @deprecated Ignored — a watch-mode runner never exits inside a tool call. */
  watch?: boolean | undefined;
  coverage?: boolean | undefined;
  cwd?: string | undefined;
  grep?: string | undefined;
  timeout?: number | undefined;
  verbose?: boolean | undefined;
}

export interface TestOutput {
  runner: string;
  /**
   * `passed`/`failed` — tests actually ran. `no_tests` — there was nothing to
   * run (no runner configured, or the runner found no test files). "No tests"
   * is a real answer, but it is NOT a pass: `exit_code` is null when no runner
   * was launched, and callers must never read it as green.
   */
  status: 'passed' | 'failed' | 'no_tests';
  exit_code: number | null;
  tests_run: number;
  passed: number;
  failed: number;
  duration_ms: number;
  output: string;
  truncated: boolean;
}

export type TestContext = Parameters<Tool<TestInput, TestOutput>['execute']>[1];

export const testTool: Tool<TestInput, TestOutput> = {
  name: 'test',
  category: 'Code Quality',
  description:
    "Execute the project's test suite. This is one of the most critical tools for validating that your changes are correct.",
  usageHint:
    'ESSENTIAL BEFORE CONSIDERING WORK DONE:\n\n' +
    '- Use `files` or `grep` to run only relevant tests during development.\n' +
    '- `coverage: true` is useful when working on critical paths.\n' +
    '- Check `status`: `passed`, `failed`, or `no_tests` (no runner configured / no test files matched). `no_tests` is NOT a pass.\n' +
    'Run tests frequently. A clean test run is usually required before the task can be considered complete.',
  permission: 'confirm',
  mutating: false,
  icon: 'test',
  timeoutMs: 120_000,
  capabilities: ['shell.restricted'],
  inputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'string',
        description: 'Test files: single path, comma-separated list, or glob (e.g. "**/*.test.ts")',
      },
      runner: {
        type: 'string',
        enum: ['vitest', 'jest', 'mocha', 'auto'],
        description: 'Test runner (default: auto-detect)',
      },
      coverage: { type: 'boolean', description: 'Generate coverage report (default: false)' },
      cwd: { type: 'string', description: 'Working directory (default: cwd)' },
      grep: { type: 'string', description: 'Filter tests by name pattern (default: none)' },
      timeout: { type: 'integer', description: 'Test timeout in ms (default: 30000)' },
      verbose: {
        type: 'boolean',
        description:
          'Per-test verbose reporter output (default: false — the summary reporter is used; ' +
          'full output is always saved to a log file referenced in the result)',
      },
    },
  },
  async execute(input, ctx, opts) {
    let final: TestOutput | undefined;
    const executeStream = testTool.executeStream;
    if (!executeStream) throw new Error('testTool: stream execution unavailable');
    for await (const ev of executeStream(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('test: stream ended without final event');
    return final;
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<TestOutput>> {
    const cwd =
      input.cwd || ctx.workingDir
        ? await safeResolveReal(input.cwd ?? ctx.workingDir!, ctx)
        : ctx.cwd;
    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const VALID_RUNNERS: ReadonlySet<string> = new Set(['vitest', 'jest', 'mocha', 'auto', 'none']);
    if (input.runner !== undefined && !VALID_RUNNERS.has(input.runner)) {
      throw new ToolValidationError({
        message: `test: unsupported runner "${input.runner}". Allowed runners: vitest, jest, mocha, auto, none`,
        field: 'runner',
      });
    }
    const runner = input.runner ?? 'auto';

    // Delegate to the language planner for non-JS ecosystems (Go, Rust, PHP, C#).
    if (runner === 'auto') {
      const bridge = await tryLegacyCodeOperation('test', {
        cwd,
        projectRoot: ctx.projectRoot,
        signal,
      });
      if (bridge?.run) {
        const run = bridge.run;
        // The ecosystem's runner could not be launched: exitCode is null, and
        // `?? 0` below would report it as a clean pass.
        if (run.status === 'unavailable') {
          throw new Error(
            `test: ${bridge.language} test runner unavailable: ${run.error || run.output || 'no detail'}`,
          );
        }
        // A user abort is not a test result.
        if (run.status === 'cancelled') {
          signal.throwIfAborted();
          throw new Error(`test: ${bridge.language} test run was cancelled`);
        }
        // `failed` with no exit code means the run crashed before producing
        // one (spawn error) — an operational failure, same as the JS path.
        if (run.status === 'failed' && run.exitCode === null) {
          throw new Error(
            `test: ${bridge.language} test runner failed to run: ${run.error || 'no detail'}`,
          );
        }
        const passed = run.summary.passed ?? 0;
        const failed = run.summary.failed ?? 0;
        const rawOutput = run.output || run.error || '';
        // The run's own status is authoritative. `exitCode ?? 0` used to turn
        // a timed-out run (exitCode null) into exit 0 → "passed": an agent
        // would report green tests that never finished.
        const status: TestOutput['status'] =
          run.status === 'passed' && run.exitCode === 0
            ? resolveStatus(0, passed + failed, rawOutput)
            : 'failed';
        const timedOutNote =
          run.status === 'timed_out' ? `Test run timed out before completing.\n` : '';
        yield {
          type: 'final',
          output: {
            runner: bridge.language,
            status,
            exit_code: run.exitCode,
            tests_run: passed + failed,
            passed,
            failed,
            duration_ms: run.durationMs,
            output: normalizeCommandOutput(timedOutNote + rawOutput),
            truncated: run.truncated,
          },
        };
        return;
      }
    }

    const detected = runner === 'auto' ? await detectRunner(cwd) : runner;
    if (!detected || detected === 'none') {
      yield {
        type: 'final',
        output: {
          runner: 'none',
          // Nothing ran: not a pass, and no exit code to report.
          status: 'no_tests',
          exit_code: null,
          tests_run: 0,
          passed: 0,
          failed: 0,
          duration_ms: 0,
          output:
            'No tests: no test runner configured (looked for vitest.config.*, jest.config.*, .mocharc.*).',
          truncated: false,
        },
      };
      return;
    }

    yield { type: 'log', text: `Running ${detected}…`, data: { runner: detected } };

    const start = Date.now();
    const args = buildArgs(detected, input);

    const result = yield* spawnStream({
      cmd: detected,
      args,
      cwd,
      signal,
      maxBytes: 200_000,
    });
    const duration = Date.now() - start;

    // Spawn failure (runner binary missing, EACCES…): the tests never ran, so
    // this is a failed call rather than an exit-code result.
    if (result.error) {
      throw new Error(`test: failed to start ${detected}: ${result.error}`);
    }

    yield { type: 'final', output: parseResult(detected, result, duration) };
  },
};

async function detectRunner(cwd: string): Promise<string | null> {
  const { stat } = await import('node:fs/promises');
  const candidates = [
    'vitest.config.ts',
    'vitest.config.js',
    'vitest.config.mjs',
    'vitest.config.mts',
    'vitest.config.cjs',
    'vitest.config.cts',
    'jest.config.ts',
    'jest.config.js',
    'jest.config.mjs',
    'jest.config.cjs',
    '.mocharc.json',
    '.mocharc.js',
    '.mocharc.cjs',
  ];
  for (const f of candidates) {
    try {
      await stat(path.join(cwd, f));
      if (f.includes('vitest')) return 'vitest';
      if (f.includes('jest')) return 'jest';
      if (f.includes('mocha')) return 'mocha';
    } catch {
      // continue
    }
  }
  return null;
}

function buildArgs(runner: string, input: TestInput): string[] {
  const args: string[] = [];
  const rawTimeout =
    typeof input.timeout === 'number' && Number.isFinite(input.timeout) && input.timeout > 0
      ? Math.floor(input.timeout)
      : 30000;
  // The runner arms each test with setTimeout, which Node clamps above
  // 2^31-1 ms to 1 ms: a huge timeout failed every test as "timed out".
  const timeout = Math.min(Math.max(100, rawTimeout), 2_147_483_647);

  switch (runner) {
    case 'vitest':
      // Default reporter, NOT verbose: a verbose run over a large suite
      // emits one line per test (tens of MB on big monorepos) that then has
      // to be buffered, spooled, and truncated. The default reporter prints
      // per-file summaries + full failure details, which is what the agent
      // acts on. Opt back in per call with `verbose: true`.
      // `watch` is deliberately ignored: a watch-mode runner never exits, so
      // an agent tool call would burn its whole timeout and never return a
      // test result. Always run the suite once.
      args.push('run');
      if (input.verbose) args.push('--reporter=verbose');
      if (input.coverage) args.push('--coverage');
      if (input.grep) args.push('--testNamePattern', input.grep);
      args.push('--testTimeout', String(timeout));
      break;
    case 'jest':
      if (input.verbose) args.push('--verbose');
      // No `--watch`: see the vitest branch.
      if (input.coverage) args.push('--coverage');
      if (input.grep) args.push('--testNamePattern', input.grep);
      args.push('--testTimeout', String(timeout));
      break;
    case 'mocha':
      args.push('--reporter', 'spec');
      if (input.grep) args.push('--grep', input.grep);
      args.push('--timeout', String(timeout));
      break;
  }

  if (input.files) {
    const files = (Array.isArray(input.files) ? input.files : input.files.split(','))
      .map((f) => f.trim().replace(/\\/g, '/'))
      .filter(Boolean);
    if (files.length > 0 && runner === 'vitest') {
      // vitest (cac) moves everything after `--` out of its filters, so
      // `vitest run -- a.test.ts` ran the WHOLE suite. Filters go positional;
      // with no `--` fence, a leading `-` would parse as a flag — refuse it.
      const flagLike = files.find((f) => f.startsWith('-'));
      if (flagLike) {
        throw new ToolValidationError({
          message: `test: file filter "${flagLike}" may not begin with '-'`,
          field: 'files',
        });
      }
      args.push(...files);
    } else if (files.length > 0) {
      args.push('--', ...files);
    }
  }

  return args;
}

// Runner phrasings for "there was nothing to run": vitest/jest exit 1 with
// these, mocha exits 0 with "0 passing", go/cargo print their own variants.
const NO_TESTS_PATTERN =
  /No test files found|No tests found|no test files|running 0 tests|^\s*0 passing/im;

function resolveStatus(
  exitCode: number | null,
  testsRun: number,
  output: string,
): TestOutput['status'] {
  if (testsRun === 0 && NO_TESTS_PATTERN.test(output)) return 'no_tests';
  return exitCode === 0 ? 'passed' : 'failed';
}

function parseResult(
  runner: string,
  result: {
    stdout: string;
    stderr: string;
    exitCode: number;
    truncated: boolean;
    error?: string | undefined;
  },
  duration: number,
): TestOutput {
  const out = result.stdout + result.stderr;

  let tests_run = 0;
  let passed = 0;
  let failed = 0;

  if (runner === 'vitest') {
    // The summary has a `Test Files  1 failed | 1 passed (2)` line BEFORE
    // `Tests  1 failed | 3 passed (4)`; reading the first `N passed` in the
    // output counted FILES. Read the `Tests` line when there is one (colour
    // codes stripped — vitest paints the label).
    const plain = stripAnsi(out);
    const testsLine = /^\s*Tests\s+(.+)$/m.exec(plain)?.[1] ?? plain;
    const passedMatch = testsLine.match(/(\d+) passed/);
    const failedMatch = testsLine.match(/(\d+) failed/);
    if (passedMatch?.[1]) passed = Number.parseInt(passedMatch[1], 10);
    if (failedMatch?.[1]) failed = Number.parseInt(failedMatch[1], 10);
    tests_run = passed + failed;
  } else if (runner === 'jest') {
    const totalMatch = out.match(/Tests:\s+(?:.*,\s+)?(\d+)\s+total/);
    const passedMatch = out.match(/Tests:\s+.*?(\d+)\s+passed/);
    const failedMatch = out.match(/Tests:\s+.*?(\d+)\s+failed/);
    passed = Number.parseInt(passedMatch?.[1] ?? '0', 10);
    failed = Number.parseInt(failedMatch?.[1] ?? '0', 10);
    tests_run = totalMatch?.[1] ? Number.parseInt(totalMatch[1], 10) : passed + failed;
  } else if (runner === 'mocha') {
    const passedMatch = out.match(/(\d+)\s+passing/);
    const failedMatch = out.match(/(\d+)\s+failing/);
    if (passedMatch?.[1]) passed = Number.parseInt(passedMatch[1], 10);
    if (failedMatch?.[1]) failed = Number.parseInt(failedMatch[1], 10);
    tests_run = passed + failed;
  }

  const rawOutput =
    result.stdout && result.stderr
      ? `${result.stdout}\n${result.stderr}`
      : result.stdout || result.stderr || result.error || '';

  return {
    runner,
    status: resolveStatus(result.exitCode, tests_run, out),
    exit_code: result.exitCode,
    tests_run,
    passed,
    failed,
    duration_ms: duration,
    // A passing run only needs the tail summary in chat history — counts are
    // already parsed above and the FULL log is on disk (spool marker rides
    // the stdout tail). Failures keep the standard command-output cap so
    // the agent sees the failure details inline.
    output: normalizeCommandOutput(rawOutput, {
      maxBytes: result.exitCode === 0 ? 4096 : undefined,
    }),
    truncated: result.truncated,
  };
}
