/**
 * path-guard plugin — blocks (or warns about) writes, edits, and
 * destructive shell commands that touch protected paths.
 *
 * `branch-guard` protects git *branches*; this plugin protects
 * *files and directories*. A `PreToolUse` hook matches the target path
 * against a configurable glob list:
 *
 *  - any tool that declares `fs.write` (or, absent a capability list,
 *    `mutating: true`) → the `path` / `file_path` / `output_path` / …
 *    input field
 *  - shell commands → destructive ones only (`rm`, `rmdir`, `mv`, `cp`,
 *    `install`, `tee`, `dd of=`, output redirection `>` / `>>`, `truncate`)
 *    whose arguments mention a protected path
 *
 * The hook is registered for `*` and decides from the tool's own
 * declaration. It used to be registered for `write|edit|bash|exec` and to
 * branch on those four names, which meant `patch`, `scaffold`, every
 * plugin-registered writer and every MCP filesystem server wrote past it
 * untouched.
 *
 * Default protected set: lockfiles, `.env*` secrets, `.git/`
 * internals, and production migration folders — files an agent
 * should virtually never rewrite by hand.
 *
 * Config (`config.extensions['path-guard']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "mode": "block",                     // "block" | "warn"
 *   "protect": ["pnpm-lock.yaml", ".env*", ".git/**", "**&#47;migrations/**"],
 *   "allow": []                          // globs that override protect
 * }
 * ```
 *
 * Toggle off with `{ "name": "path-guard", "enabled": false }` in
 * `config.plugins`, or `"enabled": false` in the options above.
 *
 * @public
 */
import type { Plugin } from '@wrongstack/core/types';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface PathGuardState {
  invocations: number;
  blocks: number;
  warns: number;
  lastBlock: { path: string; tool: string; when: string } | null;
  hookUnregister: null | (() => void);
}

const state: PathGuardState = {
  invocations: 0,
  blocks: 0,
  warns: 0,
  lastBlock: null,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface PathGuardConfig {
  enabled: boolean;
  mode: 'block' | 'warn';
  protect: string[];
  allow: string[];
}

const DEFAULT_PROTECT = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  '.env',
  '.env.*',
  '.git/**',
  '**/migrations/**',
];

const DEFAULTS: PathGuardConfig = {
  enabled: true,
  mode: 'block',
  protect: DEFAULT_PROTECT,
  allow: [],
};

function readConfig(raw: unknown): PathGuardConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS, protect: [...DEFAULT_PROTECT] };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    mode: r['mode'] === 'warn' ? 'warn' : 'block',
    protect: Array.isArray(r['protect'])
      ? r['protect'].filter((p): p is string => typeof p === 'string' && p.length > 0)
      : [...DEFAULT_PROTECT],
    allow: Array.isArray(r['allow'])
      ? r['allow'].filter((p): p is string => typeof p === 'string' && p.length > 0)
      : [],
  };
}

// ---------------------------------------------------------------------------
// Glob matching (dependency-free, deliberately simple)
// ---------------------------------------------------------------------------

/**
 * Compile a glob pattern to a RegExp. Supports `**` (any depth),
 * `*` (within one segment), and `?` (single char). Matching is done
 * against forward-slash-normalized relative-ish paths, and a pattern
 * without a slash matches the basename anywhere in the tree
 * (`.env` matches `sub/dir/.env`).
 */
