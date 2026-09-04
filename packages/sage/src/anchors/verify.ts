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

/** Single-anchor fallback spawn (the batch path in `batchGitBlobHashes` uses `execFile` directly). */
const execFileAsync = promisify(execFile);

export async function verifyMemoryAnchors(
  projectRoot: string,
  memory: Sage,
  checkedAt = new Date().toISOString(),
  signal?: AbortSignal,
): Promise<MemoryVerificationResult> {
  signal?.throwIfAborted();
  // D5: batch ALL git blob hashes for this memory's git anchors in ONE
  // subprocess (`git hash-object --stdin-paths`) instead of one spawn per
  // anchor; per-anchor verification reads the shared cache.
  const gitTargets = memory.anchors
    .filter((anchor) => anchor.gitBlobHash || anchor.type === 'git')
    .map((anchor) => path.resolve(projectRoot, anchor.path ?? ''))
    .filter((target) => isInside(projectRoot, target));
  const gitBlobCache = await batchGitBlobHashes(projectRoot, gitTargets, signal);
  const anchors = await Promise.all(
    memory.anchors.map((anchor) => verifyAnchor(projectRoot, anchor, signal, gitBlobCache)),
  );
  return {
    memoryId: memory.id,
    status: aggregateStatus(anchors),
    checkedAt,
    anchors,
  };
}

/**
 * D5: resolve git blob hashes for a batch of paths in a single `git
 * hash-object --stdin-paths` call (one hash per input line, order-preserving).
 * Returns an empty cache on any git failure — the per-anchor branch then
 * reports 'unknown' (Git blob could not be calculated), matching the old
 * per-anchor spawn failure behavior.
 */
async function batchGitBlobHashes(
  projectRoot: string,
  targets: string[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const cache = new Map<string, string>();
  if (targets.length === 0) return cache;
  try {
    // Hash the REAL paths (parity with the old per-anchor behavior, which ran
    // `git hash-object` on fs.realpath output): git hashes a symlink itself,
    // not its target, so resolving first keeps gitBlobHash stable for
    // symlinked anchors.
    const resolved = await Promise.all(
      targets.map(async (target) => {
        const real = await fs.realpath(target).catch(() => target);
        const stat = await fs.stat(real).catch(() => undefined);
        // `--stdin-paths` emits NO stdout line for a failing read (errors go
        // to stderr), so a mixed existing/missing batch would misalign the
        // index mapping below. Filter to existing files; missing anchors stay
        // cache-misses and the per-anchor branch resolves them (the
        // file-existence check marks them stale before the git branch).
        if (!stat?.isFile()) return undefined;
        return real;
      }),
    );
    const pairs = resolved
      .map((real, index) => (real ? { target: targets[index]!, real } : undefined))
      .filter((p): p is { target: string; real: string } => p !== undefined);
    if (pairs.length === 0) return cache;
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'git',
        ['hash-object', '--stdin-paths'],
        { cwd: projectRoot, windowsHide: true, timeout: 10_000, signal },
        (error, output) => {
          if (error) reject(error);
          else resolve(output);
        },
      );
      child.stdin?.once('error', reject);
      child.stdin?.end(`${pairs.map((p) => p.real).join('\n')}\n`);
    });
    const lines = stdout.split('\n');
    // Cache is keyed by the ORIGINAL absolutePath (what verifyAnchor looks
    // up); the real path is only what gets hashed (symlink parity).
    pairs.forEach((pair, index) => {
      const hash = lines[index]?.trim();
      if (hash) cache.set(pair.target, hash);
    });
  } catch {
    // Per-anchor branch falls back to 'unknown'.
  }
  return cache;
}

/** Shell wrappers that delegate to the following command — the probe resolves the real executable. */
const COMMAND_WRAPPERS = new Set(['sudo', 'npx', 'env', 'time', 'command', 'doas', 'runuser']);

/**
 * Per-wrapper flags that consume a SEPARATE argument. Knowing these lets the
 * resolver skip flag+value pairs (`sudo -u www cmd` -> cmd, `env -u NAME node`
 * -> node) instead of misreading the value as the executable. UNKNOWN flags
 * are still skipped, but they set `skippedFlag` so a not-found verdict becomes
 * 'unknown' (never a wrongful 'stale' demotion of the persisted memory).
 */
