/**
 * VerificationContext — the execution environment available to every verifier.
 *
 * Provides deterministic filesystem, git, command, and test runner access.
 * Every method returns concrete structured data — never opens an LLM channel.
 *
 * The `requireBackingEvidence` flag controls whether escalation verifiers
 * (agent, council) must produce concrete proof. Always true in this system.
 *
 * ── Command Security ─────────────────────────────────────────────────────────
 * All shell commands are validated against a base-command allowlist and a
 * shell-operator regex before execution. The allowlist permits only read-only
 * inspection commands by default. Shell operators (&&, ||, ;,
 * |, &, >, <, backticks, $(), newline, carriage return) are rejected entirely
 * in `runCommand` to prevent chaining additional operations past the intended
 * command.
 *
 * NOTE: The allowlist is a **base-command gate** — it checks only the first
 * token. Package managers, shells, interpreters, compilers, and git are absent
 * because each can execute arbitrary code even without a shell operator.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { KanbanBoard, KanbanTask } from '../types.js';
import {
  BoundedProcessOutput,
  buildAllowlist,
  type CommandAllowlistConfig,
  DEFAULT_ALLOWED_COMMANDS,
  DEFAULT_BLOCKED_COMMANDS,
  extractBaseCommand,
  MAX_PROCESS_OUTPUT_BYTES,
  normalizeBaseCommand,
  parseCommandArguments,
  SHELL_OPERATOR_RE,
  validateCommand,
} from './command-security.js';
import { parseGitNameStatus, parseGitNumstat, tryParseTestJson } from './test-output-parser.js';

export {
  BoundedProcessOutput,
  type CommandAllowlistConfig,
  DEFAULT_ALLOWED_COMMANDS,
  DEFAULT_BLOCKED_COMMANDS,
  extractBaseCommand,
  MAX_PROCESS_OUTPUT_BYTES,
  normalizeBaseCommand,
  parseCommandArguments,
  parseGitNameStatus,
  parseGitNumstat,
  SHELL_OPERATOR_RE,
  validateCommand,
};

// ─── Tree / Diff / Result Types ────────────────────────────────────────────

/** A snapshot of the git working tree at a point in time. */
export interface TreeSnapshot {
  id: string;
  capturedAt: string;
  /** The `git rev-parse HEAD` hash at capture time, empty for an unborn repository. */
  commitHash: string;
  /** Git tree containing the complete tracked and untracked worktree baseline. */
  treeHash: string;
}

/** A single file diff entry. */
export interface FileDiffEntry {
  path: string;
  operation: 'create' | 'modify' | 'delete';
  linesAdded: number;
  linesRemoved: number;
}

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** When true, the command was rejected by the security gate before execution. */
  rejected?: boolean | undefined;
}

export interface TestResult {
  testPattern: string;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  /** Truncated failure output when tests fail. */
  failureOutput?: string | undefined;
}

export interface GitStatusResult {
  clean: boolean;
  untracked: number;
  unstaged: number;
  staged: number;
  files: string[];
  error?: string | undefined;
}

interface TestRunnerInvocation {
  command: string;
  args: string[];
  kind: 'vitest' | 'jest';
}

// ─── VerificationContext ───────────────────────────────────────────────────

export class VerificationContext {
  readonly projectRoot: string;
  readonly board: KanbanBoard;
  readonly task: KanbanTask;
  /** When true, agent/council verifiers must produce concrete proof. */
  readonly requireBackingEvidence = true;

  /** Resolved command allowlist/blocklist sets. */
  private readonly cmdAllow: Set<string>;
  private readonly cmdBlock: Set<string>;
  private readonly cmdAllowAll: boolean;

  /** Optional pre-execution git snapshot for diff comparison. */
  private snapshot: TreeSnapshot | null = null;

  constructor(opts: {
    projectRoot: string;
    board: KanbanBoard;
    task: KanbanTask;
    /** Optional command allowlist configuration. Extends the defaults. */
    commandAllowlist?: CommandAllowlistConfig | undefined;
  }) {
    this.projectRoot = opts.projectRoot;
    this.board = opts.board;
    this.task = opts.task;

    const allowlist = buildAllowlist(opts.commandAllowlist);
    this.cmdAllow = allowlist.allow;
    this.cmdBlock = allowlist.block;
    this.cmdAllowAll = opts.commandAllowlist?.allowAll ?? false;
  }

