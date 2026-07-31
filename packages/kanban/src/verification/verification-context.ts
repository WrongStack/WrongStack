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

/** Maximum retained stdout or stderr for a spawned verification process. */
export const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Collect child-process output without allowing a chatty process to exhaust RAM. */
export class BoundedProcessOutput {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes = MAX_PROCESS_OUTPUT_BYTES) {}

  append(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = this.maxBytes - this.bytes;
    if (remaining > 0) {
      if (buffer.byteLength <= remaining) {
        this.chunks.push(buffer);
        this.bytes += buffer.byteLength;
      } else {
        this.chunks.push(Buffer.from(buffer.subarray(0, remaining)));
        this.bytes += remaining;
      }
    }
    if (buffer.byteLength > remaining) this.truncated = true;
  }

  get retainedBytes(): number {
    return this.bytes;
  }

  toString(): string {
    const output = Buffer.concat(this.chunks, this.bytes).toString('utf8');
    return this.truncated
      ? `${output}\n--- output truncated after ${this.maxBytes} bytes ---`
      : output;
  }
}

// ─── Command Allowlist ──────────────────────────────────────────────────────

/**
 * Regex that detects shell metacharacters used to chain multiple commands.
 *
 * Blocked operators:
 *   `&&`, `||` — command chaining
 *   `;`, `|`, `` ` `` — separator, pipe, command substitution
 *   `>`, `<`, `&` — redirections and backgrounding
 *   `$(` — command substitution
 *   `\n`, `\r` — newline / carriage return as command separators
 *
 * NOTE: No preceding-character escape guard is used. Shell backslash handling
 * inside `sh -c` is platform-dependent, and a guard creates a clean bypass
 * with even backslash runs. A false positive (rejecting a safe command) is
 * safer than a false negative.
 */