const WRAPPER_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  npx: new Set([
    '-p',
    '--package',
    '--registry',
    '--cache',
    '--userconfig',
    '--globalconfig',
    '--prefix',
    '--cwd',
    '--shell',
  ]),
  sudo: new Set([
    '-u',
    '-g',
    '-p',
    '-C',
    '-R',
    '-D',
    '-T',
    '--user',
    '--group',
    '--prompt',
    '--chdir',
    '--command-timeout',
  ]),
  env: new Set(['-u', '-C', '--unset', '--chdir']),
  // `command -p` and `command --path` are NO-ARGUMENT flags (use the default
  // PATH); `sudo -h` prints help. They must not consume the following token.
  command: new Set(),
  doas: new Set(['-u']),
  runuser: new Set(['-u', '-g']),
  time: new Set(),
};

interface ResolvedExecutable {
  /** Resolved executable name/path, or undefined when nothing resolvable. */
  executable: string | undefined;
  /**
   * True when an UNKNOWN flag was skipped during wrapper resolution (a known
   * value-taking flag consumed its argument instead). If the resolved
   * executable is then NOT found, the verdict must be 'unknown' — the flag
   * may have taken the executable's place as an argument, and a wrong 'stale'
   * would demote the persisted memory (sqlite-store-verify.ts).
   */
  skippedFlag: boolean;
  /**
   * True when the wrapper installs its target on demand (`npx` fetches
   * packages). PATH absence is NOT staleness evidence for such targets —
   * the package may simply not be installed yet, so a missing verdict must
   * be 'unknown', never 'stale'.
   */
  demandFetch: boolean;
  /** The wrapper token that delegated resolution (e.g. 'npx'), for reason text. */
  wrapper: string | undefined;
}

/**
 * Extract the first command token, honoring a quoted executable
 * (`"C:\Program Files\node\node.exe" --version` -> `C:\Program Files\node\node.exe`)
 * and skipping wrappers that delegate to the next token.
 */
/** Wrappers that install their target on demand (PATH absence is not staleness). */
const DEMAND_FETCH_WRAPPERS = new Set(['npx']);

interface TokenInfo {
  token: string;
  raw: string;
}

function firstTokenInfo(input: string): TokenInfo | undefined {
  const match = /^"([^"]+)"|^'([^']+)'|^(\S+)/.exec(input);
  if (!match) return undefined;
  const token = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  if (!token) return undefined;
  return { token, raw: match[0] };
}


function resolveCommandExecutable(command: string): ResolvedExecutable {
  const trimmed = command.trim();
  if (!trimmed) {
    return { executable: undefined, skippedFlag: false, demandFetch: false, wrapper: undefined };
  }
  const first = firstTokenInfo(trimmed);
  if (!first) {
    return { executable: undefined, skippedFlag: false, demandFetch: false, wrapper: undefined };
  }
  if (!COMMAND_WRAPPERS.has(first.token)) {
    return { executable: first.token, skippedFlag: false, demandFetch: false, wrapper: undefined };
  }
  const demandFetch = DEMAND_FETCH_WRAPPERS.has(first.token);
  const valueFlags = WRAPPER_VALUE_FLAGS[first.token] ?? new Set<string>();
  const rest = trimmed.slice(trimmed.indexOf(first.raw) + first.raw.length).trim();
  let cursor = rest;
  let skippedFlag = false;
  for (let i = 0; i < 8; i++) {
    const tokenInfo = firstTokenInfo(cursor);
    if (!tokenInfo) return { executable: undefined, skippedFlag, demandFetch, wrapper: first.token };
    const { token, raw } = tokenInfo;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      // env-style assignment (`env FOO=bar node`) — unambiguous, not a flag.
      cursor = cursor.slice(cursor.indexOf(raw) + raw.length).trim();
      continue;
    }
    if (token.startsWith('-')) {
      cursor = cursor.slice(cursor.indexOf(raw) + raw.length).trim();
      if (valueFlags.has(token)) {
        // Known value-taking flag: consume its argument too.
        const valInfo = firstTokenInfo(cursor);
        if (valInfo) cursor = cursor.slice(cursor.indexOf(valInfo.raw) + valInfo.raw.length).trim();
      } else {
        // Unknown flag: conservative — a not-found verdict becomes 'unknown'.
        skippedFlag = true;
      }
      continue;
    }
    return { executable: token, skippedFlag, demandFetch, wrapper: first.token };
  }
  return { executable: undefined, skippedFlag, demandFetch, wrapper: first.token };
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
  // Shell builtins (echo/cd/dir/...) have no PATH entry — the shell provides
  // them, so existence is satisfied without a filesystem hit.
  if (isShellBuiltin(executable)) {
    return {
      anchor,
      status: 'verified',
      reason: `Command "${executable}" is a shell builtin (provided by the shell).`,
    };
  }
  const found = await commandExists(projectRoot, executable, signal);
  if (found) {
    return {
      anchor,
      status: 'verified',
      reason: `Command executable "${executable}" is available.`,
    };
  }
  if (resolved.skippedFlag) {
    // An UNKNOWN flag was skipped during resolution, so `executable` may be
    // that flag's ARGUMENT. A wrong 'stale' would demote the persisted
    // memory — report 'unknown' instead.
    return {
      anchor,
      status: 'unknown',
      reason: `Ambiguous command anchor: "${executable}" follows a flag (likely a flag argument); not found on PATH.`,
    };
  }
  if (resolved.demandFetch) {
    // `npx` installs packages on demand — PATH absence is not staleness.
    return {
      anchor,
      status: 'unknown',
      reason: `Command "${executable}" is not installed; "${resolved.wrapper}" installs it on demand, so absence is not staleness.`,
    };
  }
  return {
    anchor,
    status: 'stale',
    reason: `Command executable "${executable}" was not found on PATH.`,
  };
}