  // ---------------------------------------------------------------------------
  // Git helpers
  // ---------------------------------------------------------------------------

  /** Capture the complete tracked and untracked worktree state for later comparison. */
  async captureSnapshot(): Promise<TreeSnapshot> {
    let commitHash = '';
    try {
      const { stdout } = await this.runGitCommand(['rev-parse', 'HEAD']);
      commitHash = stdout.trim();
    } catch {
      // Unborn repositories have no HEAD but can still produce a worktree tree.
    }
    let treeHash = '';
    try {
      treeHash = await this.captureWorktreeTree(commitHash);
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'verification_snapshot_capture_failed',
          message: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        }),
      );
    }
    const snapshot: TreeSnapshot = {
      id: randomUUID(),
      capturedAt: new Date().toISOString(),
      commitHash,
      treeHash,
    };
    this.snapshot = snapshot;
    return snapshot;
  }

  /** Compute the worktree diff since the captured snapshot. */
  async diffSince(_snapshot?: TreeSnapshot): Promise<FileDiffEntry[]> {
    const useSnapshot = _snapshot ?? this.snapshot;
    if (!useSnapshot || !/^[0-9a-f]{40,64}$/.test(useSnapshot.treeHash)) return [];
    try {
      const currentTree = await this.captureWorktreeTree();
      const [numstat, nameStatus] = await Promise.all([
        this.runGitCommand([
          'diff',
          '--no-renames',
          '--numstat',
          useSnapshot.treeHash,
          currentTree,
        ]),
        this.runGitCommand([
          'diff',
          '--no-renames',
          '--name-status',
          useSnapshot.treeHash,
          currentTree,
        ]),
      ]);
      return parseGitNumstat(numstat.stdout, parseGitNameStatus(nameStatus.stdout));
    } catch {
      return [];
    }
  }

  /**
   * Read-only view of the captured baseline snapshot, or null when no
   * snapshot has been taken yet. Lets the completion protocol bind the
   * verification report to the git baseline its file-scope diff was measured
   * against, without exposing the mutable setter.
   */
  get capturedSnapshot(): TreeSnapshot | null {
    return this.snapshot;
  }

  /** Get a full diff (unified format) for a set of files. */
  async gitDiffForFiles(filePaths: string[]): Promise<string> {
    if (filePaths.length === 0) return '';
    try {
      const { stdout } = await this.runGitCommand(['diff', 'HEAD', '--', ...filePaths]);
      return stdout;
    } catch {
      return '';
    }
  }

  /** Get the working tree status. */
  async gitStatus(): Promise<GitStatusResult> {
    try {
      const { stdout } = await this.runGitCommand(['status', '--porcelain']);
      const lines = stdout.split('\n').filter((l) => l.trim());
      const untracked = lines.filter((l) => l.startsWith('??')).length;
      const unstaged = lines.filter((l) => /^.[^ ]/.test(l) && !l.startsWith('??')).length;
      const staged = lines.filter((l) => /^[^ ]/.test(l) && !l.startsWith('??')).length;
      const files = lines.map((l) => l.slice(3).trim()).filter(Boolean);
      return {
        clean: lines.length === 0,
        untracked,
        unstaged,
        staged,
        files,
      };
    } catch (err) {
      return {
        clean: false,
        untracked: 0,
        unstaged: 0,
        staged: 0,
        files: [],
        error: `Unable to read git status: ${(err as Error).message}`,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Filesystem helpers
  // ---------------------------------------------------------------------------

  /** Read a file relative to project root. */
  async readFile(filePath: string): Promise<string> {
    const resolved = await this.resolveProjectPath(filePath);
    if (!resolved) throw new Error(`Path escapes the project root: ${filePath}`);
    return fsp.readFile(resolved, 'utf8');
  }

  /** Check if a file exists relative to project root. */
  async fileExists(filePath: string): Promise<boolean> {
    const resolved = await this.resolveProjectPath(filePath);
    if (!resolved) return false;
    try {
      await fsp.access(resolved);
      return true;
    } catch {
      return false;
    }
  }

  /** Stat a file (size, mtime). */
  async fileStat(filePath: string): Promise<{ exists: boolean; size: number; mtime: string }> {
    const resolved = await this.resolveProjectPath(filePath);
    if (!resolved) return { exists: false, size: 0, mtime: '' };
    try {
      const stat = await fsp.stat(resolved);
      return {
        exists: true,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      };
    } catch {
      return { exists: false, size: 0, mtime: '' };
    }
  }

  // ---------------------------------------------------------------------------
  // Command runner
  // ---------------------------------------------------------------------------

  /** Run one of the verifier's read-only commands.
   *
   * This path never opens a shell. It supports exact `pwd`, `true`, `false`,
   * and `test -e|-f|-d <project-relative-path>` forms. Commands admitted by
   * `allowedCommands` or `allowAll` are tokenized into an executable plus argv
   * and spawned directly; the blocklist and shell-operator gate still apply. */
  async runCommand(
    command: string,
    opts?: {
      cwd?: string;
      timeoutMs?: number;
      allowShellOperators?: boolean;
    },
  ): Promise<CommandResult> {
    const start = Date.now();

    // ── Command Security Gate ──────────────────────────────────────────────
    const validationError = validateCommand(command, {
      allow: this.cmdAllow,
      block: this.cmdBlock,
      allowAll: this.cmdAllowAll,
      allowShellOperators: opts?.allowShellOperators ?? false,
    });
    if (validationError !== null) {
      return {
        command,
        exitCode: -1,
        stdout: '',
        stderr: validationError,
        durationMs: Date.now() - start,
        rejected: true,
      };
    }

    if (opts?.cwd && path.resolve(opts.cwd) !== path.resolve(this.projectRoot)) {
      return this.rejectedCommand(
        command,
        start,
        'Verifier commands must run at the project root.',
      );
    }

    const tokens = parseCommandArguments(command);
    if (typeof tokens === 'string') return this.rejectedCommand(command, start, tokens);
    const base = tokens[0] ?? '';
    if ((base === 'pwd' || base === 'true' || base === 'false') && tokens.length === 1) {
      return {
        command,
        exitCode: base === 'false' ? 1 : 0,
        stdout: base === 'pwd' ? `${this.projectRoot}\n` : '',
        stderr: '',
        durationMs: Date.now() - start,
      };
    }
    if (base === 'test' && tokens.length === 3 && ['-e', '-f', '-d'].includes(tokens[1] ?? '')) {
      const resolved = await this.resolveProjectPath(tokens[2] ?? '');
      if (!resolved) {
        return this.rejectedCommand(command, start, 'Test path must stay inside the project root.');
      }
      try {
        const stat = await fsp.stat(resolved);
        const matches =
          tokens[1] === '-e' || (tokens[1] === '-f' ? stat.isFile() : stat.isDirectory());
        return {
          command,
          exitCode: matches ? 0 : 1,
          stdout: '',
          stderr: '',
          durationMs: Date.now() - start,
        };
      } catch {
        return { command, exitCode: 1, stdout: '', stderr: '', durationMs: Date.now() - start };
      }
    }

    const normalizedBase = normalizeBaseCommand(base);
    const isConfiguredCommand =
      this.cmdAllowAll ||
      (this.cmdAllow.has(normalizedBase) &&
        !DEFAULT_ALLOWED_COMMANDS.some(
          (allowed) => normalizeBaseCommand(allowed) === normalizedBase,
        ));
    if (isConfiguredCommand) {
      const [executable, ...args] = tokens;
      if (!executable) return this.rejectedCommand(command, start, 'Empty command.');
      const resolved = await this.resolveConfiguredExecutable(executable);
      const result = await this.runProcess(resolved.command, [...resolved.args, ...args], {
        cwd: this.projectRoot,
        // Configured commands are typically build/verify tools (tsc, linters)
        // that legitimately take minutes — match the test runner's budget.
        timeoutMs: opts?.timeoutMs ?? 180_000,
        shell: resolved.shell,
      });
      return { ...result, command };
    }

    return this.rejectedCommand(command, start, 'Unsupported verifier command shape.');
  }

  // ---------------------------------------------------------------------------
  // Test runner
  // ---------------------------------------------------------------------------

  /** Run a test pattern (vitest or jest) and return structured results. */
  async runTest(pattern: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<TestResult> {
    const start = Date.now();

    // Reserve all leading-hyphen patterns for a future CLI-extension safety contract.
    if (pattern.includes('\0') || pattern.trimStart().startsWith('-')) {
      return {
        testPattern: pattern,
        passed: 0,
        failed: 1,
        skipped: 0,
        durationMs: Date.now() - start,
        failureOutput: pattern.includes('\0')
          ? 'Test pattern contains a null byte and was rejected.'
          : 'Test pattern must not start with an option prefix.',
      };
    }

    const cwd = opts?.cwd ?? this.projectRoot;
    const timeoutMs = opts?.timeoutMs ?? 180_000;
    const runner = await this.detectTestRunner(cwd);
    if (!runner) {
      return {
        testPattern: pattern,
        passed: 0,
        failed: 1,
        skipped: 0,
        durationMs: Date.now() - start,
        failureOutput: 'No local Vitest or Jest executable was found.',
      };
    }

    const runnerArgs =
      runner.kind === 'vitest'
        ? [...runner.args, 'run', pattern, '--reporter=json']
        : [...runner.args, pattern, '--json'];
    const result = await this.runProcess(runner.command, runnerArgs, { cwd, timeoutMs });

    const parsed = tryParseTestJson(result.stdout, pattern);
    if (parsed) {
      const failed = result.exitCode !== 0 && parsed.failed === 0 ? 1 : parsed.failed;
      return {
        ...parsed,
        failed,
        durationMs: Date.now() - start,
        failureOutput:
          result.exitCode !== 0
            ? result.stderr.slice(0, 2000) || result.stdout.slice(0, 2000)
            : undefined,
      };
    }

    const passMatch = result.stdout.match(/(\d+)\s+passed/);
    const failMatch = result.stdout.match(/(\d+)\s+failed/);
    return {
      testPattern: pattern,
      passed: passMatch ? parseInt(passMatch[1]!, 10) : 0,
      failed: failMatch ? parseInt(failMatch[1]!, 10) : result.exitCode === 0 ? 0 : 1,
      skipped: 0,
      durationMs: Date.now() - start,
      failureOutput:
        result.exitCode !== 0
          ? result.stderr.slice(0, 2000) || result.stdout.slice(0, 2000)
          : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private rejectedCommand(command: string, start: number, reason: string): CommandResult {
    return {
      command,
      exitCode: -1,
      stdout: '',
      stderr: reason,
      durationMs: Date.now() - start,
      rejected: true,
    };
  }

  private async resolveProjectPath(filePath: string): Promise<string | null> {
    if (path.isAbsolute(filePath)) return null;
    const root = await fsp.realpath(this.projectRoot);
    const candidate = path.resolve(root, filePath);
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    try {
      const real = await fsp.realpath(candidate);
      const realRelative = path.relative(root, real);
      return realRelative.startsWith('..') || path.isAbsolute(realRelative) ? null : real;
    } catch {
      const parent = await fsp.realpath(path.dirname(candidate)).catch(() => null);
      if (!parent) return null;
      const parentRelative = path.relative(root, parent);
      return parentRelative.startsWith('..') || path.isAbsolute(parentRelative) ? null : candidate;
    }
  }

  /** Materialize the worktree with a temporary alternate index, leaving the real index untouched. */
  private async captureWorktreeTree(head = ''): Promise<string> {
    const indexPath = path.join(tmpdir(), `.verification-index-${randomUUID()}`);
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    try {
      if (head) await this.runGitCommand(['read-tree', head], 30_000, env);
      await this.runGitCommand(['add', '--all', '--', '.', ':(exclude).temp_files'], 30_000, env);
      const { stdout } = await this.runGitCommand(['write-tree'], 30_000, env);
      return stdout.trim();
    } finally {
      await Promise.all([
        fsp.rm(indexPath, { force: true }),
        fsp.rm(`${indexPath}.lock`, { force: true }),
      ]);
    }
  }

  /** Best-effort process-tree termination for children spawned by this context. */
  private terminateProcessTree(child: ChildProcess, detachedProcessGroup: boolean): void {
    const pid = child.pid;
    if (typeof pid === 'number' && process.platform === 'win32') {
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        const forceKillChild = (): void => {
          try {
            child.kill('SIGKILL');
          } catch {
            // The process already exited.
          }
        };
        killer.once('error', forceKillChild);
        killer.once('close', (code) => {
          if (code !== 0) forceKillChild();
        });
        killer.unref();
        return;
      } catch {
        // Fall through to direct termination.
      }
    }
    try {
      if (typeof pid === 'number' && detachedProcessGroup) {
        process.kill(-pid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      try {
        child.kill('SIGKILL');
      } catch (error) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'verification_process_termination_failed',
            message: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
  }

  private async runGitCommand(
    args: string[],
    timeoutMs = 30_000,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const detachedProcessGroup = process.platform !== 'win32';
      const child = spawn('git', args, {
        cwd: this.projectRoot,
        env,
        windowsHide: true,
        detached: detachedProcessGroup,
      });
      const stdout = new BoundedProcessOutput();
      const stderr = new BoundedProcessOutput();
      let settled = false;

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout.append(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr.append(chunk);
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.terminateProcessTree(child, detachedProcessGroup);
        reject(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code === 0) resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
        else reject(new Error(`git ${args.join(' ')} failed: ${stderr.toString().slice(0, 500)}`));
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
  }

  /**
   * Spawn a trusted local test runner with an argument array. This private
   * helper is never exposed as a model-selected executable surface.
   */
  private async runProcess(
    command: string,
    args: string[],
    opts: { cwd: string; timeoutMs: number; shell?: boolean | undefined },
  ): Promise<CommandResult> {
    const start = Date.now();
    const displayCommand = [command, ...args].join(' ');
    return new Promise<CommandResult>((resolve) => {
      const detachedProcessGroup = process.platform !== 'win32';
      const child = spawn(command, args, {
        cwd: opts.cwd,
        shell: opts.shell ?? false,
        windowsHide: true,
        detached: detachedProcessGroup,
      });
      const stdout = new BoundedProcessOutput();
      const stderr = new BoundedProcessOutput();
      let timedOut = false;
      let settled = false;

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout.append(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr.append(chunk);
      });

      let timer: NodeJS.Timeout | undefined;
      const finish = (exitCode: number, suffix = ''): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({
          command: displayCommand,
          exitCode,
          stdout: stdout.toString(),
          stderr: `${stderr.toString()}${suffix}`,
          durationMs: Date.now() - start,
        });
      };

      timer = setTimeout(() => {
        timedOut = true;
        this.terminateProcessTree(child, detachedProcessGroup);
        finish(-1, `\n--- timed out after ${opts.timeoutMs}ms ---`);
      }, opts.timeoutMs);

      child.on('close', (code) => {
        finish(
          timedOut ? -1 : (code ?? -1),
          timedOut ? `\n--- timed out after ${opts.timeoutMs}ms ---` : '',
        );
      });
      child.on('error', () => {
        finish(
          -1,
          timedOut ? `\n--- timed out after ${opts.timeoutMs}ms ---` : '\n--- spawn error ---',
        );
      });
    });
  }

  /**
   * Resolve an allowlisted base command to something spawn can execute.
   * Bare tokens like `tsc` are not executables — they are npm bin shims.
   * Resolution order mirrors detectTestRunner:
   *   1. Local package bin (`<base>/package.json` `bin` entry): JS entries
   *      run under this process's node (fully cross-platform, no shell);
   *      native binaries spawn directly.
   *   2. node_modules/.bin shims. POSIX shebang scripts spawn directly.
   *      Windows `.cmd` shims require cmd.exe, so they spawn with
   *      `shell: true`. Node emits DEP0190 for args+shell (args are
   *      concatenated, not escaped) — acceptable here only because the
   *      caller's command already passed the operator/expansion gates, so
   *      no `& | ; < > ` $() %..% $VAR !..!` can reach the shell, and cmd
   *      only ever receives the resolved absolute shim path plus gated
   *      args.
   *   3. The raw token (POSIX PATH lookup).
   */
  private async resolveConfiguredExecutable(
    base: string,
  ): Promise<{ command: string; args: string[]; shell?: boolean }> {
    // 1. Local package bin, e.g. `vitest` → vitest/bin/vitest.js under node.
    try {
      const req = createRequire(path.join(this.projectRoot, 'package.json'));
      const pkgJsonPath = req.resolve(`${base}/package.json`);
      const pkg = JSON.parse(await fsp.readFile(pkgJsonPath, 'utf8')) as {
        bin?: string | Record<string, string>;
      };
      const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[base];
      if (rel && !path.isAbsolute(rel)) {
        const packageDir = path.dirname(pkgJsonPath);
        const entry = path.resolve(packageDir, rel);
        if (!path.relative(packageDir, entry).startsWith('..')) {
          await fsp.access(entry);
          const isJsEntry = /\.(?:c|m)?js$/.test(entry);
          return isJsEntry
            ? { command: process.execPath, args: [entry] }
            : { command: entry, args: [] };
        }
      }
    } catch {
      // Not a locally installed package — fall through to the .bin shims.
    }
    // 2. node_modules/.bin shims (.cmd first on Windows — the extensionless
    // shims some package managers also create cannot spawn without a shell).
    const binShim = path.join(this.projectRoot, 'node_modules', '.bin', base);
    if (process.platform === 'win32') {
      const cmdShim = `${binShim}.cmd`;
      try {
        await fsp.access(cmdShim);
        return { command: cmdShim, args: [], shell: true };
      } catch {
        // fall through
      }
    }
    try {
      await fsp.access(binShim);
      return { command: binShim, args: [] };
    } catch {
      // fall through
    }
    // 3. Raw token — resolved by PATH on POSIX.
    return { command: base, args: [] };
  }

  private async detectTestRunner(cwd: string): Promise<TestRunnerInvocation | null> {
    let preferred: 'vitest' | 'jest' = 'vitest';
    try {
      const pkg = await fsp.readFile(path.join(cwd, 'package.json'), 'utf8');
      const json = JSON.parse(pkg) as Record<string, unknown>;
      const scripts = json['scripts'];
      const testScript =
        typeof scripts === 'object' && scripts !== null
          ? (scripts as Record<string, unknown>)['test']
          : undefined;
      if (typeof testScript === 'string' && testScript.includes('jest')) preferred = 'jest';
    } catch {
      // Fall back to Vitest discovery below.
    }

    const candidates: Array<'vitest' | 'jest'> =
      preferred === 'jest' ? ['jest', 'vitest'] : ['vitest', 'jest'];
    let requireFromProject: ReturnType<typeof createRequire>;
    try {
      requireFromProject = createRequire(path.resolve(cwd, 'package.json'));
    } catch {
      return null;
    }
    for (const runner of candidates) {
      try {
        const packageJsonPath = requireFromProject.resolve(`${runner}/package.json`);
        const packageJson = JSON.parse(await fsp.readFile(packageJsonPath, 'utf8')) as {
          bin?: string | Record<string, string>;
        };
        const relativeBin =
          typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.[runner];
        if (!relativeBin || path.isAbsolute(relativeBin)) continue;
        const packageDir = path.dirname(packageJsonPath);
        const entry = path.resolve(packageDir, relativeBin);
        if (path.relative(packageDir, entry).startsWith('..')) continue;
        await fsp.access(entry);
        return { command: process.execPath, args: [entry], kind: runner };
      } catch {
        // Try the next locally installed runner. Never download one during verification.
      }
    }
    return null;
  }
}
