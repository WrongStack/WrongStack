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
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';

import { buildChildEnv } from '@wrongstack/core/utils/child-env';

export {
  parseLlmJsonObject,
  runOptionalPluginCouncil,
  runOptionalPluginLlm,
  stripOuterMarkdownFence,
  type OptionalCouncilRequest,
  type OptionalLlmRequest,
  type OptionalLlmResult,
} from './llm.js';

import { resolveExecInvocation, type ExecInvocation } from './local-bin.js';

export { BoundedMap, BoundedSet, type BoundedMapOptions } from './bounded-map.js';
export {
  cloneCredentialPatterns,
  CREDENTIAL_PATTERNS,
  type CredentialPattern,
} from './credential-patterns.js';
export { UNSERIALIZABLE, safeJsonStringify } from './safe-json.js';
export { releaseHandle, releaseHandles, type Unregister } from './handles.js';
export {
  withReDoSGuard,
  guardedMatcher,
  type ReDoSResult,
  type ReDoSOptions,
} from './redos-guard.js';
export {
  safePath,
  isInsideProject,
  type SafePathOptions,
} from './sandbox.js';
export {
  createH1State,
  type H1State,
} from './h1-state.js';

export {
  clearLocalBinCache,
  findOnPath,
  resolveExecInvocation,
  resolveFirstNodeBin,
  resolveNodeBin,
  resolveWin32Command,
  type ExecInvocation,
  type ResolvedNodeBin,
} from './local-bin.js';

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
export function sanitizeRunnerPath(value: string, options: ResolveOptions = {}): string | null {
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
    if (
      !everyFlagAllowed(
        runtime.allowedFlags,
        [second, ...rest].filter((v): v is string => Boolean(v)),
      )
    ) {
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
export function runRunnerCommand(argv: readonly string[], options: RunOptions): Promise<RunResult> {
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
    let timedOut = false;
    let spawnErrored = false;
    // Wall-clock start for timeout disambiguation. execFile kills the
    // child with SIGTERM in three distinct cases (built-in timeout,
    // maxBuffer overflow, external signal); only the timeout case
    // elapses >= timeoutMs. Captured here so both the callback's
    // err-shape analysis and the exit handler can gate on it.
    const start = Date.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    // Wire the abort signal so the execFile callback can distinguish
    // timeout from other errors. The listener sets timedOut=true before
    // the callback fires because event-loop ordering guarantees the
    // 'abort' event listener runs before the execFile error callback
    // on the same scheduled microtask/macrotask boundary.
    const onAbort = () => {
      timedOut = true;
    };
    // Adjust the invocation for the host platform BEFORE spawning. Without
    // this, `argv[0]` values like `npx`/`pnpm`/`tsc` — which are `.cmd`
    // shims on Windows — fail ENOENT, and callers misread that as "the tool
    // is not installed". Every runtime-helper consumer was silently
    // no-opping on Windows.
    let invocation: ExecInvocation;
    try {
      invocation = resolveExecInvocation(argv[0]!, argv.slice(1) as string[]);
    } catch (err) {
      // Only thrown on the Windows shim path, for an argument carrying a
      // cmd.exe metacharacter. Refuse to run rather than risk injection.
      resolvePromise({
        code: null,
        stdout: '',
        stderr: `runtime helper: ${err instanceof Error ? err.message : String(err)}`,
        timedOut: false,
        spawnError: true,
      });
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const child = execFile(
      invocation.cmd,
      invocation.args,
      {
        cwd: trimmedCwd,
        // H-8 (security report VF-09): plugin subprocesses inherit the FULL
        // environment by default — every provider API key and the vault
        // passphrase were visible to any plugin exec(). Route through the
        // shared allowlist + secret-strip child env (operators can widen it
        // deliberately via WRONGSTACK_CHILD_ENV_PASSTHROUGH).
        env: buildChildEnv(),
        timeout: options.timeoutMs,
        signal: options.signal,
        maxBuffer: MAX_BUFFER_BYTES,
        // execFile defaults `encoding` to 'utf8', which makes the
        // stdout/stderr `data` events emit *strings*. The chunk arrays
        // below are typed Buffer[] and every consumer runs them through
        // Buffer.concat(...).toString('utf8'), which throws
        // ERR_INVALID_ARG_TYPE on any non-empty string output. Pin the
        // streams to buffers so the declared contract holds (regression:
        // runRunnerCommand crashed on any child that actually wrote
        // output; only the maxBuffer fixture exercised this path).
        encoding: 'buffer',
        windowsHide: true,
        shell: false,
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      },
      (err) => {
        // Drop the abort listener on every completion path. Without this, a
        // caller reusing one signal across many exec() calls leaks a listener
        // per call (the { once } only fires on abort, not normal completion).
        options.signal?.removeEventListener('abort', onAbort);
        if (timedOut) {
          resolvePromise({
            code: null,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            timedOut: true,
            spawnError: false,
          });
          return;
        }
        if (spawnErrored) {
          resolvePromise({
            code: 127,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
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
            killed?: boolean;
            signal?: string;
          };
          // execFile kills the child via SIGTERM in three distinct
          // cases — its built-in `timeout` option, maxBuffer overflow
          // (stderr/exec_buffer exceeded the 16 MiB cap), and an
          // external SIGTERM from the parent process. All three
          // produce an err shape with `killed: true` and
          // `signal: 'SIGTERM'`. The `signal === 'SIGTERM'` shape is
          // not enough on its own: only the elapsed-time + maxBuffer
          // disambiguation distinguishes the three. The 'exit'
          // event handler may set timedOut=true, but the callback
          // often fires first or concurrently, so the flag is
          // unreliable here — we derive the timeout answer from the
          // err shape directly. This is the structural fix for the
          // confirmed `timedOut` bug at line 347 (see
          // mem_01KXXKN8WYPCB6C2FJN61H823M).
          if (
            (anyErr.killed === true || anyErr.signal === 'SIGTERM') &&
            // maxBuffer overflow must NOT be misreported as a timeout
            // — it's a real failure (the child wrote too much) and
            // downstream callers (type-gate/index.ts:227) return
            // null on timedOut=true, which would silently swallow
            // maxBuffer overflow into a confusing empty-output
            // result. Skip the timeout resolve when the err shape
            // names maxBuffer explicitly.
            !/maxBuffer length exceeded/i.test(anyErr.message ?? '') &&
            // And only count it as a timeout if the wall clock has
            // actually elapsed past the budget. External SIGTERMs and
            // races against the exit handler don't satisfy this.
            Date.now() - start >= options.timeoutMs
          ) {
            resolvePromise({
              code: null,
              stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
              stderr: Buffer.concat(stderrChunks).toString('utf-8'),
              timedOut: true,
              spawnError: false,
            });
            return;
          }
          const code = typeof anyErr.code === 'number' ? anyErr.code : 1;
          resolvePromise({
            code,
            stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
            stderr: Buffer.concat(stderrChunks).toString('utf-8'),
            timedOut: false,
            spawnError: false,
          });
          return;
        }
        resolvePromise({
          code: 0,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          timedOut: false,
          spawnError: false,
        });
      },
    );
    // When execFile kills the child due to its built-in timeout, the
    // 'exit' event fires with a non-null signal before the callback.
    // Set timedOut so the callback's dead-code branch becomes live
    // and reports timedOut: true to the caller.
    child.on('exit', (_code, signal) => {
      // Only a genuine timeout kill sets the flag. maxBuffer overflow
      // and external SIGTERMs also produce a non-null signal, but both
      // happen well before timeoutMs elapses. Gating on elapsed time
      // keeps the callback's err-shape analysis (maxBuffer exclusion in
      // the err branch) authoritative instead of pre-empted by this
      // handler — otherwise maxBuffer kills resolve as timedOut:true.
      if (signal !== null && Date.now() - start >= options.timeoutMs) {
        timedOut = true;
      }
    });
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
 *
 * Performance: caches `process.cwd()` per call to avoid redundant
 * syscalls when checking multiple paths in the same tick.
 */
export function withinProject(p: string): boolean {
  const cwd = process.cwd();
  return withinProjectPath(cwd, p) || relative(cwd, p) === '.';
}

/**
 * Convenience: locate the runner binary on disk inside the project.
 * Returns the absolute path or `null`.
 */
export function locateRunnerEntry(runtime: LanguageRuntime, projectRoot: string): string | null {
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

// ---------------------------------------------------------------------------
// File-collection helpers (shared across multiple plugin source-scan tools)
// ---------------------------------------------------------------------------

export interface CollectOptions {
  /** File extensions to include (e.g. ['.ts', '.tsx', '.js']). */
  extensions: string[];
  /** Directory names to skip entirely. Default skips node_modules, dist, .git, coverage. */
  excludeDirs?: string[] | undefined;
  /** Maximum recursion depth. Unlimited when omitted. */
  maxDepth?: number | undefined;
}

const DEFAULT_EXCLUDE_DIRS = ['node_modules', 'dist', '.git', 'coverage'];

/**
 * Recursively collect files under `root` whose extension is in
 * `opts.extensions`. Skips directories named in `opts.excludeDirs`
 * (defaulting to node_modules, dist, .git, coverage) and limits depth
 * when `opts.maxDepth` is set.
 *
 * Shared by 6+ plugin source-scan tools that previously duplicated
 * this implementation identically.
 *
 * Determinism: returns files in sorted order (locale-aware) so
 * scan results are reproducible across platforms and file systems.
 */
export function collectSourceFiles(root: string, opts: CollectOptions): string[] {
  const files: string[] = [];
  if (!existsSync(root)) return files;
  const s = statSync(root);
  if (s.isFile()) {
    if (matchesExtension(root, opts.extensions)) files.push(root);
    return files;
  }
  if (!s.isDirectory()) return files;
  const exclude = opts.excludeDirs ?? DEFAULT_EXCLUDE_DIRS;
  const excludeSet = new Set(exclude); // O(1) lookup instead of O(n) includes()

  function walk(dir: string, depth: number) {
    if (opts.maxDepth !== undefined && depth > opts.maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    // Sort entries for deterministic traversal order across platforms.
    entries.sort();
    for (const entry of entries) {
      if (excludeSet.has(entry)) continue;
      const full = resolve(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else if (st.isFile() && matchesExtension(full, opts.extensions)) {
        files.push(full);
      }
    }
  }

  walk(root, 0);
  return files;
}

/**
 * Async version of `collectSourceFiles` for non-blocking file collection.
 * Uses `fs.promises` to avoid blocking the event loop on large directory trees.
 *
 * Performance: prefer this in hooks and tools that run on every write/edit
 * (e.g., duplicate-code-detector) to keep the agent loop responsive during
 * large scans.
 */
export async function collectSourceFilesAsync(
  root: string,
  opts: CollectOptions,
): Promise<string[]> {
  const { readdir, stat } = await import('node:fs/promises');
  const files: string[] = [];

  try {
    const s = await stat(root);
    if (s.isFile()) {
      if (matchesExtension(root, opts.extensions)) files.push(root);
      return files;
    }
    if (!s.isDirectory()) return files;
  } catch {
    return files;
  }

  const exclude = opts.excludeDirs ?? DEFAULT_EXCLUDE_DIRS;
  const excludeSet = new Set(exclude);

  async function walk(dir: string, depth: number): Promise<void> {
    if (opts.maxDepth !== undefined && depth > opts.maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name)); // deterministic order
    for (const entry of entries) {
      if (excludeSet.has(entry.name)) continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && matchesExtension(full, opts.extensions)) {
        files.push(full);
      }
    }
  }

  await walk(root, 0);
  return files;
}

/**
 * Check whether `p` has one of the given extensions (case-insensitive).
 * Handles extensions with or without a leading dot and normalizes casing/whitespace.
 * Replaces a 6-copy helper that was duplicated identically across
 * source-scan plugins.
 */
export function matchesExtension(p: string, exts: string[]): boolean {
  const fileExt = extname(p).toLowerCase();
  if (!fileExt) return false;
  return exts.some((ext) => {
    if (!ext || typeof ext !== 'string') return false;
    const trimmed = ext.trim().toLowerCase();
    const normalized = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
    return normalized === fileExt;
  });
}
