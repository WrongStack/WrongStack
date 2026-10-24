import type { Runner } from './test-runner.js';
import {
  detectRunner,
  findTestFile,
  getResolvableExtensions,
  pathContentHash,
  runTests,
} from './test-runner.js';
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

import type { Plugin } from '@wrongstack/contracts/types';
import { BoundedMap, releaseHandle, withinProject } from '../runtime/index.js';

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
  /** Monotonic lifecycle token so an in-flight setup aborted by a newer setup or teardown does not register a stale hook. */
  setupGeneration: 0,
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
  // Opt-in belongs to host enablement, not this switch — see the
  // plugin-enable-double-gate audit.
  enabled: true,
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
    enabled: r['enabled'] !== false,
    runner,
    command: typeof r['command'] === 'string' ? r['command'] : DEFAULTS.command,
    // Node clamps a timer above 2^31-1 ms to 1 ms; cap it so a huge timeout
    // means "very long", not "kill at once".
    timeoutMs:
      typeof r['timeoutMs'] === 'number' && r['timeoutMs'] > 0
        ? Math.min(r['timeoutMs'], 2_147_483_647)
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

/**
 * Per-path memo: hash of the source content at the last PASSED run.
 * We only cache PASSES because caching failures would freeze broken
 * state — the model needs to see the failure so it knows to fix.
 */
/**
 * Content hash of each source file whose tests last passed. Bounded:
 * over a long session on a large repository this grew one entry per
 * source file touched and was only ever released at teardown.
 */
const lastPassedHash = new BoundedMap<string, number>({ max: 1_024 });

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
    const generation = ++state.setupGeneration;
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.runCount = 0;
    state.passCount = 0;
    state.failCount = 0;
    state.noTestCount = 0;
    state.errorCount = 0;
    state.extensionSkippedCount = 0;
    state.cachedSkipCount = 0;
    state.hookUnregister = releaseHandle(state.hookUnregister);
    state.lastResult = null;
    lastPassedHash.clear();

    const cfg = readConfig(api.config.extensions?.['test-runner-gate']);

    // Detect runner at setup time. When a custom `command` is configured,
    // skip the `npx --no -- <runner> --version` subprocess probe so setup
    // does not depend on npx shell latency or fail when npx is slow.
    const defaultRunnerConfigs: Record<
      'vitest' | 'jest' | 'mocha',
      { name: 'vitest' | 'jest' | 'mocha'; command: string; jsonFlags: string }
    > = {
      vitest: { name: 'vitest', command: 'npx --no -- vitest run', jsonFlags: '--reporter=json' },
      jest: { name: 'jest', command: 'npx --no -- jest', jsonFlags: '--json' },
      mocha: { name: 'mocha', command: 'npx --no -- mocha', jsonFlags: '--reporter json' },
    };
    const runner =
      cfg.command && cfg.runner !== 'auto'
        ? await Promise.resolve(defaultRunnerConfigs[cfg.runner])
        : await detectRunner(cfg.runner);
    if (generation !== state.setupGeneration) return;
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

      const contentForHash = (): string => {
        if (input.toolName === 'write') {
          const c = inp['content'];
          return typeof c === 'string' && c.length > 0 ? `write:${c}` : '';
        }
        if (input.toolName === 'edit') {
          const n = inp['new_string'];
          const o = inp['old_string'];
          if (typeof n !== 'string' || n.length === 0) return '';
          return typeof o === 'string' ? `edit:${o}\0${n}` : `edit:${n}`;
        }
        return '';
      };

      // Content-hash dedupe: if a previous PASS for this path
      // recorded the same content fingerprint, skip the test run.
      // Catches the "format-on-save / import-organizer re-touches the
      // file right after the test already passed" pattern.
      if (cfg.enableContentHashCache) {
        const content = contentForHash();
        if (content.length > 0) {
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
          const content = contentForHash();
          if (content.length > 0) {
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

      // Tests failed — invalidate any cached PASS hash for this path and inject failure details.
      lastPassedHash.delete(sourcePath);
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

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, {
      background: true,
    });

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
    state.setupGeneration += 1;
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
