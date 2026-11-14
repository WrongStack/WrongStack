import { spawn } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';
import { treeKill } from '@wrongstack/core/utils/tree-kill';
import { resolveExecInvocation, resolveNodeBin, withinProject } from '../runtime/index.js';

// ---------------------------------------------------------------------------
// Sandbox + command allowlist. import-organizer already uses spawn() with
// argv (no shell interpolation), so file paths cannot break out of the
// command. The remaining risk: the `command` config field lets a config-
// writer set an arbitrary first token, which spawn will execute directly.
// Lock down that first token to a known set of linter binaries.
// ---------------------------------------------------------------------------
// withinProject() imported from ../runtime/index.js

const ALLOWED_FIRST_TOKENS = new Set<string>([
  'npx',
  'pnpm',
  'npm',
  'yarn',
  'biome',
  '@biomejs/biome',
  'eslint',
  'oxlint',
  'node',
  // Recognise a fully-qualified project-local path like
  // "./node_modules/.bin/biome"; basename check kicks in below.
]);

/** Package-runner heads whose first argument names the real tool. */
const PACKAGE_RUNNERS = new Set(['npx', 'pnpm', 'npm', 'yarn']);

/** Tool token → (npm package, bin name) for project-local resolution. */
const LOCAL_BIN_PACKAGES: Record<string, { packageName: string; binName: string }> = {
  biome: { packageName: '@biomejs/biome', binName: 'biome' },
  '@biomejs/biome': { packageName: '@biomejs/biome', binName: 'biome' },
  eslint: { packageName: 'eslint', binName: 'eslint' },
  oxlint: { packageName: 'oxlint', binName: 'oxlint' },
};

/**
 * Rewrite `npx <tool> …` into `node <tool-bin-entry> …` when the tool is a
 * project dependency.
 *
 * This is strictly better than launching the package runner: it skips
 * `npx`'s per-invocation resolution (and its ability to hit the network),
 * and it works identically on Windows, where `npx`/`pnpm` are `.cmd` shims
 * that `spawn` without a shell cannot launch at all. Returns `null` when
 * the tool is not installed locally, so the caller falls back to the
 * platform-adjusted PATH invocation.
 */
function resolveLocalToolCommand(
  tokens: readonly string[],
): { cmd: string; args: string[] } | null {
  if (tokens.length === 0) return null;
  let i = 0;
  // Skip a leading package runner ("npx biome …", "pnpm exec biome …").
  if (PACKAGE_RUNNERS.has(tokens[i]!)) {
    i++;
    // Consume any run subcommands after the runner ("pnpm exec", "npm exec",
    // "yarn dlx", "pnpm dlx run" …) until the real tool token is reached.
    while (
      i < tokens.length &&
      (tokens[i] === 'exec' || tokens[i] === 'dlx' || tokens[i] === 'run')
    ) {
      i++;
    }
  }
  const toolToken = tokens[i];
  if (!toolToken) return null;
  const rest = tokens.slice(i + 1);
  const pkg = LOCAL_BIN_PACKAGES[toolToken];
  if (!pkg) return null;
  const local = resolveNodeBin(pkg.packageName, pkg.binName, process.cwd(), rest);
  if (!local) return null;
  return { cmd: local.cmd, args: local.args };
}

