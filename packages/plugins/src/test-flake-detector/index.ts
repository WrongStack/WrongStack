/**
 * test-flake-detector plugin — runs a test command multiple times and reports
 * tests that fail non-deterministically (flaky tests).
 *
 * Tools registered:
 * - `flake_detect` : run a test command N times and identify flaky tests
 * - `flake_status` : show config + per-session counters
 *
 * Config (`config.extensions['test-flake-detector']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "defaultCommand": "npx vitest run", // used when flake_detect.command is omitted
 *   "maxRuns": 20,                      // hard upper bound for runs param
 *   "timeoutMs": 120000                 // per-run timeout
 * }
 * ```
 *
 * @public
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import { withinProject } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface TestRecord {
  test: string;
  passCount: number;
  failCount: number;
}

interface FlakeDetectState {
  invocationCount: number;
  runCount: number;
  errorCount: number;
  lastResult: {
    runsRequested: number;
    runsCompleted: number;
    flakyTests: TestRecord[];
    alwaysFailing: TestRecord[];
    alwaysPassing: TestRecord[];
    durationMs: number;
    when: string;
  } | null;
}

const state: FlakeDetectState = {
  invocationCount: 0,
  runCount: 0,
  errorCount: 0,
  lastResult: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface FlakeDetectConfig {
  enabled: boolean;
  defaultCommand: string;
  maxRuns: number;
  timeoutMs: number;
}

const DEFAULTS: FlakeDetectConfig = {
  enabled: true,
  defaultCommand: 'npx vitest run',
  maxRuns: 20,
  timeoutMs: 120_000,
};

function readConfig(raw: unknown): FlakeDetectConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    defaultCommand:
      typeof r['defaultCommand'] === 'string' ? r['defaultCommand'] : DEFAULTS.defaultCommand,
    maxRuns:
      typeof r['maxRuns'] === 'number' && r['maxRuns'] >= 1 && r['maxRuns'] <= 100
        ? Math.floor(r['maxRuns'])
        : DEFAULTS.maxRuns,
    timeoutMs:
      typeof r['timeoutMs'] === 'number' && r['timeoutMs'] > 0
        ? r['timeoutMs']
        : DEFAULTS.timeoutMs,
  };
}

// ---------------------------------------------------------------------------
// Test-output parser (simple deterministic heuristics)
// ---------------------------------------------------------------------------

interface ParsedRun {
  passed: string[];
  failed: string[];
}

function parseTestOutput(output: string): ParsedRun {
  const passed: string[] = [];
  const failed: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // vitest / mocha / tap style: "✓ test name" or "✔ test name"
    const passMatch = line.match(/^[✓✔]\s+(.+)/);
    if (passMatch) {
      const name = passMatch[1]!.trim();
      if (!seen.has(`p:${name}`)) {
        seen.add(`p:${name}`);
        passed.push(name);
      }
      continue;
    }

    // vitest / mocha style: "✕ test name" / "✗ test name" / "× test name"
    const failMatch = line.match(/^[✕✗×]\s+(.+)/);
    if (failMatch) {
      const name = failMatch[1]!.trim();
      if (!seen.has(`f:${name}`)) {
        seen.add(`f:${name}`);
        failed.push(name);
      }
      continue;
    }

    // jest style: "● test name"
    const jestFailMatch = line.match(/^●\s+(.+)/);
    if (jestFailMatch) {
      const name = jestFailMatch[1]!.trim();
      if (!seen.has(`f:${name}`)) {
        seen.add(`f:${name}`);
        failed.push(name);
      }
    }
  }

  return { passed, failed };
}

interface ResolvedTestCommand {
  cmd: string;
  args: string[];
  display: string;
}

const TEST_RUNNERS = new Set(['vitest', 'jest', 'mocha']);
const ALLOWED_RUNNER_FLAGS = new Set([
  'run',
  '--run',
  '--runInBand',
  '--passWithNoTests',
  '--reporter=verbose',
  '--reporter=default',
  '--reporter=basic',
  '--reporter=dot',
  '--reporter=json',
  '--reporter=tap',
  '--no-color',
  '--silent',
  '--bail',
  '-b',
  '--isolate',
  '-t',
  '--testNamePattern',
]);

function isAllowedRunnerArg(arg: string): boolean {
  if (ALLOWED_RUNNER_FLAGS.has(arg)) return true;
  if (arg.startsWith('--reporter=') || arg.startsWith('--testNamePattern=')) return true;
  if (/^\d+$/.test(arg)) return true;
  return false;
}

// withinProject() imported from ../runtime/index.js

function isInside(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function tokenizeCommand(command: string): string[] | null {
  const trimmed = command.trim();
  if (!trimmed || /["'`;&|<>\r\n]/.test(trimmed)) return null;
  return trimmed.split(/\s+/).filter(Boolean);
}

function resolveTestCommand(
  baseCommand: string,
  testPattern: string | undefined,
): ResolvedTestCommand | null {
  const tokens = tokenizeCommand(baseCommand);
  if (!tokens) return null;

  let runner: string;
  let runnerArgs: string[];
  const [head, second, third, ...rest] = tokens;
  if (TEST_RUNNERS.has(head ?? '')) {
    runner = head!;
    runnerArgs = tokens.slice(1);
  } else if (head === 'npx' && TEST_RUNNERS.has(second ?? '')) {
    runner = second!;
    runnerArgs = tokens.slice(2);
  } else if (
    head === 'pnpm' &&
    (second === 'exec' || second === 'dlx') &&
    TEST_RUNNERS.has(third ?? '')
  ) {
    runner = third!;
    runnerArgs = rest;
  } else if (head === 'pnpm' && TEST_RUNNERS.has(second ?? '')) {
    runner = second!;
    runnerArgs = tokens.slice(2);
  } else if (head === 'npm' && second === 'exec' && TEST_RUNNERS.has(third ?? '')) {
    runner = third!;
    runnerArgs = rest;
  } else if (head === 'yarn' && TEST_RUNNERS.has(second ?? '')) {
    runner = second!;
    runnerArgs = tokens.slice(2);
  } else {
    return null;
  }

  if (runnerArgs.some((arg) => !isAllowedRunnerArg(arg))) return null;
  let resolvedEntry: string;
  try {
    const requireFromProject = createRequire(resolve(process.cwd(), 'package.json'));
    const packagePath = requireFromProject.resolve(`${runner}/package.json`);
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    const relativeBin =
      typeof packageJson.bin === 'string'
        ? packageJson.bin
        : (packageJson.bin?.[runner] ?? Object.values(packageJson.bin ?? {})[0]);
    if (!relativeBin) return null;
    const packageDir = dirname(packagePath);
    const candidate = resolve(packageDir, relativeBin);
    if (isAbsolute(relativeBin) || !isInside(packageDir, candidate)) {
      return null;
    }
    resolvedEntry = candidate;
  } catch {
    return null;
  }
  const args = [resolvedEntry, ...runnerArgs];
  if (testPattern) {
    if (!withinProject(testPattern)) return null;
    args.push(testPattern);
  }
  return {
    cmd: process.execPath,
    args,
    display: [...tokens, ...(testPattern ? [testPattern] : [])].join(' '),
  };
}

function runOnce(
  command: ResolvedTestCommand,
  timeoutMs: number,
): Promise<{ output: string; error?: string }> {
  return new Promise((resolveRun) => {
    execFile(
      command.cmd,
      command.args,
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        cwd: process.cwd(),
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        shell: false,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolveRun({ output: stdout });
          return;
        }
        if ((error as Error & { killed?: boolean }).killed) {
          resolveRun({ output: stdout, error: `timeout after ${timeoutMs}ms` });
          return;
        }
        resolveRun({
          output: `${stdout}\n${stderr}`.trim(),
          error: error.message || 'test command exited with non-zero code',
        });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'test-flake-detector',
  version: '0.1.0',
  description:
    'Runs a test command multiple times and reports tests that fail non-deterministically',
  apiVersion: API_VERSION,
  capabilities: { tools: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: true,
        description: 'Master switch.',
      },
      defaultCommand: {
        type: 'string',
        default: 'npx vitest run',
        description: 'Command used when flake_detect.command is omitted.',
      },
      maxRuns: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        default: 20,
        description: 'Hard upper bound for the runs parameter.',
      },
      timeoutMs: {
        type: 'number',
        minimum: 1000,
        default: 120_000,
        description: 'Per-run timeout in milliseconds.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.runCount = 0;
    state.errorCount = 0;
    state.lastResult = null;

    const cfg = readConfig(api.config.extensions?.['test-flake-detector']);

    // --- flake_detect tool ---
    api.tools.register({
      name: 'flake_detect',
      description:
        'Runs a test command multiple times and reports tests that fail non-deterministically. ' +
        'Provide testPattern and optionally runs (default 5) and command.',
      inputSchema: {
        type: 'object',
        properties: {
          testPattern: {
            type: 'string',
            description: 'Test file pattern or path to pass to the test command.',
          },
          runs: {
            type: 'number',
            minimum: 1,
            maximum: 100,
            default: 5,
            description: 'How many times to run the command.',
          },
          command: {
            type: 'string',
            description: 'Custom test command. Defaults to the configured defaultCommand.',
          },
        },
      },
      permission: 'confirm',
      category: 'Diagnostics',
      mutating: false,
      async execute(input: {
        testPattern?: string | undefined;
        runs?: number | undefined;
        command?: string | undefined;
      }) {
        if (!cfg.enabled) {
          return { ok: false, error: 'test-flake-detector is disabled' };
        }

        const raw = input as Record<string, unknown>;
        const rawPattern =
          input.testPattern ??
          raw['pattern'] ??
          raw['path'] ??
          raw['file'] ??
          raw['filePath'] ??
          raw['TargetFile'] ??
          raw['targetFile'];
        const testPattern =
          typeof rawPattern === 'string' && rawPattern.trim().length > 0
            ? rawPattern.trim()
            : undefined;

        const rawCommand = input.command ?? raw['cmd'] ?? raw['CommandLine'] ?? raw['script'];
        const commandString =
          typeof rawCommand === 'string' && rawCommand.trim().length > 0
            ? rawCommand.trim()
            : cfg.defaultCommand;

        const rawRuns =
          input.runs ?? raw['runsRequested'] ?? raw['count'] ?? raw['repeat'] ?? raw['times'];
        const requestedRuns =
          typeof rawRuns === 'number' && rawRuns >= 1
            ? Math.min(Math.floor(rawRuns), cfg.maxRuns)
            : 5;
        const command = resolveTestCommand(commandString, testPattern);
        if (!command) {
          return {
            ok: false,
            error:
              'Unsupported test command or unsafe testPattern. Use vitest, jest, or mocha through a supported package runner, and keep patterns inside the project.',
          };
        }

        state.invocationCount += 1;
        const start = Date.now();
        const records = new Map<string, TestRecord>();
        let runsCompleted = 0;
        const runErrors: string[] = [];

        for (let run = 1; run <= requestedRuns; run += 1) {
          const { output, error } = await runOnce(command, cfg.timeoutMs);
          state.runCount += 1;
          if (error) {
            state.errorCount += 1;
            runErrors.push(`run ${run}: ${error}`);
          }

          const parsed = parseTestOutput(output);
          runsCompleted += 1;

          for (const name of parsed.passed) {
            const rec = records.get(name) ?? { test: name, passCount: 0, failCount: 0 };
            rec.passCount += 1;
            records.set(name, rec);
          }
          for (const name of parsed.failed) {
            const rec = records.get(name) ?? { test: name, passCount: 0, failCount: 0 };
            rec.failCount += 1;
            records.set(name, rec);
          }
        }

        const all = Array.from(records.values());
        const flakyTests = all.filter((r) => r.passCount > 0 && r.failCount > 0);
        const alwaysFailing = all.filter((r) => r.passCount === 0 && r.failCount > 0);
        const alwaysPassing = all.filter((r) => r.passCount > 0 && r.failCount === 0);

        const durationMs = Date.now() - start;
        state.lastResult = {
          runsRequested: requestedRuns,
          runsCompleted,
          flakyTests,
          alwaysFailing,
          alwaysPassing,
          durationMs,
          when: new Date().toISOString(),
        };

        return {
          ok: true,
          command: command.display,
          runsRequested: requestedRuns,
          runsCompleted,
          durationMs,
          totalTestsObserved: all.length,
          flakyCount: flakyTests.length,
          flakyTests,
          alwaysFailing,
          alwaysPassing,
          runErrors: runErrors.length > 0 ? runErrors : undefined,
        };
      },
    });

    // --- flake_status tool ---
    api.tools.register({
      name: 'flake_status',
      description: 'Reports test-flake-detector state: config and per-session counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          defaultCommand: cfg.defaultCommand,
          maxRuns: cfg.maxRuns,
          timeoutMs: cfg.timeoutMs,
          counters: {
            invocations: state.invocationCount,
            runs: state.runCount,
            errors: state.errorCount,
          },
          lastResult: state.lastResult,
        };
      },
    });

    api.log.info('test-flake-detector plugin loaded', {
      version: '0.1.0',
      defaultCommand: cfg.defaultCommand,
      maxRuns: cfg.maxRuns,
    });
  },

  teardown(api) {
    const final = {
      invocations: state.invocationCount,
      runs: state.runCount,
      errors: state.errorCount,
    };
    state.invocationCount = 0;
    state.runCount = 0;
    state.errorCount = 0;
    state.lastResult = null;
    api.log.info('test-flake-detector: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: state.lastResult
        ? `test-flake-detector: ${state.runCount} run(s), last detection found ${state.lastResult.flakyTests.length} flaky test(s)`
        : `test-flake-detector: ${state.invocationCount} invocation(s), ${state.runCount} run(s)`,
      counters: {
        invocations: state.invocationCount,
        runs: state.runCount,
        errors: state.errorCount,
      },
      lastResult: state.lastResult,
    };
  },
};

export default plugin;