export const SHELL_OPERATOR_RE = /(?:&&|\|\||[;&<>|`\n\r]|\$[({])/;
const ENV_EXPANSION_RE = /(?:\$[A-Za-z_]|%[^%\r\n]+%|![^!\r\n]+!)/;

/**
 * Commands permitted by default — read-only inspection only.
 *
 * `git` is intentionally absent — the verifier uses `runGitCommand()` which
 * spawns git directly with an argument array (not through the shell allowlist).
 * Test runners resolve a locally installed package's declared bin entry and
 * invoke it through Node; package managers never use this generic surface.
 */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = ['pwd', 'true', 'false', 'test'];

/** Commands explicitly blocked even when they would otherwise pass the allowlist. */
export const DEFAULT_BLOCKED_COMMANDS: readonly string[] = [
  'rm', 'del', 'erase', 'rmdir', 'rd', 'rmtree',
  'mk', 'mkdir', 'md', 'mv', 'move', 'cp', 'copy', 'xcopy', 'robocopy',
  'ren', 'rename', 'ln', 'link', 'mklink', 'install', 'touch',
  'kill', 'taskkill', 'pkill',
  'shutdown', 'reboot', 'halt', 'poweroff', 'init',
  'chmod', 'chown', 'chgrp', 'attrib', 'cacls', 'icacls',
  'format', 'fdisk', 'dd', 'mkfs', 'mount', 'umount', 'diskpart',
  'wget', 'curl', 'fetch', 'nc', 'netcat', 'telnet', 'ssh', 'scp', 'rsync',
  'ftp', 'sftp',
  'sudo', 'su', 'runas', 'doas',
  'sh', 'bash', 'zsh', 'ksh', 'dash', 'ash',
  'cmd', 'powershell', 'pwsh',
  'apt', 'apt-get', 'dpkg', 'rpm', 'yum', 'dnf', 'pacman', 'zypper',
  'brew', 'port', 'choco', 'scoop', 'winget',
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'node',
  'make', 'cmake', 'gcc', 'g++', 'clang', 'rustc',
  'tar', 'gzip', 'gunzip', 'zip', 'unzip', '7z', 'rar',
  'base64', 'base32', 'openssl', 'gpg',
  'reg', 'regedit', 'sc', 'net', 'netsh', 'vssadmin', 'bcdedit',
  'invoke-webrequest', 'iwr',
  'perl', 'python', 'python3', 'ruby', 'php', 'lua', 'tclsh',
  'find',
];

export interface CommandAllowlistConfig {
  /**
   * Additional base commands to permit, or existing ones to add/remove.
   *
   * Prefix semantics:
   *   `"cmd"`    — add `cmd` to the allowlist
   *   `"+cmd"`   — add `cmd` to the allowlist (explicit)
   *   `"-cmd"`   — remove `cmd` from the default allowlist
   */
  allowedCommands?: readonly string[] | undefined;
  /** Base commands explicitly blocked, merged with the built-in blocklist. */
  blockedCommands?: readonly string[] | undefined;
  /** When true, allow any base command not in the blocked list (default: false).
   *  Shell-operator detection still applies. */
  allowAll?: boolean | undefined;
}

export function normalizeBaseCommand(token: string): string {
  return token.replace(/^.*[/\\]/, '').toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/i, '');
}

function buildAllowlist(
  config: CommandAllowlistConfig | undefined,
): { allow: Set<string>; block: Set<string> } {
  const allow = new Set(DEFAULT_ALLOWED_COMMANDS.map((c) => normalizeBaseCommand(c)));
  const block = new Set(DEFAULT_BLOCKED_COMMANDS.map((c) => normalizeBaseCommand(c)));
  if (config?.allowedCommands) {
    for (const cmd of config.allowedCommands) {
      if (cmd.startsWith('+')) {
        allow.add(normalizeBaseCommand(cmd.slice(1)));
      } else if (cmd.startsWith('-')) {
        allow.delete(normalizeBaseCommand(cmd.slice(1)));
      } else {
        allow.add(normalizeBaseCommand(cmd));
      }
    }
  }
  if (config?.blockedCommands) {
    for (const cmd of config.blockedCommands) {
      if (cmd.startsWith('+')) {
        block.delete(normalizeBaseCommand(cmd.slice(1)));
      } else {
        block.add(normalizeBaseCommand(cmd));
      }
    }
  }
  return { allow, block };
}

/** Parse a command string into an executable and argv without invoking a shell. */
function parseCommandArguments(command: string): string[] | string {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;

  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      tokenStarted = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
    } else if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current);
        current = '';
        tokenStarted = false;
      }
    } else {
      current += char;
      tokenStarted = true;
    }
  }

  if (quote) return 'Command contains an unterminated quoted argument.';
  if (tokenStarted) args.push(current);
  return args;
}

/** Extract the base executable name from a command string. */
export function extractBaseCommand(command: string): string {
  const parsed = parseCommandArguments(command);
  return typeof parsed === 'string' ? '' : normalizeBaseCommand(parsed[0] ?? '');
}

/** Validate a command string. Returns null if allowed, or an error message. */
export function validateCommand(
  command: string,
  config: {
    allow: Set<string>;
    block: Set<string>;
    allowAll: boolean;
    allowShellOperators?: boolean;
  },
): string | null {
  const base = extractBaseCommand(command);
  if (!base) return 'Empty command.';
  if (command.includes('\n') || command.includes('\r')) {
    return 'Command contains newline or carriage return characters which are not permitted.';
  }
  const testTarget = process.platform === 'win32' ? command.replaceAll('^', '') : command;
  if (!config.allowShellOperators && SHELL_OPERATOR_RE.test(testTarget)) {
    return 'Command contains shell operators (&&, ||, ;, |, &, >, <, backticks, $()) which are not permitted in the verifier.';
  }
  if (ENV_EXPANSION_RE.test(testTarget)) {
    return 'Command contains environment-variable expansion, which is not permitted in the verifier.';
  }
  if (config.block.has(base)) {
    return `Command "${base}" is blocked by the verifier security policy.`;
  }
  if (!config.allowAll && !config.allow.has(base)) {
    return `Command "${base}" is not in the verifier allowlist.`;
  }
  return null;
}

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
        this.runGitCommand(['diff', '--no-renames', '--numstat', useSnapshot.treeHash, currentTree]),
        this.runGitCommand(['diff', '--no-renames', '--name-status', useSnapshot.treeHash, currentTree]),
      ]);
      return parseGitNumstat(numstat.stdout, parseGitNameStatus(nameStatus.stdout));
    } catch {
      return [];
    }
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
      const unstaged = lines.filter(
        (l) => /^.[^ ]/.test(l) && !l.startsWith('??'),
      ).length;
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
  async fileStat(
    filePath: string,
  ): Promise<{ exists: boolean; size: number; mtime: string }> {
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
      return this.rejectedCommand(command, start, 'Verifier commands must run at the project root.');
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
        const matches = tokens[1] === '-e' || (tokens[1] === '-f' ? stat.isFile() : stat.isDirectory());
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
        !DEFAULT_ALLOWED_COMMANDS.some((allowed) => normalizeBaseCommand(allowed) === normalizedBase));
    if (isConfiguredCommand) {
      const [executable, ...args] = tokens;
      if (!executable) return this.rejectedCommand(command, start, 'Empty command.');
      const result = await this.runProcess(executable, args, {
        cwd: this.projectRoot,
        timeoutMs: opts?.timeoutMs ?? 60_000,
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
        terminateProcessTree(child, detachedProcessGroup);
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
    opts: { cwd: string; timeoutMs: number },
  ): Promise<CommandResult> {
    const start = Date.now();
    const displayCommand = [command, ...args].join(' ');
    return new Promise<CommandResult>((resolve) => {
      const detachedProcessGroup = process.platform !== 'win32';
      const child = spawn(command, args, {
        cwd: opts.cwd,
        shell: false,
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
        terminateProcessTree(child, detachedProcessGroup);
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
          typeof packageJson.bin === 'string'
            ? packageJson.bin
            : packageJson.bin?.[runner];
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

// ---------------------------------------------------------------------------
// Standalone helpers
// ---------------------------------------------------------------------------

/** Best-effort process-tree termination that never delays timeout settlement. */
function terminateProcessTree(child: ChildProcess, detachedProcessGroup: boolean): void {
  // MUST NOT block promise resolution: timeout callers settle immediately after invoking this helper.
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

/** Parse `git diff --name-status` into file-operation evidence. */
export function parseGitNameStatus(output: string): Map<string, FileDiffEntry['operation']> {
  const operations = new Map<string, FileDiffEntry['operation']>();
  for (const line of output.split('\n').filter(Boolean)) {
    const [status = '', ...pathParts] = line.split('\t');
    const filePath = pathParts.at(-1);
    if (!filePath) continue;
    operations.set(
      filePath,
      status.startsWith('A') ? 'create' : status.startsWith('D') ? 'delete' : 'modify',
    );
  }
  return operations;
}

/** Parse `git diff --numstat` output into structured entries. */
export function parseGitNumstat(
  output: string,
  operations: ReadonlyMap<string, FileDiffEntry['operation']> = new Map(),
): FileDiffEntry[] {
  return output
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const parts = line.split('\t');
      if (parts.length < 3) return null;
      const added = parseInt(parts[0]!, 10) || 0;
      const removed = parseInt(parts[1]!, 10) || 0;
      const filePath = parts[2] ?? '';
      return {
        path: filePath,
        operation: operations.get(filePath) ?? 'modify',
        linesAdded: added,
        linesRemoved: removed,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
}

function isTestCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTestJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate['testResults']) ||
    (isTestCount(candidate['numPassedTests']) && isTestCount(candidate['numFailedTests']))
  );
}

function parseTestJsonObject(output: string): Record<string, unknown> | null {
  try {
    const complete = JSON.parse(output.trim()) as unknown;
    if (isTestJsonObject(complete)) return complete;
  } catch {
    // Surrounding runner output requires balanced-object extraction below.
  }

  for (let start = output.indexOf('{'); start >= 0; start = output.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const char = output[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(output.slice(start, index + 1)) as unknown;
            if (isTestJsonObject(parsed)) return parsed;
          } catch {
            // Keep scanning: runner output can contain unrelated brace-delimited text.
          }
          break;
        }
      }
    }
  }
  return null;
}

/** Try to parse JSON test runner output. */
function tryParseTestJson(
  output: string,
  pattern: string,
): Omit<TestResult, 'durationMs'> | null {
  try {
    const parsed = parseTestJsonObject(output);
    if (parsed) {
      const numPassedTestsValue = parsed['numPassedTests'];
      const numFailedTestsValue = parsed['numFailedTests'];
      const numSkippedTestsValue = parsed['numSkippedTests'];
      const successValue = parsed['success'];
      const numPassed =
        typeof numPassedTestsValue === 'number'
          ? numPassedTestsValue
          : typeof successValue === 'boolean'
            ? (successValue ? 1 : 0)
            : 0;
      const numFailed =
        typeof numFailedTestsValue === 'number'
          ? numFailedTestsValue
          : typeof successValue === 'boolean'
            ? (successValue ? 0 : 1)
            : 0;
      const numSkipped =
        typeof numSkippedTestsValue === 'number' ? numSkippedTestsValue : 0;
      return {
        testPattern: pattern,
        passed: numPassed,
        failed: numFailed,
        skipped: numSkipped,
      };
    }
  } catch {
    // Not JSON output — fall through
  }
  return null;
}