/**
 * Shell builtins with no PATH entry — their existence is provided by the
 * shell itself. Platform-gated: `dir` is a cmd.exe builtin on Windows only
 * (on POSIX it is an external coreutils binary and must be PATH-probed);
 * `source`/`.` are bash/zsh keywords (kept — anchors typically reference
 * bash workflows). Windows builtins are case-insensitive, so the comparison
 * lowercases there; POSIX stays case-sensitive.
 */
function buildShellBuiltins(): ReadonlySet<string> {
  const isWin32 = process.platform === 'win32';
  // bash/zsh keywords apply on BOTH platforms — Git Bash is the standard
  // Windows shell for bash workflows, so excluding them on win32 would make
  // `source deploy.sh` deterministically 'stale' there (a keyword has no PATH
  // entry to probe). win32 additionally lists cmd.exe builtins ('dir', ...).
  const bash = [
    'cd',
    'echo',
    'type',
    'alias',
    'exit',
    'set',
    'unset',
    'printf',
    'pwd',
    'export',
    'test',
    'true',
    'false',
    'read',
    'shift',
    'source',
    '.',
  ];
  if (isWin32) {
    // cmd.exe internals (case-insensitive on win32) + the Git Bash keyword set
    // (the standard Windows shell for bash workflows).
    return new Set([
      ...bash,
      'dir',
      'copy',
      'del',
      'ren',
      'mkdir',
      'md',
      'rd',
      'rmdir',
      'move',
      'erase',
      'call',
      'pushd',
      'popd',
      'cls',
      'if',
      'for',
      'goto',
      'rem',
      'pause',
      'color',
      'chcp',
      'setlocal',
      'endlocal',
      'ver',
      'vol',
      'path',
      'prompt',
      'title',
      'break',
      'assoc',
      'ftype',
    ]);
  }
  return new Set(bash);
}
const SHELL_BUILTINS = buildShellBuiltins();

function isShellBuiltin(executable: string): boolean {
  const key = process.platform === 'win32' ? executable.toLowerCase() : executable;
  return SHELL_BUILTINS.has(key);
}

function isExecutableFile(stat: { isFile(): boolean; mode: number }, isWin32: boolean): boolean {
  // Existence is not executability: on POSIX require the execute bit.
  return stat.isFile() && (isWin32 || (stat.mode & 0o111) !== 0);
}

async function commandExists(
  projectRoot: string,
  executable: string,
  signal?: AbortSignal,
): Promise<boolean> {
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
  gitBlobCache?: ReadonlyMap<string, string>,
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
    if (gitBlobCache === undefined) {
      // Direct seam call without a batch pre-fetch — fall back to a single
      // spawn (matches the pre-D5 per-anchor behavior). verifyMemoryAnchors
      // always passes a cache, so the batch path never takes this branch.
      try {
        const result = await execFileAsync('git', ['hash-object', realPath], {
          cwd: projectRoot,
          windowsHide: true,
          timeout: 5_000,
          signal,
        });
        gitBlobHash = result.stdout.trim();
      } catch {
        return {
          anchor,
          status: 'unknown',
          reason: 'Git blob could not be calculated.',
          contentHash,
        };
      }
    } else {
      // D5: the hash comes from the batch pre-fetch (single git subprocess per
      // verify run); a cache miss means the batch failed, mirroring the old
      // per-anchor spawn failure.
      gitBlobHash = gitBlobCache.get(absolutePath);
      if (gitBlobHash === undefined) {
        return {
          anchor,
          status: 'unknown',
          reason: 'Git blob could not be calculated.',
          contentHash,
        };
      }
    }
    if (anchor.gitBlobHash && anchor.gitBlobHash !== gitBlobHash) {
      return {
        anchor,
        status: 'stale',
        reason: 'Git blob hash changed.',
        contentHash,
        gitBlobHash,
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