export function compilePathGlob(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  let source = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '/' && normalized.slice(i) === '/**') {
      // A trailing `/**` includes the directory itself as well as descendants.
      // Otherwise `.git/**` misses the bare `.git` target.
      source += '(?:/(?:[^/]+(?:/[^/]+)*)?)?';
      break;
    }
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        const followedBySlash = normalized[i + 2] === '/';
        // Globstar spans whole path segments, never a substring of one.
        source += followedBySlash ? '(?:[^/]+/)*' : '(?:[^/]+(?:/[^/]+)*)?';
        i += followedBySlash ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else if (ch !== undefined && /[.+^${}()|[\]\\]/.test(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  // Anchored at a segment boundary so `.env` also matches `sub/dir/.env`
  // and `a/b` matches `repo/a/b` but never `xa/b`.
  return new RegExp(`(?:^|/)${source}$`, 'i');
}

function normalizePath(p: string): string {
  const slashNormalized = p.replace(/\\/g, '/');
  const drive = /^[a-z]:/i.exec(slashNormalized)?.[0] ?? '';
  const absolute = slashNormalized.startsWith('/') || drive.length > 0;
  const body = drive ? slashNormalized.slice(drive.length).replace(/^\//, '') : slashNormalized;
  const segments: string[] = [];

  for (const segment of body.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') {
        segments.pop();
      } else if (!absolute) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }

  const joined = segments.join('/');
  if (drive) return `${drive}/${joined}`.replace(/\/$/, '');
  if (slashNormalized.startsWith('/')) return `/${joined}`.replace(/\/$/, '') || '/';
  return joined;
}

function isAbsolutePath(path: string): boolean {
  return /^(?:\/|[a-z]:\/)/i.test(path);
}

function resolveTargetPath(path: string, base?: string): string {
  const normalized = normalizePath(path);
  // Keep the repository-root sentinel when no base is supplied. An empty
  // diagnostic obscures which broad scope the guard blocked.
  const target = normalized === '' && /^\.\/?$/.test(path.trim()) ? '.' : normalized;
  return base && !isAbsolutePath(target) ? normalizePath(`${base}/${target}`) : target;
}

/** Convert an absolute runtime target back to the repository-relative glob vocabulary. */
function relativeToInvocationCwd(path: string, invocationCwd?: string): string {
  const normalizedPath = normalizePath(path).replace(/\/$/, '');
  const normalized = normalizedPath === '' && /^\.\/?$/.test(path.trim()) ? '.' : normalizedPath;
  if (!invocationCwd || !isAbsolutePath(normalizePath(invocationCwd))) return normalized;
  const root = normalizePath(invocationCwd).replace(/\/$/, '');
  const pathForComparison = /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
  const rootForComparison = /^[a-z]:\//i.test(root) ? root.toLowerCase() : root;
  if (pathForComparison === rootForComparison) return '.';
  if (pathForComparison.startsWith(`${rootForComparison}/`)) {
    return normalized.slice(root.length + 1);
  }
  return normalized;
}

function effectiveToolCwd(toolInputCwd: unknown, invocationCwd?: string): string | undefined {
  if (typeof toolInputCwd !== 'string' || toolInputCwd.length === 0) return invocationCwd;
  if (!invocationCwd || isAbsolutePath(normalizePath(toolInputCwd))) return toolInputCwd;
  return resolveTargetPath(toolInputCwd, invocationCwd);
}

function matchesAny(path: string, patterns: RegExp[]): boolean {
  const normalized = normalizePath(path);
  return patterns.some((re) => re.test(normalized));
}

/** A glob-valued writer target describes a scope, not one concrete path. */
function isUnresolvedPathScope(path: string): boolean {
  return /[*?]/.test(path);
}

function isRootPathScope(path: string): boolean {
  const normalized = normalizePath(path).replace(/\/$/, '');
  return normalized === '.' || normalized === '';
}

/** A single list target without a file-like basename may denote a directory. */
function isDirectoryAmbiguousPath(path: string): boolean {
  const normalized = normalizePath(path).replace(/\/$/, '');
  if (isRootPathScope(normalized)) return true;
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return path.endsWith('/') || (basename.length > 0 && !basename.includes('.'));
}

function staticPrefix(pattern: string): string {
  const normalized = normalizePath(pattern);
  if (normalized === '.') return '';
  const wildcardIndex = normalized.search(/[*?]/);
  return (wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex)).replace(/\/$/, '');
}

interface WriteTarget {
  path: string;
  kind: 'file' | 'scope' | 'deletion-scope';
}

function hasPartialSegmentWildcard(pattern: string): boolean {
  const normalized = normalizePath(pattern);
  const wildcardIndex = normalized.search(/[*?]/);
  return wildcardIndex > 0 && normalized[wildcardIndex - 1] !== '/';
}

function globWitness(pattern: string): string {
  return pattern.replace(/\*+/g, '').replace(/\?/g, 'x');
}

function scopesMayOverlap(left: string, right: string): boolean {
  const normalizedRight = normalizePath(right);
  if (!normalizedRight.includes('/')) {
    const leftPrefix = staticPrefix(left);
    const candidate = leftPrefix
      ? `${leftPrefix}/${globWitness(normalizedRight)}`
      : globWitness(normalizedRight);
    return compilePathGlob(left).test(candidate);
  }
  const leftPrefix = staticPrefix(left);
  const rightPrefix = staticPrefix(right);
  // A leading wildcard can reach any directory, so an empty static prefix is
  // not evidence that two scopes are disjoint. Treat it conservatively as an
  // overlap; callers can exempt a fully allowed writer scope before this check.
  if (!leftPrefix || !rightPrefix) return true;
  if (
    leftPrefix === rightPrefix ||
    leftPrefix.startsWith(`${rightPrefix}/`) ||
    rightPrefix.startsWith(`${leftPrefix}/`)
  ) {
    return true;
  }
  // Wildcards inside a segment can extend their static prefix without a slash:
  // `src/foo*` reaches `src/foobar/**`.
  return (
    (hasPartialSegmentWildcard(left) && rightPrefix.startsWith(leftPrefix)) ||
    (hasPartialSegmentWildcard(right) && leftPrefix.startsWith(rightPrefix))
  );
}

function targetIntersectsPatterns(
  target: WriteTarget,
  patternTexts: string[],
  patterns: RegExp[],
): boolean {
  if (matchesAny(target.path, patterns)) return true;
  if (target.kind === 'file') return false;
  const normalized = normalizePath(target.path).replace(/\/$/, '');
  if (!isUnresolvedPathScope(normalized)) {
    if (normalized === '.' || normalized === '') return patternTexts.length > 0;
    const descendantScope = `${normalized}/**`;
    return patternTexts.some((pattern) => scopesMayOverlap(descendantScope, normalizePath(pattern)));
  }
  return patternTexts.some((pattern) => scopesMayOverlap(normalized, normalizePath(pattern)));
}

