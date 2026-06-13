import * as path from 'node:path';
import type { Tool, ToolStreamEvent } from '@wrongstack/core';
import { spawnStream } from './_spawn-stream.js';
import { normalizeCommandOutput, safeResolve } from './_util.js';

interface TestInput {
  files?: string | string[] | undefined;
  runner?: 'vitest' | 'jest' | 'mocha' | 'auto' | undefined;
  watch?: boolean | undefined;
  coverage?: boolean | undefined;
  cwd?: string | undefined;
  grep?: string | undefined;
  timeout?: number | undefined;
  verbose?: boolean | undefined;
}

interface TestOutput {
  runner: string;
  exit_code: number;
  tests_run: number;
  passed: number;
  failed: number;
  duration_ms: number;
  output: string;
  truncated: boolean;
}

export const testTool: Tool<TestInput, TestOutput> = {
  name: 'test',
  category: 'Code Quality',
  description:
    'Execute the project\'s test suite. This is one of the most critical tools for validating that your changes are correct.',
  usageHint:
    'ESSENTIAL BEFORE CONSIDERING WORK DONE:\n\n' +
    '- Use `files` or `grep` to run only relevant tests during development.\n' +
    '- `coverage: true` is useful when working on critical paths.\n' +
    'Run tests frequently. A clean test run is usually required before the task can be considered complete.',
  permission: 'confirm',
  mutating: false,
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
      watch: { type: 'boolean', description: 'Run in watch mode (default: false)' },
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
    const cwd = input.cwd ? safeResolve(input.cwd, ctx) : ctx.cwd;
    const runner = input.runner ?? 'auto';

    const detected = runner === 'auto' ? await detectRunner(cwd) : runner;
    if (!detected) {
      yield {
        type: 'final',
        output: {
          runner: 'none',
          exit_code: 0,
          tests_run: 0,
          passed: 0,
          failed: 0,
          duration_ms: 0,
          output: 'No test runner found (vitest.config.ts, jest.config.js, .mocharc.json)',
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
      signal: opts.signal,
      maxBytes: 200_000,
    });
    const duration = Date.now() - start;

    yield { type: 'final', output: parseResult(detected, result, duration) };
  },
};

async function detectRunner(cwd: string): Promise<string | null> {
  const { stat } = await import('node:fs/promises');
  const candidates = ['vitest.config.ts', 'jest.config.js', '.mocharc.json'];
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
  const timeout = input.timeout ?? 30000;

  switch (runner) {
    case 'vitest':
      // Default reporter, NOT verbose: a verbose run over a large suite
      // emits one line per test (tens of MB on big monorepos) that then has
      // to be buffered, spooled, and truncated. The default reporter prints
      // per-file summaries + full failure details, which is what the agent
      // acts on. Opt back in per call with `verbose: true`.
      args.push(input.watch ? 'watch' : 'run');
      if (input.verbose) args.push('--reporter=verbose');
      if (input.coverage) args.push('--coverage');
      if (input.grep) args.push('--testNamePattern', input.grep);
      args.push('--testTimeout', String(timeout));
      break;
    case 'jest':
      if (input.verbose) args.push('--verbose');
      if (input.watch) args.push('--watch');
      if (input.coverage) args.push('--coverage');
      if (input.grep) args.push('--testPathPattern', input.grep);
      args.push('--testTimeout', String(timeout));
      break;
    case 'mocha':
      args.push('--reporter', 'spec');
      if (input.grep) args.push('--grep', input.grep);
      args.push('--timeout', String(timeout));
      break;
  }

  if (input.files) {
    const files = Array.isArray(input.files) ? input.files : input.files.split(',');
    args.push('--', ...files.map((f) => f.trim()));
  }

  return args;
}

function parseResult(
  runner: string,
  result: { stdout: string; stderr: string; exitCode: number; truncated: boolean; error?: string | undefined },
  duration: number,
): TestOutput {
  const out = result.stdout + result.stderr;

  let tests_run = 0;
  let passed = 0;
  let failed = 0;

  if (runner === 'vitest') {
    const passedMatch = out.match(/(\d+) passed/);
    const failedMatch = out.match(/(\d+) failed/);
    if (passedMatch?.[1]) passed = Number.parseInt(passedMatch[1], 10);
    if (failedMatch?.[1]) failed = Number.parseInt(failedMatch[1], 10);
    tests_run = passed + failed;
  } else if (runner === 'jest') {
    const suitesMatch = out.match(/Test Suites:\s+(\d+)\s+total/);
    const passedMatch = out.match(/Tests:\s+(\d+)\s+passed/);
    const failedMatch = out.match(/Tests:\s+(\d+)\s+failed/);
    tests_run = Number.parseInt(suitesMatch?.[1] ?? '0', 10);
    passed = Number.parseInt(passedMatch?.[1] ?? '0', 10);
    failed = Number.parseInt(failedMatch?.[1] ?? '0', 10);
  }

  return {
    runner,
    exit_code: result.exitCode,
    tests_run,
    passed,
    failed,
    duration_ms: duration,
    // A passing run only needs the tail summary in chat history — counts are
    // already parsed above and the FULL log is on disk (spool marker rides
    // the stdout tail). Failures keep the standard command-output cap so
    // the agent sees the failure details inline.
    output: normalizeCommandOutput(result.stdout || result.error || '', {
      maxBytes: result.exitCode === 0 ? 4096 : undefined,
    }),
    truncated: result.truncated,
  };
}
