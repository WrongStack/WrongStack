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
import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { KanbanBoard, KanbanTask, KanbanVerificationBaseline } from '../types.js';
import {
  BoundedProcessOutput,
  buildAllowlist,
  type CommandAllowlistConfig,
  commandAllowlistFromEnv,
  DEFAULT_ALLOWED_COMMANDS,
  DEFAULT_BLOCKED_COMMANDS,
  extractBaseCommand,
  MAX_PROCESS_OUTPUT_BYTES,
  normalizeBaseCommand,
  parseCommandArguments,
  parseConstrainedPnpmExec,
  SHELL_OPERATOR_RE,
  VERIFIER_COMMANDS_ENV,
  validateCommand,
} from './command-security.js';
import { parseGitNameStatus, parseGitNumstat, tryParseTestJson } from './test-output-parser.js';
import {
  detectTestRunner,
  resolveConfiguredExecutable,
  resolveProjectPath,
} from './verification-executables.js';
import { type CommandResult, VerificationProcessRunner } from './verification-process.js';

export type { CommandResult } from './verification-process.js';

export {
  BoundedProcessOutput,
  type CommandAllowlistConfig,
  commandAllowlistFromEnv,
  DEFAULT_ALLOWED_COMMANDS,
  DEFAULT_BLOCKED_COMMANDS,
  extractBaseCommand,
  MAX_PROCESS_OUTPUT_BYTES,
  normalizeBaseCommand,
  parseCommandArguments,
  parseConstrainedPnpmExec,
  parseGitNameStatus,
  parseGitNumstat,
  SHELL_OPERATOR_RE,
  VERIFIER_COMMANDS_ENV,
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
  private readonly processRunner: VerificationProcessRunner;

  constructor(opts: {
    projectRoot: string;
    board: KanbanBoard;
    task: KanbanTask;
    /** Optional pre-captured git snapshot for diff comparison. */
    snapshot?:
      | TreeSnapshot
      | KanbanVerificationBaseline
      | { id: string; capturedAt: string; commitHash?: string; treeHash?: string }
      | null
      | undefined;
    /** Optional command allowlist configuration. Extends the defaults. */
    commandAllowlist?: CommandAllowlistConfig | undefined;
  }) {
    this.projectRoot = opts.projectRoot;
    this.processRunner = new VerificationProcessRunner(opts.projectRoot);
    this.board = opts.board;
    this.task = opts.task;
    this.snapshot = opts.snapshot?.treeHash
      ? {
          id: opts.snapshot.id,
          capturedAt: opts.snapshot.capturedAt,
          commitHash: opts.snapshot.commitHash ?? '',
          treeHash: opts.snapshot.treeHash,
        }
      : null;

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
          '-z',
          useSnapshot.treeHash,
          currentTree,
        ]),
        this.runGitCommand([
          'diff',
          '--no-renames',
          '--name-status',
          '-z',
          useSnapshot.treeHash,
          currentTree,
        ]),
      ]);
      return parseGitNumstat(numstat.stdout, parseGitNameStatus(nameStatus.stdout));
    } catch (error) {
      throw new Error(
        `Unable to compute verification Git diff: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
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
      const { stdout } = await this.runGitCommand([
        'diff',
        // A diff driver or textconv the repository assigns runs on patch output.
        '--no-ext-diff',
        '--no-textconv',
        'HEAD',
        '--',
        ...filePaths,
      ]);
      return stdout;
    } catch {
      return '';
    }
  }

  /** Get the working tree status. */
  async gitStatus(): Promise<GitStatusResult> {
    try {
      // -z: raw paths (the line form C-quotes non-ASCII ones and prints a
      // rename as "old -> new"); a rename/copy record is followed by its
      // original path. Output without NULs is still read line by line.
      const { stdout } = await this.runGitCommand(['status', '--porcelain', '-z']);
      let lines: string[];
      let files: string[];
      if (stdout.includes('\0')) {
        lines = [];
        files = [];
        const fields = stdout.split('\0');
        for (let index = 0; index < fields.length; index += 1) {
          const record = fields[index] ?? '';
          if (record.length < 4) continue;
          lines.push(record);
          files.push(record.slice(3));
          if (/^(?:[RC]|.[RC])/.test(record)) index += 1;
        }
      } else {
        lines = stdout.split('\n').filter((l) => l.trim());
        files = lines.map((l) => l.slice(3).trim()).filter(Boolean);
      }
      const untracked = lines.filter((l) => l.startsWith('??')).length;
      const unstaged = lines.filter((l) => /^.[^ ]/.test(l) && !l.startsWith('??')).length;
      const staged = lines.filter((l) => /^[^ ]/.test(l) && !l.startsWith('??')).length;
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
    const resolved = await resolveProjectPath(this.projectRoot, filePath);
    if (!resolved) throw new Error(`Path escapes the project root: ${filePath}`);
    return fsp.readFile(resolved, 'utf8');
  }

  /** Check if a file exists relative to project root. */
  async fileExists(filePath: string): Promise<boolean> {
    const resolved = await resolveProjectPath(this.projectRoot, filePath);
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
    const resolved = await resolveProjectPath(this.projectRoot, filePath);
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
    },
  ): Promise<CommandResult> {
    const start = Date.now();

    // ── Command Security Gate ──────────────────────────────────────────────
    const validationError = validateCommand(command, {
      allow: this.cmdAllow,
      block: this.cmdBlock,
      allowAll: this.cmdAllowAll,
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
    const constrainedPnpmExec = parseConstrainedPnpmExec(tokens);
    if (typeof constrainedPnpmExec === 'object' && constrainedPnpmExec !== null) {
      const resolved = await resolveConfiguredExecutable(
        this.projectRoot,
        constrainedPnpmExec.executable,
        true,
      );
      if (!resolved) {
        return this.rejectedCommand(
          command,
          start,
          `Constrained "pnpm exec" requires a locally installed ${constrainedPnpmExec.executable} binary.`,
        );
      }
      const result = await this.runProcess(
        resolved.command,
        [...resolved.args, ...constrainedPnpmExec.args],
        { cwd: this.projectRoot, timeoutMs: opts?.timeoutMs ?? 180_000, shell: resolved.shell },
      );
      return { ...result, command };
    }

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
      const resolved = await resolveProjectPath(this.projectRoot, tokens[2] ?? '');
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
      const resolved = await resolveConfiguredExecutable(this.projectRoot, executable);
      if (!resolved)
        return this.rejectedCommand(command, start, `Could not resolve ${executable}.`);
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
    const runner = await detectTestRunner(cwd);
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

    // Vitest 5's json reporter writes `.vitest/json/output.json` and prints only
    // "JSON report written to …": stdout never parsed, a passing run read as
    // 0 passed / 0 failed and the test check failed with "No tests ran". Have
    // it write the report to a file we own (`--outputFile.json`) and read that.
    const reportFile =
      runner.kind === 'vitest'
        ? path.join(tmpdir(), `.verification-vitest-${randomUUID()}.json`)
        : undefined;
    const runnerArgs =
      runner.kind === 'vitest'
        ? [...runner.args, 'run', pattern, '--reporter=json', `--outputFile.json=${reportFile}`]
        : [...runner.args, pattern, '--json'];
    const result = await this.runProcess(runner.command, runnerArgs, { cwd, timeoutMs });
    const report = reportFile
      ? await fsp.readFile(reportFile, 'utf8').catch(() => undefined)
      : undefined;
    if (reportFile) await fsp.rm(reportFile, { force: true }).catch(() => undefined);

    const parsed = tryParseTestJson(report ?? result.stdout, pattern);
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
    const reportedFailed = failMatch ? parseInt(failMatch[1]!, 10) : 0;
    return {
      testPattern: pattern,
      passed: passMatch ? parseInt(passMatch[1]!, 10) : 0,
      failed: result.exitCode !== 0 && reportedFailed === 0 ? 1 : reportedFailed,
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
  private runGitCommand(
    args: string[],
    timeoutMs = 30_000,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<{ stdout: string; stderr: string }> {
    return this.processRunner.runGitCommand(args, timeoutMs, env);
  }

  private runProcess(
    command: string,
    args: string[],
    opts: { cwd: string; timeoutMs: number; shell?: boolean | undefined },
  ): Promise<CommandResult> {
    return this.processRunner.runProcess(command, args, opts);
  }
}