function targetFullyAllowed(target: WriteTarget, allowTexts: string[], allowRes: RegExp[]): boolean {
  if (target.kind === 'file') return matchesAny(target.path, allowRes);
  const normalized = normalizePath(target.path).replace(/\/$/, '');
  if (isUnresolvedPathScope(normalized)) {
    return allowTexts.some((allow, index) => {
      const allowNormalized = normalizePath(allow);
      if (allowNormalized === normalized) return true;
      const targetPrefix = staticPrefix(normalized);
      const allowRe = allowRes[index];
      return (
        targetPrefix.length > 0 &&
        !hasPartialSegmentWildcard(normalized) &&
        allowNormalized.endsWith('/**') &&
        allowRe?.test(targetPrefix)
      );
    });
  }
  // A concrete directory is fully covered only when an allow glob explicitly
  // includes every descendant beneath it. Allowing the directory entry alone
  // does not cover files the writer may change below it.
  return allowTexts.some((allow, index) => {
    const allowNormalized = normalizePath(allow);
    const allowRe = allowRes[index];
    return allowNormalized.endsWith('/**') && allowRe?.test(`${normalized}/.path-guard-probe`);
  });
}

/** Capabilities that mean "this call can change a file on disk". */
const WRITE_CAPABILITIES = new Set(['fs.write', 'fs.write.outside-project']);
const SHELL_CAPABILITIES = new Set(['shell.arbitrary', 'shell.restricted', 'shell.exec']);
const LEGACY_SHELL_TOOLS = new Set(['bash', 'shell', 'exec']);

/**
 * Writer names supported by older hosts that do not pass tool metadata.
 * Keep this compatibility list narrow: an unknown metadata-less tool cannot be
 * classified safely, while these built-ins have stable write semantics.
 */
const LEGACY_WRITE_TOOLS = new Set([
  'write',
  'edit',
  'patch',
  'scaffold',
  'format',
  'replace',
  'design',
]);

/**
 * Does this tool call write to disk?
 *
 * Filesystem-write capabilities are authoritative when declared. A broad
 * `mutating: true` flag is only a compatibility fallback when capabilities are
 * absent; otherwise non-filesystem mutators would be misclassified as writers.
 * Deliberately NOT "has a path field" — reading `.env` is
 * `injection-shield`'s and `secret-scanner`'s business, and blocking every read
 * of a protected path would make this plugin unusable.
 *
 * When a host supplies neither field the guard falls back to the tool names it
 * always covered. A security plugin declaring `failurePolicy: 'closed'` must
 * not quietly become a no-op against an older host.
 */
function writesToDisk(input: {
  toolName?: string | undefined;
  toolInput?: Record<string, unknown> | undefined;
  toolCapabilities?: readonly string[] | undefined;
  toolMutating?: boolean | undefined;
}): boolean {
  // A pure shell tool (shell-capable but NOT write-capable) writes to disk
  // only through destructive commands parsed from its `command` string by
  // the shell branch above. Don't let a broad `mutating: true` flag route a
  // benign shell call (e.g. `echo safe`) into the path-extraction path.
  // But a structured wrapper like `git` declares BOTH `shell.restricted`
  // AND `fs.write` — its pathspec fields still need extraction.
  const capabilities = input.toolCapabilities;
  const capabilitiesUndeclared = !capabilities || capabilities.length === 0;
  const hasWriteCap =
    capabilities?.some((capability) => WRITE_CAPABILITIES.has(capability)) ?? false;
  const hasCommandString = typeof input.toolInput?.['command'] === 'string';
  if (hasCommandString && executesShell(input) && !hasWriteCap) return false;
  if (!capabilitiesUndeclared) {
    if (capabilities.some((capability) => WRITE_CAPABILITIES.has(capability))) return true;

    // MCP mutability is inferred upstream from a deliberately small keyword
    // list. Filesystem servers commonly expose edit_file, appendFile, mkdir,
    // and similar writers that list misses, so classify those calls from the
    // qualified name plus a path-shaped input rather than trusting the flag.
    if (capabilities.includes('mcp.proxy')) {
      const segmentedName = (input.toolName ?? '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^a-z0-9]+/gi, '_')
        .toLowerCase();
      const filesystemWriter =
        /(?:^|_)filesystem(?:_|$)/.test(segmentedName) &&
        /(?:^|_)(?:add|append|copy|create|delete|edit|mkdir|move|remove|rename|write)(?:_|$)/.test(
          segmentedName,
        );
      const toolInput = input.toolInput ?? {};
      const hasKnownPath = [...PATH_FIELDS, ...PATH_LIST_FIELDS].some(
        (field) => toolInput[field] !== undefined,
      );
      if (filesystemWriter && hasKnownPath) return true;
    }
    return false;
  }
  if (input.toolMutating !== undefined) return input.toolMutating;
  return LEGACY_WRITE_TOOLS.has(input.toolName ?? '');
}

function executesShell(input: {
  toolName?: string | undefined;
  toolInput?: Record<string, unknown> | undefined;
  toolCapabilities?: readonly string[] | undefined;
  toolMutating?: boolean | undefined;
}): boolean {
  const toolName = input.toolName ?? '';
  if (LEGACY_SHELL_TOOLS.has(toolName)) return true;
  // `git.command` is a structured subcommand enum, not a shell program. Other
  // mutating tools with a command string must be inspected even when their
  // declared capability is a wrapper capability such as `mcp.proxy`.
  if (toolName === 'git') return false;
  const segmentedName = toolName.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  const isCommandStringRunner =
    /(?:^|[_.-])(?:command|exec|execute|shell|terminal)(?:$|[_.-])/i.test(segmentedName);
  const hasShellCapability =
    input.toolCapabilities?.some((capability) => SHELL_CAPABILITIES.has(capability)) ?? false;
  const hasCommandString = typeof input.toolInput?.['command'] === 'string';
  return (
    (isCommandStringRunner && hasShellCapability) ||
    (hasCommandString && input.toolMutating === true)
  );
}

/**
 * Field names tools use for "the file I am about to write".
 *
 * There is no schema convention to read this from, so it is a list — but a
 * list of FIELD names fails safe in a way a list of TOOL names does not: an
 * unknown field means the guard says nothing about a call it cannot parse,
 * whereas an unknown tool name meant the guard never ran at all.
 */
const PATH_FIELDS = [
  'path',
  'file_path',
  'filePath',
  'target',
  'target_path',
  'targetPath',
  'destination',
  'dest',
  'output_path',
  'outputPath',
  'out',
  'file',
] as const;
const PATH_LIST_FIELDS = ['files', 'paths'] as const;

const SOURCE_PATH_FIELDS = ['source', 'from', 'src', 'input_path', 'inputPath', 'old_path', 'oldPath'] as const;
const MOVE_TOOL_NAME = /(?:^|[_.-])(move|rename)(?:$|[_.-])/i;

function isMoveToolName(toolName: string): boolean {
  const segmented = toolName.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return MOVE_TOOL_NAME.test(segmented);
}

function cleanPatchPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '/dev/null') return null;
  const quoted = /^"([^"]+)"(?:\s|$)/.exec(trimmed)?.[1];
  const withoutTimestamp =
    quoted ?? trimmed.replace(/(?:\t|\s+)\d{4}-\d{2}-\d{2}(?:\s.*)?$/, '').trim();
  if (!withoutTimestamp || withoutTimestamp === '/dev/null') return null;
  return withoutTimestamp.replace(/^[ab]\//, '');
}

