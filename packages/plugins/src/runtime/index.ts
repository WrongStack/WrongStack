/**
 * @wrongstack/plugins — Language-agnostic runtime helper.
 *
 * Plugins that need to invoke a build-time or test-time tool
 * (TypeScript's `tsc`, Node's `vitest`, Python's `pytest`, Rust's
 * `cargo`, Go's `go test`, etc.) share this module instead of
 * re-implementing argv/sandbox/allowlist logic.
 *
 * Why one module instead of three plugin-local copies?
 * - One audit surface for security-sensitive code: arg-splitting,
 *   sandboxing, execFile-with-shell-false, maxBuffer, timeout.
 * - Plugins stay focused on their domain (linters, type-checkers,
 *   test runners); the runtime helper owns the cross-cutting concern.
 * - New languages opt in by adding a `LanguageRuntime` entry; the
 *   plugin layer keeps working unchanged.
 *
 * The public API is intentionally small:
 *   - `LanguageRuntime`: declares which language a plugin targets.
 *   - `resolveRunnerCommand(runtime, command, options)`: validate +
 *     split a user-supplied command into a safe argv array.
 *   - `sanitizeRunnerPath(value, options)`: reject paths outside
 *     the project or that start with `-` (option smuggling).
 *   - `runRunnerCommand(argv, options)`: spawn the resolved argv
 *     with `shell:false`, capture stdout/stderr/code, and apply
 *     timeout/abort.
 *   - `probeRunner(runtime, argv, options)`: cheap availability check.
 *
 * Anything language-specific (flag tables, default commands,
 * output parsing) stays in the plugin that owns that language.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';

export {
  parseLlmJsonObject,
  runOptionalPluginLlm,
  stripOuterMarkdownFence,
  type OptionalLlmRequest,
  type OptionalLlmResult,
} from './llm.js';

export type LanguageId =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'shell'
  | 'ruby'
  | 'java'
  | 'kotlin'
  | 'dotnet'
  | 'generic';

export type PackageManagerId =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'pip'
  | 'poetry'
  | 'go'
  | 'cargo'
  | 'gem'
  | 'maven'
  | 'gradle'
  | 'dotnet'
  | 'none';

export interface LanguageRuntime {
  /** Stable identifier for diagnostics and logging. */
  id: LanguageId;
  /**
   * Default package manager launcher if the plugin must spawn a tool
   * (e.g. `npx vitest` or `cargo test`). `none` means the executable
   * itself is invoked directly (no launcher).
   */
  packageManager: PackageManagerId;
  /**
   * Executable token that must appear as the second argv element when
   * a launcher is used (e.g. `vitest` after `pnpm exec`, `test` after
   * `cargo`). When `subcommands.length === 0` and the package manager
   * has no subcommand step, this is also accepted as the head token.
   */
  executable: string;
  /**
   * Allowlisted flag values, in addition to positional arguments and
   * file paths. `null` means "no flag allowlist enforced" — every
   * leading-dash token is still rejected, but no flag whitelist applies.
   */
  allowedFlags: ReadonlySet<string> | null;
  /**
   * Optional list of subcommand tokens that may follow the launcher,
   * e.g. `['exec']` for `pnpm exec tsc`. Empty array means the runner
   * executable must appear immediately as the second token (e.g.
   * `cargo test`, `go test`).
   */
  subcommands: readonly string[];
  /**
   * Default command spelling for `resolveRunnerCommand` when no
   * custom command is supplied. Plugins can override via config.
   */
  defaultCommand: string;
}

export interface ResolvedCommand {
  cmd: string;
  args: readonly string[];
  display: string;
}

export interface ResolveOptions {
  /**
   * Project root used to sandbox absolute executable paths. Defaults
   * to `process.cwd()`. Absolute executable paths must resolve inside
   * this directory; relative basenames must match `LanguageRuntime.executable`.
   */
  projectRoot?: string;
}

export interface RunOptions extends ResolveOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when the executable could not be spawned (ENOENT, EPERM, …). */
  spawnError: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const META_CHARS = /["'`;&|<>\r\n]/;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function hasLeadingDash(arg: string): boolean {
  return arg.length > 0 && arg.startsWith('-');
}

function safeSplit(command: string): string[] | null {
  const trimmed = command.trim();
  if (!trimmed || META_CHARS.test(trimmed)) return null;
  return trimmed.split(/\s+/).filter(Boolean);
}

function withinProjectPath(projectRoot: string, candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > 4096) return false;
  if (hasLeadingDash(candidate)) return false;
  const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(projectRoot, candidate);
  const rel = relative(projectRoot, resolved);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Returns true when every non-positional token (leading-dash) is in the
 * runner's allowlist. Positional arguments (paths, file globs, names)
 * pass through unfiltered; the caller is responsible for any further
 * sandboxing via `sanitizeRunnerPath`. When `allowedFlags === null` the
 * runner has opted out of a flag whitelist and the leading-dash check
 * is dropped — but callers should only opt out for languages whose
 * flags cannot be used as code-execution vectors (rare; almost always
 * prefer an explicit allowlist).
 */
