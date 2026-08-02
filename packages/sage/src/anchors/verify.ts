import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { assertProjectAgentRole, FLEET_ROSTER } from '@wrongstack/core/coordination';
import type {
  AnchorVerificationResult,
  MemoryAnchor,
  MemoryVerificationResult,
  Sage,
  VerificationStatus,
} from '../types.js';

const execFileAsync = promisify(execFile);

export async function verifyMemoryAnchors(
  projectRoot: string,
  memory: Sage,
  checkedAt = new Date().toISOString(),
  signal?: AbortSignal,
): Promise<MemoryVerificationResult> {
  signal?.throwIfAborted();
  const anchors = await Promise.all(
    memory.anchors.map((anchor) => verifyAnchor(projectRoot, anchor, signal)),
  );
  return {
    memoryId: memory.id,
    status: aggregateStatus(anchors),
    checkedAt,
    anchors,
  };
}

/** Shell wrappers that delegate to the following command — the probe resolves the real executable. */
const COMMAND_WRAPPERS = new Set(['sudo', 'npx', 'env', 'time', 'command', 'doas', 'runuser']);

interface ResolvedExecutable {
  /** Resolved executable name/path, or undefined when nothing resolvable. */
  executable: string | undefined;
  /**
   * True when the resolved token directly follows a SHORT flag (-X), so it is
   * likely the flag's ARGUMENT (`sudo -u www cmd` -> `www`) rather than the
   * command. Verification must NOT demote on this — a stale result flips the
   * persisted memory status (sqlite-store-verify.ts), so ambiguity resolves
   * to 'unknown' instead of a possibly-wrong 'stale'.
   */
  flagArgument: boolean;
  /**
   * True when any flag or env-assignment token was skipped during wrapper
   * resolution (`npx --registry https://x eslint` skips `--registry` but the
   * next token is the flag's ARGUMENT, not the command). If the resolved
   * executable is then NOT found, the verdict must be 'unknown' — a wrong
   * 'stale' would demote the persisted memory.
   */
  skippedFlag: boolean;
}

/**
 * Extract the first command token, honoring a quoted executable
 * (`"C:\Program Files\node\node.exe" --version` -> `C:\Program Files\node\node.exe`)
 * and skipping wrappers that delegate to the next token.
 */
function resolveCommandExecutable(command: string): ResolvedExecutable {
  const trimmed = command.trim();
  if (!trimmed) return { executable: undefined, flagArgument: false, skippedFlag: false };
  const first = firstToken(trimmed);
  if (!first) return { executable: undefined, flagArgument: false, skippedFlag: false };
  if (!COMMAND_WRAPPERS.has(first)) {
    return { executable: first, flagArgument: false, skippedFlag: false };
  }
  // Skip wrapper options and env assignments: `npx --yes eslint` -> eslint,
  // `time -v cmd` -> cmd, `env FOO=bar node` -> node. A token that directly
  // follows a SHORT flag is ambiguous (the flag's argument vs the command) —
  // `sudo -u www cmd` yields `www`, `npx -y node` yields `node`; callers must
  // treat that as 'unknown', never 'stale' (a stale verdict demotes the
  // persisted memory). Any skipped flag makes the whole resolution
  // 'skippedFlag' — a long flag's argument (`--registry https://x eslint`)
  // is indistinguishable from a command without per-tool knowledge.
  const rest = trimmed.slice(trimmed.indexOf(first) + first.length).trim();
  let cursor = rest;
  let afterShortFlag = false;
  let skippedFlag = false;
  for (let i = 0; i < 8; i++) {
    const token = firstToken(cursor);
    if (!token) return { executable: undefined, flagArgument: false, skippedFlag };
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      skippedFlag = true;
      cursor = cursor.slice(cursor.indexOf(token) + token.length).trim();
      continue;
    }
    if (token.startsWith('-')) {
      skippedFlag = true;
      afterShortFlag = /^-[a-zA-Z]$/.test(token);
      cursor = cursor.slice(cursor.indexOf(token) + token.length).trim();
      continue;
    }
    return { executable: token, flagArgument: afterShortFlag, skippedFlag };
  }
  return { executable: undefined, flagArgument: false, skippedFlag };
}

function firstToken(input: string): string | undefined {
  const match = /^"([^"]+)"|^'([^']+)'|^(\S+)/.exec(input);
  const token = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
  return token || undefined;
}