function pathsFromPatch(patch: string): string[] {
  const paths: string[] = [];
  const lines = patch.split(/\r?\n/);
  for (let index = 0; index + 2 < lines.length; index += 1) {
    const oldHeader = lines[index];
    const newHeader = lines[index + 1];
    const hunkHeader = lines[index + 2];
    if (!oldHeader?.startsWith('--- ') || !newHeader?.startsWith('+++ ')) continue;
    // A real unified-diff file header is followed by its first hunk. Requiring
    // that third line prevents removed/added body text beginning with ---/+++
    // from being mistaken for another target file.
    if (!hunkHeader?.startsWith('@@ ')) continue;
    const oldPath = cleanPatchPath(oldHeader.slice(4));
    const newPath = cleanPatchPath(newHeader.slice(4));
    if (oldPath) paths.push(oldPath);
    if (newPath) paths.push(newPath);
  }
  return paths;
}

function appendTarget(
  targets: WriteTarget[],
  value: unknown,
  kind: WriteTarget['kind'],
  base?: string,
): void {
  if (typeof value !== 'string' || value.length === 0) return;
  targets.push({
    path: resolveTargetPath(value, base),
    kind,
  });
}

function appendTargetList(
  targets: WriteTarget[],
  value: unknown,
  directoryCapable: boolean,
  base?: string,
): void {
  const appendPath = (path: string): void => {
    targets.push({
      path: resolveTargetPath(path, base),
      kind:
        isUnresolvedPathScope(path) ||
        isRootPathScope(path) ||
        (directoryCapable && isDirectoryAmbiguousPath(path))
          ? 'scope'
          : 'file',
    });
  };

  if (typeof value === 'string') {
    const paths = value
      .split(',')
      .map((item) => item.trim())
      .filter((path) => path.length > 0);
    for (const path of paths) appendPath(path);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const path = item.trim();
    if (path.length > 0) appendPath(path);
  }
}

function isReadOnlyInvocation(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName === 'git') {
    const command = toolInput['command'];
    if (
      command === 'status' ||
      command === 'log' ||
      command === 'diff' ||
      command === 'fetch' ||
      command === 'commit' ||
      command === 'branch' ||
      command === 'push'
    ) {
      return true;
    }
    return command === 'worktree' && toolInput['worktreeAction'] === 'list';
  }
  if (toolName === 'design') {
    const action = toolInput['action'] ?? 'list';
    return action === 'list' || action === 'foundations' || action === 'verify';
  }
  if (toolName === 'format') return toolInput['check'] === true;
  if (toolName === 'patch' || toolName === 'scaffold') return toolInput['dry_run'] === true;
  if (toolName === 'replace') return toolInput['dry_run'] !== false;
  return false;
}