export function resolveAllowedCommand(command: string): { cmd: string; args: string[] } | null {
  const tokens = command.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const head = tokens[0]!;
  // Package runners (`npx some-other-package`) only pass when the resolved
  // tool token is a known linter. First-token allowlist of `npx` alone
  // would otherwise let an arbitrary package through.
  if (PACKAGE_RUNNERS.has(head)) {
    let i = 1;
    while (
      i < tokens.length &&
      (tokens[i] === 'exec' || tokens[i] === 'dlx' || tokens[i] === 'run')
    ) {
      i++;
    }
    const toolToken = tokens[i];
    if (!toolToken || !Object.hasOwn(LOCAL_BIN_PACKAGES, toolToken)) return null;
  }
  if (head === 'node') {
    const target = tokens[1];
    if (!target) return null;
    const base = basename(target);
    if (!Object.hasOwn(LOCAL_BIN_PACKAGES, base) && !ALLOWED_FIRST_TOKENS.has(base)) return null;
  }
  // Prefer the project-local binary: no package runner, no shell, no shim.
  // Defense-in-depth: only enter the local-resolution path when the first
  // token already passes the sandbox allowlist — the local path must never
  // widen what the allowlist below would accept.
  const local = ALLOWED_FIRST_TOKENS.has(head) ? resolveLocalToolCommand(tokens) : null;
  if (local) return local;
  if (ALLOWED_FIRST_TOKENS.has(head)) {
    return { cmd: head, args: tokens.slice(1) };
  }
  if (isAbsolute(head)) {
    if (!withinProject(head)) return null;
    const base = basename(head);
    if (ALLOWED_FIRST_TOKENS.has(base)) return { cmd: head, args: tokens.slice(1) };
  }
  // Allow relative paths under project root (./node_modules/.bin/biome).
  if (!isAbsolute(head) && withinProject(head)) {
    const base = basename(head);
    if (ALLOWED_FIRST_TOKENS.has(base)) return { cmd: head, args: tokens.slice(1) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Linter invocation
// ---------------------------------------------------------------------------

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Cap captured output so a chatty linter cannot grow the heap unbounded. */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

/**
 * Run a command, capture stdout/stderr, return exit code. Honors timeout
 * via AbortSignal. Uses `spawn` (not `execSync`) so the caller can mock
 * it from tests without spawning real processes.
 *
 * Timeout detection: `ChildProcess` has no `'abort'` event — the previous
 * listener for one never fired, so an aborted run surfaced through
 * `'error'` as `code: 127` ("binary not found") and spuriously triggered
 * the fallback command. The abort is now observed on the signal itself.
 */
export function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd: string,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const settle = (r: SpawnResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const signal = AbortSignal.timeout(timeoutMs);
    let child: ReturnType<typeof spawn> | undefined;
    const onAbort = (): void => {
      timedOut = true;
      // Not spawn's `signal`: it kills only the direct child — through the
      // cmd.exe shim that is cmd.exe — and the linter (a `--write` one) kept
      // running and could rewrite the file later. Kill the whole tree.
      if (child) treeKill(child);
      settle({ code: null, stdout: '', stderr: '', timedOut: true });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // Platform-adjust before spawning: `npx`/`pnpm`/`biome` are `.cmd`
    // shims on Windows and `spawn` without a shell ignores PATHEXT, so the
    // bare name failed ENOENT and this plugin never ran there at all.
    let invocation: { cmd: string; args: string[]; windowsVerbatimArguments: boolean };
    try {
      invocation = resolveExecInvocation(command, args);
    } catch {
      // Unsafe argument on the Windows shim path — refuse to run.
      signal.removeEventListener('abort', onAbort);
      settle({ code: 127, stdout: '', stderr: '', timedOut: false });
      return;
    }
    try {
      child = spawn(invocation.cmd, invocation.args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch {
      // spawn() can throw synchronously (e.g. ENOENT) when the binary is
      // missing. Treat that as a non-zero exit with no output.
      signal.removeEventListener('abort', onAbort);
      settle({ code: 127, stdout: '', stderr: '', timedOut: false });
      return;
    }
    child.stdout?.on('data', (c: Buffer) => {
      stdoutBytes += c.length;
      if (stdoutBytes <= MAX_CAPTURE_BYTES) stdoutChunks.push(c);
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderrBytes += c.length;
      if (stderrBytes <= MAX_CAPTURE_BYTES) stderrChunks.push(c);
    });
    child.on('error', () => {
      // ENOENT / EPERM etc. — same handling as a thrown spawn. An abort
      // also lands here, but `onAbort` has already settled by then.
      signal.removeEventListener('abort', onAbort);
      settle({ code: 127, stdout: '', stderr: '', timedOut: false });
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (timedOut) return;
      settle({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        timedOut: false,
      });
    });
  });
}