/**
 * Command anchors are verifiable by EXISTENCE probe, never by execution: the
 * executable is resolved from the first command token (skipping common
 * wrappers, honoring a quoted first token) and looked up on PATH — or at an
 * explicit path when the token contains a separator. A missing executable
 * marks the anchor stale, so command memories are no longer permanently
 * 'unknown'. Zero execution risk: no shell is ever invoked.
 */
async function verifyCommandAnchor(
  projectRoot: string,
  anchor: MemoryAnchor,
  signal?: AbortSignal,
): Promise<AnchorVerificationResult> {
  signal?.throwIfAborted();
  const resolved = resolveCommandExecutable(anchor.command ?? '');
  const executable = resolved.executable;
  if (!executable) {
    return { anchor, status: 'stale', reason: 'Command anchor has no executable to resolve.' };
  }
  if (resolved.flagArgument) {
    // Ambiguous: the token follows a short flag, so it may be the flag's
    // argument, not the command. A stale verdict would demote the persisted
    // memory, so report 'unknown' and let a human/agent resolve it.
    return {
      anchor,
      status: 'unknown',
      reason: `Ambiguous command anchor: "${executable}" follows a short flag (likely a flag argument, not an executable).`,
    };
  }
  // Shell builtins (echo/cd/dir/...) have no PATH entry — the shell provides
  // them, so existence is satisfied without a filesystem hit.
  if (SHELL_BUILTINS.has(executable)) {
    return {
      anchor,
      status: 'verified',
      reason: `Command "${executable}" is a shell builtin (provided by the shell).`,
    };
  }
  const found = await commandExists(projectRoot, executable, signal);
  if (found) {
    return { anchor, status: 'verified', reason: `Command executable "${executable}" is available.` };
  }
  if (resolved.skippedFlag) {
    // A flag was skipped during resolution, so `executable` may be that
    // flag's ARGUMENT (`npx --registry https://x eslint`). A wrong 'stale'
    // would demote the persisted memory — report 'unknown' instead.
    return {
      anchor,
      status: 'unknown',
      reason: `Ambiguous command anchor: "${executable}" follows a flag (likely a flag argument); not found on PATH.`,
    };
  }
  return { anchor, status: 'stale', reason: `Command executable "${executable}" was not found on PATH.` };
}

/** Shell builtins with no PATH entry — their existence is provided by the shell itself. */
const SHELL_BUILTINS = new Set([
  'cd',
  'echo',
  'pwd',
  'dir',
  'type',
  'alias',
  'exit',
  'export',
  'set',
  'unset',
  'printf',
  'test',
  'true',
  'false',
  'read',
  'shift',
  'source',
  '.',
]);

function isExecutableFile(
  stat: { isFile(): boolean; mode: number },
  isWin32: boolean,
): boolean {
  // Existence is not executability: on POSIX require the execute bit.
  return stat.isFile() && (isWin32 || (stat.mode & 0o111) !== 0);
}

async function commandExists(projectRoot: string, executable: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const isWin32 = process.platform === 'win32';
  if (executable.includes('/') || executable.includes('\\')) {
    // Explicit path: absolute paths resolve as-is; relative paths (e.g.
    // `./scripts/build.sh`) resolve against the project root, not the probe's
    // process CWD.
    const target = path.isAbsolute(executable) ? executable : path.resolve(projectRoot, executable);
    try {
      const stat = await fs.stat(target);
      return isExecutableFile(stat, isWin32);
    } catch {
      return false;
    }
  }
  const extensions = isWin32 ? ['.exe', '.cmd', '.bat', '.com', ''] : [''];
  const pathVar = process.env['PATH'] ?? '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      signal?.throwIfAborted();
      const candidate = path.join(dir, `${executable}${ext}`);
      try {
        const stat = await fs.stat(candidate);
        if (isExecutableFile(stat, isWin32)) return true;
      } catch {
        // Keep looking.
      }
    }
  }
  return false;
}