function pathsFromToolInput(
  toolInput: Record<string, unknown>,
  toolName: string,
  invocationCwd?: string,
): WriteTarget[] {
  const targets: WriteTarget[] = [];
  const effectiveCwd = effectiveToolCwd(toolInput['cwd'], invocationCwd);
  for (const field of PATH_FIELDS) {
    const value = toolInput[field];
    appendTarget(
      targets,
      value,
      typeof value === 'string' && isUnresolvedPathScope(value) ? 'scope' : 'file',
      effectiveCwd,
    );
  }
  const directoryCapableLists = toolName === 'format' || toolName === 'replace';
  for (const field of PATH_LIST_FIELDS) {
    appendTargetList(
      targets,
      toolInput[field],
      directoryCapableLists && field === 'files',
      effectiveCwd,
    );
  }

  if (toolName === 'git') {
    const command = toolInput['command'];
    if (
      command === 'worktree' &&
      (toolInput['worktreeAction'] === 'add' || toolInput['worktreeAction'] === 'remove')
    ) {
      appendTarget(targets, toolInput['worktreePath'] ?? toolInput['worktree_path'], 'file');
    }
  }

  if (toolName === 'scaffold') {
    const cwdValue = toolInput['cwd'];
    const cwd =
      typeof cwdValue === 'string' && cwdValue.length > 0 ? cwdValue : (invocationCwd ?? '.');
    const base = normalizePath(cwd).replace(/\/$/, '');
    const name = typeof toolInput['name'] === 'string' ? toolInput['name'] : '';
    const template = toolInput['template'];
    const filesByTemplate: Record<string, string[]> = {
      'npm-package': ['package.json', 'tsconfig.json', 'src/index.ts', 'src/index.test.ts'],
      'cli-tool': ['package.json', 'src/index.ts'],
      'react-component': name ? [`${name}.tsx`, `${name}.test.tsx`] : [],
    };
    for (const file of typeof template === 'string' ? (filesByTemplate[template] ?? []) : []) {
      targets.push({ path: `${base}/${file}`, kind: 'file' });
    }
    targets.push({ path: base, kind: 'scope' });
  }

  if (isMoveToolName(toolName)) {
    for (const field of SOURCE_PATH_FIELDS) {
      appendTarget(targets, toolInput[field], 'file', effectiveCwd);
    }
  }

  const patch = toolInput['patch'];
  if (typeof patch === 'string') {
    const patchTargets = pathsFromPatch(patch);
    const directory = toolInput['directory'];
    const baseValue =
      typeof directory === 'string' && directory.length > 0 ? directory : invocationCwd;
    if (baseValue) {
      const base = normalizePath(baseValue).replace(/\/$/, '');
      targets.push(...patchTargets.map((target) => ({ path: `${base}/${target}`, kind: 'file' as const })));
    } else {
      targets.push(...patchTargets.map((path) => ({ path, kind: 'file' as const })));
    }
  }

  // This function is called only after the invocation has been classified as
  // a writer. If none of its fields describe a concrete target, fail closed on
  // the effective working directory rather than silently allowing an unknown
  // writer schema to bypass protection.
  if (targets.length === 0) {
    const cwd = effectiveCwd ?? '.';
    targets.push({ path: normalizePath(cwd).replace(/\/$/, '') || '.', kind: 'scope' });
  }

  const seen = new Set<string>();
  return targets
    .map((target) => ({
      ...target,
      path: relativeToInvocationCwd(target.path, invocationCwd),
    }))
    .filter((target) => {
      const key = `${target.kind}:${target.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Human-readable verb for the refusal message. */
function operationLabel(toolName: string): string {
  if (toolName === 'write') return 'write';
  if (toolName === 'edit') return 'edit';
  return `write via "${toolName}"`;
}

/**
 * Extract candidate target paths from a shell command, but only when
 * the command looks destructive. Non-destructive commands (cat, ls,
 * grep …) never trigger the guard, even if they mention a protected
 * path.
 */
export function destructiveTargets(command: string): string[] {
  // `env [NAME=value ...] command` is a transparent launcher for the command
  // being guarded; strip it before applying the anchored command patterns.
  const normalizedCommand = command.replace(
    /(^|[;&|]\s*)env(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]+)*\s+/gi,
    '$1',
  );
  const targets: string[] = [];
  const quotedIndexes = new Uint8Array(normalizedCommand.length);
  let activeQuote: "'" | '"' | null = null;
  for (let index = 0; index < normalizedCommand.length; index += 1) {
    const char = normalizedCommand[index];
    if ((char === "'" || char === '"') && normalizedCommand[index - 1] !== '\\') {
      quotedIndexes[index] = 1;
      activeQuote = activeQuote === char ? null : activeQuote === null ? char : activeQuote;
    } else if (activeQuote !== null) {
      quotedIndexes[index] = 1;
    }
  }
  const tokenIsQuoted = (match: RegExpExecArray, token: string): boolean => {
    const offset = match[0].toLowerCase().indexOf(token.toLowerCase());
    return offset >= 0 && quotedIndexes[match.index + offset] === 1;
  };
  const shellTokens = (raw: string): string[] =>
    (raw.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map((arg) =>
      arg.replace(/^['"]|['"]$/g, ''),
    );
  const shellArgs = (raw: string): string[] =>
    shellTokens(raw).filter((arg) => arg.length > 0 && !arg.startsWith('-'));

  // rm/rmdir/del/unlink/truncate/mv/shred <args...>, including xargs wrappers.
  const destructive =
    /(?:^|[;&|]\s*|\bxargs(?:\s+-[^\s]+)*\s+)(?:sudo\s+)?(rm|rmdir|del|unlink|truncate|shred|mv)\s+([^;&|]+)/gi;
  let m: RegExpExecArray | null = destructive.exec(normalizedCommand);
  while (m !== null) {
    // For `mv src dst` both sides are candidates (overwrite either way).
    if (!tokenIsQuoted(m, m[1] ?? '')) targets.push(...shellArgs(m[2] ?? ''));
    m = destructive.exec(normalizedCommand);
  }

  // Copy/install normally write their final non-option operand, but GNU's
  // target-directory options name the destination before the sources.
  const copy = /(?:^|[;&|]\s*)(?:sudo\s+)?(cp|install)\s+([^;&|]+)/gi;
  let c: RegExpExecArray | null = copy.exec(normalizedCommand);
  while (c !== null) {
    if (tokenIsQuoted(c, c[1] ?? '')) {
      c = copy.exec(normalizedCommand);
      continue;
    }
    const tokens = shellTokens(c[2] ?? '');
    let destination: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === '-t' || token === '--target-directory') {
        destination = tokens[index + 1];
        break;
      }
      if (token?.startsWith('--target-directory=')) {
        destination = token.slice('--target-directory='.length);
        break;
      }
    }
    destination ??= tokens.filter((arg) => arg.length > 0 && !arg.startsWith('-')).at(-1);
    if (destination) targets.push(destination);
    c = copy.exec(normalizedCommand);
  }

  // tee writes every file operand; stdin is not a path target.
  const tee = /(?:^|[;&|]\s*)(?:sudo\s+)?(tee)\s+([^;&|]+)/gi;
  let t: RegExpExecArray | null = tee.exec(normalizedCommand);
  while (t !== null) {
    if (!tokenIsQuoted(t, t[1] ?? '')) targets.push(...shellArgs(t[2] ?? ''));
    t = tee.exec(normalizedCommand);
  }

  // dd uses an assignment-style output operand. Scope `of=` extraction to an
  // actual dd command so benign command arguments such as `echo of=.env` do
  // not become destructive targets.
  const dd = /(?:^|[;&|]\s*)(?:sudo\s+)?(dd)\s+([^;&|]+)/gi;
  let d: RegExpExecArray | null = dd.exec(normalizedCommand);
  while (d !== null) {
    if (!tokenIsQuoted(d, d[1] ?? '')) {
      const outputMatch = /(?:^|\s)of=("[^"]*"|'[^']*'|[^\s]+)/i.exec(d[2] ?? '');
      const output = outputMatch?.[1]?.replace(/^['"]|['"]$/g, '');
      if (output) targets.push(output);
    }
    d = dd.exec(normalizedCommand);
  }

  // In-place sed overwrites every file operand after its script; forced links
  // overwrite their final destination operand.
  const overwrite = /(?:^|[;&|]\s*)(?:sudo\s+)?(sed|ln)\s+([^;&|]+)/gi;
  let o: RegExpExecArray | null = overwrite.exec(normalizedCommand);
  while (o !== null) {
    const rawArgs = o[2] ?? '';
    const tool = o[1]?.toLowerCase();
    if (tool && tokenIsQuoted(o, tool)) {
      o = overwrite.exec(normalizedCommand);
      continue;
    }
    if (tool === 'sed' && /(?:^|\s)-i(?:[^\s]*)?(?:\s|$)/.test(rawArgs)) {
      const args = shellArgs(rawArgs);
      // `shellArgs` removes options. The first remaining operand is sed's
      // script; every subsequent operand is a file modified in place.
      targets.push(...args.slice(1));
    } else if (tool === 'ln' && /(?:^|\s)-[^\s]*f[^\s]*(?:\s|$)/.test(rawArgs)) {
      const destination = shellArgs(rawArgs).at(-1);
      if (destination) targets.push(destination);
    }
    o = overwrite.exec(normalizedCommand);
  }

  // Simple producer pipelines expose xargs' destructive stdin paths inline.
  const xargsPipeline =
    /\b(?:echo|printf)\s+([^|]+)\|\s*xargs(?:\s+-[^\s]+)*\s+(?:sudo\s+)?(?:rm|rmdir|del|unlink|truncate|shred)\b/gi;
  let x: RegExpExecArray | null = xargsPipeline.exec(normalizedCommand);
  while (x !== null) {
    if (!tokenIsQuoted(x, 'xargs')) targets.push(...shellArgs(x[1] ?? ''));
    x = xargsPipeline.exec(normalizedCommand);
  }

  // Shell `-c` wrappers carry another command string inside quotes.
  const shellWrapper = /\b(?:ba|z|k)?sh\s+-c\s+(['"])(.*?)\1/gi;
  let w: RegExpExecArray | null = shellWrapper.exec(normalizedCommand);
  while (w !== null) {
    if (w[2] && !tokenIsQuoted(w, w[0].split(/\s/)[0] ?? '')) {
      targets.push(...destructiveTargets(w[2]));
    }
    w = shellWrapper.exec(normalizedCommand);
  }

  // Output redirection outside quoted spans: `... > file` / `... >> "file with spaces"`.
  // Heredoc bodies are literal stdin, so redirect-looking lines inside them
  // must not be classified as writes.
  const heredocBodyLines = new Set<number>();
  const commandLines = command.split(/\r?\n/);
  let activeHeredoc: string | null = null;
  for (let lineIndex = 0; lineIndex < commandLines.length; lineIndex += 1) {
    const line = commandLines[lineIndex] ?? '';
    if (activeHeredoc !== null) {
      heredocBodyLines.add(lineIndex);
      if (line.trim() === activeHeredoc) activeHeredoc = null;
      continue;
    }
    const delimiter = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([^\s;&|]+))/.exec(line);
    activeHeredoc = delimiter?.[1] ?? delimiter?.[2] ?? delimiter?.[3] ?? null;
  }

  let quote: "'" | '"' | null = null;
  let lineIndex = 0;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === '\n') {
      lineIndex += 1;
      quote = null;
      continue;
    }
    if (heredocBodyLines.has(lineIndex)) continue;
    if ((char === "'" || char === '"') && command[index - 1] !== '\\') {
      quote = quote === char ? null : quote === null ? char : quote;
      continue;
    }
    if (quote !== null || char !== '>') continue;
    const redirectsBothStreams = command[index + 1] === '&';
    if (redirectsBothStreams || command[index + 1] === '>') index += 1;
    while (command[index + 1] === ' ' || command[index + 1] === '\t') index += 1;
    const targetQuote = command[index + 1];
    let end = index + 1;
    let target: string;
    if (targetQuote === "'" || targetQuote === '"') {
      end = command.indexOf(targetQuote, index + 2);
      if (end === -1) continue;
      target = command.slice(index + 2, end);
    } else {
      while (end < command.length && !/[\s;&|>]/.test(command[end] ?? '')) end += 1;
      target = command.slice(index + 1, end);
    }
    // `2>&1` and `>&-` duplicate/close descriptors; Bash's `>& path`
    // and `>&path` forms instead open a file and redirect both streams.
    if (target && !(redirectsBothStreams && (/^\d+$/.test(target) || target === '-'))) {
      targets.push(target);
    }
    index = end;
  }
  return [
    ...new Set(
      targets
        .map((target) => target.replace(/^['"]|['"]$/g, ''))
        .filter((target) => target !== '/dev/null' && target.toLowerCase() !== 'nul'),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'path-guard',
  version: '0.1.0',
  description:
    'Blocks or warns about writes, edits, and destructive shell commands touching protected paths (lockfiles, .env, .git, migrations)',
  apiVersion: '^0.1.10',
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      mode: {
        type: 'string',
        enum: ['block', 'warn'],
        default: 'block',
        description: 'block = refuse the operation; warn = only inject context.',
      },
      protect: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Glob patterns for protected paths. Replaces the default set when present. Writer globs whose unresolved scope overlaps protection are blocked; narrow the target or add an `allow` glob.',
      },
      allow: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description: 'Glob patterns that override `protect` (exemptions).',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocations = 0;
    state.blocks = 0;
    state.warns = 0;
    state.lastBlock = null;
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['path-guard']);
    const protectRes = cfg.protect.map(compilePathGlob);
    const allowRes = cfg.allow.map(compilePathGlob);

    const verdict = (path: string, tool: string, operation: string, isScope = false) => {
      const subject = isScope
        ? `write scope "${path}" may include a protected path — narrow it or add an \`allow\` glob`
        : `"${path}" is a protected path`;
      const matchContext = isScope
        ? 'its unresolved scope overlaps config.extensions["path-guard"].protect'
        : 'matched by config.extensions["path-guard"].protect';
      if (cfg.mode === 'block') {
        state.blocks += 1;
        state.lastBlock = { path, tool, when: new Date().toISOString() };
        api.metrics.counter('blocks');
        return {
          decision: 'block' as const,
          reason:
            `path-guard: ${subject} (${matchContext}) — ${operation} refused. ` +
            'If this change is intentional, ask the user to do it, add an `allow` glob, or set mode: "warn".',
        };
      }
      state.warns += 1;
      api.metrics.counter('warns');
      return {
        decision: 'allow' as const,
        additionalContext:
          `path-guard (warn mode): ${subject} and this ${operation} would modify it. ` +
          'Double-check this is intentional.',
      };
    };

    const hook = (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolCapabilities?: readonly string[] | undefined;
      toolMutating?: boolean | undefined;
      cwd?: string | undefined;
    }) => {
      if (!cfg.enabled) return;
      state.invocations += 1;
      const toolName = input.toolName ?? '';
      const ti = (input.toolInput ?? {}) as Record<string, unknown>;

      // Shell first: the target is inside a command string, not a path field,
      // and only DESTRUCTIVE commands are this plugin's business.
      const command = typeof ti['command'] === 'string' ? ti['command'] : '';
      const commandArgs = Array.isArray(ti['args'])
        ? ti['args'].filter((arg): arg is string => typeof arg === 'string')
        : [];
      // `exec` supplies operands as argv rather than embedding them in command.
      // Preserve simple flags/paths verbatim and quote complex argv entries so
      // shell metacharacters remain data while the target parser can see them.
      const commandForInspection = [
        command,
        ...commandArgs.map((arg) => (/^[\w./:@%+=,-]+$/.test(arg) ? arg : JSON.stringify(arg))),
      ].join(' ');
      if (
        command &&
        executesShell({
          toolName: input.toolName,
          toolInput: ti,
          toolCapabilities: input.toolCapabilities,
          toolMutating: input.toolMutating,
        })
      ) {
        const shellTargets = destructiveTargets(commandForInspection);
        const effectiveCwd = effectiveToolCwd(ti['cwd'], input.cwd);
        const recursivelyDeletes =
          /(?:^|[;&|]\s*|\bxargs(?:\s+-[^\s]+)*\s+)(?:sudo\s+)?(?:rm\s+(?:-[^\s]*[rR][^\s]*\s+)+|rmdir\b|del\s+\/[^\s]*[sS][^\s]*\s+)/i.test(
            commandForInspection,
          );
        for (const path of shellTargets) {
          const target: WriteTarget = {
            path: relativeToInvocationCwd(resolveTargetPath(path, effectiveCwd), input.cwd),
            kind:
              isUnresolvedPathScope(path) || recursivelyDeletes ? 'deletion-scope' : 'file',
          };
          if (targetFullyAllowed(target, cfg.allow, allowRes)) continue;
          const protectedShellTarget =
            targetIntersectsPatterns(target, cfg.protect, protectRes) ||
            matchesAny(`${target.path.replace(/\/$/, '')}/.path-guard-probe`, protectRes);
          if (protectedShellTarget) {
            return verdict(
              target.path,
              toolName,
              'destructive shell command',
              target.kind !== 'file',
            );
          }
        }
        // A parsed shell command with no destructive target is safe to stop
        // here unless the wrapper also exposes an explicit structured write
        // target. Otherwise a benign `exec` call whose descriptor broadly
        // declares `fs.write` falls through as a pathless writer and invents a
        // repository-root scope. Dual-capability wrappers with output/path or
        // patch fields must still continue into structured target inspection.
        const hasStructuredTarget =
          [...PATH_FIELDS, ...PATH_LIST_FIELDS].some((field) => ti[field] !== undefined) ||
          typeof ti['patch'] === 'string';
        if (
          !writesToDisk({ ...input, toolInput: ti }) ||
          (shellTargets.length === 0 && !hasStructuredTarget)
        ) {
          return;
        }
      }

      // Everything else: any tool that WRITES and names a path.
      //
      // This used to be `toolName === 'write' || toolName === 'edit'`, with the
      // hook registered for four names. `patch`, `scaffold`, every
      // plugin-registered writer and every MCP filesystem server wrote straight
      // past it — a protected path was guarded through four doors and open
      // through the rest. The tool's own declaration is the durable answer:
      // a name list cannot cover a plugin that has not been written yet.
      if (!writesToDisk({ ...input, toolInput: ti }) || isReadOnlyInvocation(toolName, ti)) return;
      const targets = pathsFromToolInput(ti, toolName, input.cwd);
      for (const target of targets) {
        if (targetFullyAllowed(target, cfg.allow, allowRes)) continue;
        if (targetIntersectsPatterns(target, cfg.protect, protectRes)) {
          return verdict(target.path, toolName, operationLabel(toolName), target.kind === 'scope');
        }
      }
      return;
    };

    state.hookUnregister = api.registerHook('PreToolUse', '*', hook as never, {
      name: 'path-guard',
      stage: 'validate',
      failurePolicy: 'closed',
      policy: true,
    });

    // ── path_guard_status tool ────────────────────────────────────────
    api.tools.register({
      name: 'path_guard_status',
      description:
        'Reports path-guard state: protected globs, mode, and counters (invocations, blocks, warns).',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          mode: cfg.mode,
          protect: cfg.protect,
          allow: cfg.allow,
          counters: {
            invocations: state.invocations,
            blocks: state.blocks,
            warns: state.warns,
          },
          lastBlock: state.lastBlock,
        };
      },
    });

    api.log.info('path-guard plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      mode: cfg.mode,
      protectCount: cfg.protect.length,
    });
  },

  teardown(api) {
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    const final = { invocations: state.invocations, blocks: state.blocks, warns: state.warns };
    state.invocations = 0;
    state.blocks = 0;
    state.warns = 0;
    state.lastBlock = null;
    api.log.info('path-guard: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message:
        state.lastBlock === null
          ? `path-guard: ${state.invocations} invocation(s), ${state.blocks} block(s), ${state.warns} warn(s)`
          : `path-guard: last block on "${state.lastBlock.path}" (${state.lastBlock.tool}) at ${state.lastBlock.when}`,
      counters: {
        invocations: state.invocations,
        blocks: state.blocks,
        warns: state.warns,
      },
    };
  },
};

export default plugin;