function everyFlagAllowed(allowed: ReadonlySet<string> | null, args: readonly string[]): boolean {
  for (const arg of args) {
    if (!hasLeadingDash(arg)) continue;
    if (allowed === null) return false; // safer default
    if (!allowed.has(arg)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate `value` as a sandboxed path inside the project. Returns the
 * canonical absolute path on success, `null` on rejection (empty,
 * outside the project, leading-dash, or longer than 4096 bytes).
 */
export function sanitizeRunnerPath(
  value: string,
  options: ResolveOptions = {},
): string | null {
  if (!value || hasLeadingDash(value)) return null;
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  if (!withinProjectPath(projectRoot, value)) return null;
  return isAbsolute(value) ? resolve(value) : resolve(projectRoot, value);
}

/**
 * Resolve a user-supplied command string into an argv-style invocation
 * using the language runtime's allowlist. Returns `null` if the command
 * fails closed (unknown launcher, unknown subcommand, disallowed flag,
 * metacharacters, leading-dash injection, absolute-path escape).
 */
export function resolveRunnerCommand(
  runtime: LanguageRuntime,
  command: string,
  options: ResolveOptions = {},
): ResolvedCommand | null {
  const tokens = safeSplit(command);
  if (!tokens || tokens.length === 0) return null;
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const launcher = runtime.packageManager;
  const [head, second, ...rest] = tokens;
  if (!head) return null;
  const display = tokens.join(' ');

  // Bare launcher (`npx`, `pnpm`, `cargo`, `go`) is never allowed —
  // the runner executable must appear as the next token so a
  // launcher's own subcommand cannot be smuggled as argv.
  if (launcher !== 'none' && tokens.length === 1 && head === launcher) {
    return null;
  }

  // Path 1: explicit executable first token (no launcher). e.g. "tsc --noEmit",
  // "pytest -q", "vitest run".
  if (head === runtime.executable) {
    // second may be a flag (`tsc --noEmit --pretty`) or, for languages with
    // bare-executable spellings, a positional argument. We pass the entire
    // tail through everyFlagAllowed; positional args are exempt from the
    // allowlist check.
    if (!everyFlagAllowed(runtime.allowedFlags, [second, ...rest].filter((v): v is string => Boolean(v)))) {
      return null;
    }
    return {
      cmd: head,
      args: [second, ...rest].filter((v): v is string => Boolean(v)),
      display,
    };
  }

  // Path 2: launcher → executable (no subcommand). e.g. "npx vitest run",
  // "pnpm tsc --noEmit", "cargo test --release".
  if (
    launcher !== 'none' &&
    head === launcher &&
    runtime.subcommands.length === 0 &&
    second === runtime.executable
  ) {
    if (!everyFlagAllowed(runtime.allowedFlags, rest)) return null;
    return { cmd: head, args: [second, ...rest], display };
  }

  // Path 3: launcher → subcommand → executable. e.g. "pnpm exec vitest run",
  // "pnpm exec tsc --noEmit", "npm exec tsc --pretty".
  if (launcher !== 'none' && head === launcher && runtime.subcommands.length > 0) {
    const subcommand = runtime.subcommands[0]!;
    const exe = rest[0];
    if (second === subcommand && exe === runtime.executable) {
      const tail = rest.slice(1);
      if (!everyFlagAllowed(runtime.allowedFlags, tail)) return null;
      return { cmd: head, args: [second, exe!, ...tail], display };
    }
  }

  // Path 4: absolute-path launcher under the project.
  if (isAbsolute(head)) {
    if (!withinProjectPath(projectRoot, head)) return null;
    const base = basename(head);
    if (base !== runtime.executable && base !== launcher) return null;
    if (second !== runtime.executable) return null;
    if (!everyFlagAllowed(runtime.allowedFlags, rest)) return null;
    return { cmd: head, args: [second, ...rest], display };
  }

  return null;
}

/**
 * Spawn the resolved argv with `shell:false`. Always uses
 * `execFile` (no shell, argv), captures stdout/stderr with a hard
 * `maxBuffer`, and respects `signal` + `timeoutMs`. Plugins can layer
 * language-specific output parsing on top of `RunResult`.
 */
export function runRunnerCommand(
  argv: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  if (argv.length === 0) {
    return Promise.resolve({
      code: null,
      stdout: '',
      stderr: 'runtime helper: empty argv',
      timedOut: false,
      spawnError: true,
    });
  }
  return new Promise((resolvePromise) => {
    const projectRoot = resolve(options.projectRoot ?? process.cwd());
    const trimmedCwd = options.cwd.trim();
    if (!withinProjectPath(projectRoot, trimmedCwd)) {
      resolvePromise({
        code: null,
        stdout: '',
        stderr: 'runtime helper: cwd outside project',
        timedOut: false,
        spawnError: true,
      });
      return;
    }
    const timedOut = false;
    let spawnErrored = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const child = execFile(
      argv[0]!,
      argv.slice(1) as string[],
      {
        cwd: trimmedCwd,
        timeout: options.timeoutMs,
        signal: options.signal,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
        shell: false,
      },
      (err, stdout, stderr) => {
        if (timedOut) {
          resolvePromise({
            code: null,
            stdout: Buffer.concat([...stdoutChunks, ...(Buffer.isBuffer(stdout) ? [stdout] : [Buffer.from(stdout as string)])])
              .toString('utf8'),
            stderr: Buffer.concat([...stderrChunks, ...(Buffer.isBuffer(stderr) ? [stderr] : [Buffer.from(stderr as string)])])
              .toString('utf8'),
            timedOut: true,
            spawnError: false,
          });
          return;
        }
        if (spawnErrored) {
          resolvePromise({
            code: 127,
            stdout: Buffer.concat([...stdoutChunks, ...(Buffer.isBuffer(stdout) ? [stdout] : [Buffer.from(stdout as string)])])
              .toString('utf8'),
            stderr: Buffer.concat([...stderrChunks, ...(Buffer.isBuffer(stderr) ? [stderr] : [Buffer.from(stderr as string)])])
              .toString('utf8'),
            timedOut: false,
            spawnError: true,
          });
          return;
        }
        if (err) {
          const anyErr = err as NodeJS.ErrnoException & {
            stdout?: Buffer | string;
            stderr?: Buffer | string;
            code?: number | string;
          };
          const code = typeof anyErr.code === 'number' ? anyErr.code : 1;
          resolvePromise({
            code,
            stdout: Buffer.concat([
              ...stdoutChunks,
              ...(anyErr.stdout
                ? [Buffer.isBuffer(anyErr.stdout) ? anyErr.stdout : Buffer.from(anyErr.stdout)]
                : []),
            ]).toString('utf8'),
            stderr: Buffer.concat([
              ...stderrChunks,
              ...(anyErr.stderr
                ? [Buffer.isBuffer(anyErr.stderr) ? anyErr.stderr : Buffer.from(anyErr.stderr)]
                : []),
            ]).toString('utf8'),
            timedOut: false,
            spawnError: false,
          });
          return;
        }
        resolvePromise({
          code: 0,
          stdout: Buffer.concat([
            ...stdoutChunks,
            ...(Buffer.isBuffer(stdout) ? [stdout] : [Buffer.from(stdout as string)]),
          ]).toString('utf8'),
          stderr: Buffer.concat([
            ...stderrChunks,
            ...(Buffer.isBuffer(stderr) ? [stderr] : [Buffer.from(stderr as string)]),
          ]).toString('utf8'),
          timedOut: false,
          spawnError: false,
        });
      },
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_BUFFER_BYTES) stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_BUFFER_BYTES) stderrChunks.push(chunk);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'EPERM' || err.code === 'EACCES') {
        spawnErrored = true;
      }
    });
  });
}