async function verifyAnchor(
  projectRoot: string,
  anchor: MemoryAnchor,
  signal?: AbortSignal,
): Promise<AnchorVerificationResult> {
  signal?.throwIfAborted();
  if (anchor.type === 'command') {
    return verifyCommandAnchor(projectRoot, anchor, signal);
  }
  if (anchor.type === 'agent') {
    let role: string;
    try {
      role = assertProjectAgentRole(anchor.role ?? '').toLowerCase();
    } catch {
      return { anchor, status: 'stale', reason: 'Agent anchor has an invalid role.' };
    }
    const customRolePath = path.join(projectRoot, '.wrongstack', 'agents', role);
    const customRoleExists = await fs
      .stat(customRolePath)
      .then((stat) => stat.isDirectory())
      .catch(() => false);
    return FLEET_ROSTER[role] || customRoleExists
      ? { anchor, status: 'verified', reason: `Agent role "${role}" is available.` }
      : { anchor, status: 'stale', reason: `Agent role "${role}" is not in the roster.` };
  }
  if (!anchor.path) {
    return { anchor, status: 'unknown', reason: 'Anchor has no path.' };
  }

  const absolutePath = path.resolve(projectRoot, anchor.path);
  if (!isInside(projectRoot, absolutePath)) {
    return { anchor, status: 'stale', reason: 'Anchor resolves outside the project root.' };
  }

  let stat;
  let realPath: string;
  try {
    stat = await fs.stat(absolutePath);
    realPath = await fs.realpath(absolutePath);
  } catch {
    return { anchor, status: 'stale', reason: 'Anchored path no longer exists.' };
  }

  const realRoot = await resolveRealRoot(projectRoot);
  if (!isInside(realRoot, realPath)) {
    return {
      anchor,
      status: 'stale',
      reason: 'Anchor resolves through a symlink outside the project root.',
    };
  }

  if (anchor.type === 'directory' || anchor.type === 'package') {
    return stat.isDirectory()
      ? {
          anchor,
          status: 'verified',
          reason: anchor.type === 'package' ? 'Package directory exists.' : 'Directory exists.',
        }
      : {
          anchor,
          status: 'stale',
          reason: `${anchor.type === 'package' ? 'Package' : 'Directory'} anchor points to a non-directory.`,
        };
  }
  if (!stat.isFile()) {
    return { anchor, status: 'stale', reason: 'File anchor points to a non-file.' };
  }

  const body = await fs.readFile(realPath, signal ? { signal } : undefined);
  const contentHash = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  if (anchor.contentHash && anchor.contentHash !== contentHash) {
    return { anchor, status: 'stale', reason: 'File content hash changed.', contentHash };
  }

  if (anchor.symbol) {
    const text = body.toString('utf8');
    if (!containsSymbol(text, anchor.symbol)) {
      return {
        anchor,
        status: 'stale',
        reason: `Symbol "${anchor.symbol}" no longer exists.`,
        contentHash,
      };
    }
  }

  let gitBlobHash: string | undefined;
  if (anchor.gitBlobHash || anchor.type === 'git') {
    try {
      const result = await execFileAsync('git', ['hash-object', realPath], {
        cwd: projectRoot,
        windowsHide: true,
        timeout: 5_000,
        signal,
      });
      gitBlobHash = result.stdout.trim();
      if (anchor.gitBlobHash && anchor.gitBlobHash !== gitBlobHash) {
        return {
          anchor,
          status: 'stale',
          reason: 'Git blob hash changed.',
          contentHash,
          gitBlobHash,
        };
      }
    } catch {
      return {
        anchor,
        status: 'unknown',
        reason: 'Git blob could not be calculated.',
        contentHash,
      };
    }
  }

  return { anchor, status: 'verified', reason: 'Anchor is current.', contentHash, gitBlobHash };
}

function containsSymbol(text: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

function aggregateStatus(results: AnchorVerificationResult[]): VerificationStatus {
  if (results.length === 0) return 'unknown';
  if (results.some((result) => result.status === 'contradicted')) return 'contradicted';
  if (results.some((result) => result.status === 'stale')) return 'stale';
  if (results.every((result) => result.status === 'verified')) return 'verified';
  return 'unknown';
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveRealRoot(projectRoot: string): Promise<string> {
  return fs.realpath(projectRoot).catch(() => path.resolve(projectRoot));
}

/** Direct-module test seam; intentionally not re-exported by the package barrel. */
export const anchorVerificationCoverage = {
  verifyAnchor,
  containsSymbol,
  aggregateStatus,
  isInside,
  resolveRealRoot,
};