/**
 * Cheap availability check. Calls the runner's `--version`-like command
 * with a short timeout; returns true only when exit code is zero.
 */
export async function probeRunner(
  runtime: LanguageRuntime,
  probeArg: string = '--version',
  options: RunOptions,
): Promise<boolean> {
  const resolved = resolveRunnerCommand(runtime, `${runtime.executable} ${probeArg}`, options);
  if (!resolved) return false;
  const result = await runRunnerCommand([resolved.cmd, ...resolved.args], {
    ...options,
    timeoutMs: Math.min(options.timeoutMs, 5_000),
  });
  return result.code === 0;
}

/**
 * Check whether a file path is inside the project root. Uses
 * `process.cwd()` as the project boundary. Returns `true` for valid
 * paths inside the project, `false` for empty, too-long, outside,
 * or absolute paths that escape.
 *
 * This is the canonical sandbox check that every file-mutating or
 * file-reading plugin should call before touching a path supplied
 * by tool input. It replaces 27 identical copies across plugins.
 */
export function withinProject(p: string): boolean {
  return withinProjectPath(process.cwd(), p) || relative(process.cwd(), p) === '.';
}

/**
 * Convenience: locate the runner binary on disk inside the project.
 * Returns the absolute path or `null`.
 */
export function locateRunnerEntry(
  runtime: LanguageRuntime,
  projectRoot: string,
): string | null {
  const root = resolve(projectRoot);
  const candidates = [
    resolve(root, 'node_modules', '.bin', runtime.executable),
    resolve(root, 'node_modules', '.bin', `${runtime.executable}.cmd`),
    resolve(root, 'node_modules', '.bin', `${runtime.executable}.ps1`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}
