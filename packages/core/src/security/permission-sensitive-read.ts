import { realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { wstackGlobalRoot } from '../utils/wstack-paths.js';
import { hasCapability, ToolCapabilities } from './capabilities.js';
import { getInputString } from './yolo-risk.js';

/**
 * Every path-like string a write-capable tool input may carry. Shared by both
 * permission policies so a new write-target key recognized here protects the
 * leader and its subagents in the same edit (the same contract as
 * {@link isSensitiveReadCall}).
 *
 * VULN-001 Phase 2: takes the TOOL as well as the input. A tool may declare
 * its real destinations through `Tool.writeTargets` — necessary when they
 * live inside a payload body (patch text, config payloads) that the key list
 * below cannot see. Declared destinations are UNIONED with the key list
 * (never a replacement) so the gate can only grow stricter, and a throwing
 * hook degrades to the key-list heuristic rather than failing permission
 * evaluation.
 */
/**
 * Path-bearing input keys this gate inspects.
 *
 * The list was singular-only (`path`, `file`, `target`, …), so a tool whose
 * path field is PLURAL was structurally invisible here — `collab_debug` reads
 * every entry of `targetPaths` and one character kept it off this list
 * (WS-2026-09-17-01). Plural keys carry arrays, so the value scan below handles
 * both shapes; a key that is merely absent costs nothing.
 */
export const SENSITIVE_PATH_INPUT_KEYS = [
  'path',
  'paths',
  'file',
  'files',
  'file_path',
  'file_paths',
  'filePath',
  'filePaths',
  'target',
  'targets',
  'targetPath',
  'targetPaths',
] as const;

export function shellCommandLineFromInput(input: unknown): string | undefined {
  const command =
    getInputString(input, 'command') ??
    getInputString(input, 'cmd') ??
    getInputString(input, 'script');
  if (!command) return undefined;
  if (!input || typeof input !== 'object') return command;
  const args = (input as Record<string, unknown>)['args'];
  if (!Array.isArray(args) || args.length === 0) return command;
  const renderedArgs = args
    .filter((arg): arg is string => typeof arg === 'string')
    .map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg));
  return [command, ...renderedArgs].join(' ');
}

/** Bounds for the structured-command walk — tool inputs are model-supplied. */
export const MAX_COMMAND_SCAN_DEPTH = 8;

export const MAX_COMMAND_SCAN_NODES = 2000;

function renderArgv(argv: readonly string[]): string {
  return argv.map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(' ');
}

/**
 * Every command line a shell-surface tool's input can run.
 *
 * `shellCommandLineFromInput` reads the top-level string only — the shape of
 * `bash`/`exec`. Tools that declare `shell.arbitrary` may take structured
 * commands instead: the workflow plugins run `{ program, args }` objects, at
 * the top (`command`) or nested (`criteria[].command`, `checks[]`). Reading
 * only the string shape left those calls unclassified, so YOLO auto-approved
 * them — the locked `agent-state` kind included (WS-2026-09-26-03).
 *
 * `truncated` is set when the walk hit its bounds: the unread part could hold
 * a command, so callers must not read the call as clean. A model can put a
 * large unrelated field ahead of the real one to exhaust a budget.
 */
export function shellCommandLinesFromInput(input: unknown): {
  lines: string[];
  truncated: boolean;
} {
  const lines: string[] = [];
  const top = shellCommandLineFromInput(input);
  if (top) lines.push(top);
  let nodes = 0;
  let truncated = false;
  const visit = (node: unknown, depth: number): void => {
    if (truncated || !node || typeof node !== 'object') return;
    if (depth > MAX_COMMAND_SCAN_DEPTH || ++nodes > MAX_COMMAND_SCAN_NODES) {
      truncated = true;
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    const program = record['program'];
    if (typeof program === 'string' && program.trim()) {
      const args = Array.isArray(record['args'])
        ? record['args'].filter((arg): arg is string => typeof arg === 'string')
        : [];
      lines.push(renderArgv([program, ...args]));
    }
    for (const value of Object.values(record)) visit(value, depth + 1);
  };
  visit(input, 0);
  return { lines, truncated };
}

// ── Sensitive-read detection ─────────────────────────────────────────────

const SENSITIVE_READ_PATHS: RegExp[] = [
  /(?:^|[\\/])\.env(?:[.\w-]*)?$/i,
  /(?:^|[\\/])\.npmrc$/i,
  /(?:^|[\\/])\.pypirc$/i,
  /(?:^|[\\/])\.netrc$/i,
  /(?:^|[\\/])id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  /(?:^|[\\/])\.aws[\\/]credentials$/i,
  /(?:^|[\\/])\.kube[\\/]config$/i,
  /(?:^|[\\/])(?:secrets?|tokens?|credentials?|private[_-]?keys?)$/i,
  /(?:^|[\\/])[^\\/]*(?:secret|token|credential|private[_-]?key)[^\\/]*(?:\.json|\.ya?ml|\.toml|\.ini|\.txt|\.env|\.properties|\.key|\.pem)$/i,
];

const SHELL_READ_VERBS = new Set([
  'cat',
  'type',
  'get-content',
  'gc',
  'more',
  'less',
  'head',
  'tail',
  'grep',
  'rg',
  'sed',
  'awk',
  'findstr',
  'select-string',
  'strings',
  'cp',
  'copy',
  'scp',
]);

function stripShellQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

/**
 * Files under the wstack global root that constitute WrongStack's own trusted
 * state. Reading or writing one of these is qualitatively different from
 * touching the memory/session/skill files that share the directory:
 *
 * - `config.json` / `config.local.json` — merged as a **fully trusted** config
 *   layer (unlike in-project config, which is stripped). `hooks`, `mcpServers`
 *   and `plugins` survive here and become code execution at next boot.
 * - `trust.json` — the persisted permission allow/deny globs. A write here can
 *   disable every future confirmation prompt.
 * - `auth.json` — HQ browser/client tokens.
 * - `.key` — the AES-256-GCM secret-vault key.
 *
 * Deliberately basename-scoped rather than directory-scoped: `~/.wrongstack`
 * also holds `memory.md`, `sessions/`, and `skills/`, which the agent reads
 * constantly. Treating the whole tree as sensitive would make the prompt
 * meaningless through sheer volume.
 */
const AGENT_STATE_SENSITIVE_BASENAMES =
  // F1 (SECRETS-002): the previous `$`-anchored regex missed
  // `config.json.last` and `config.json.<ts>.bak` — verbatim copies
  // of the live config (secrets included) written by `config-history`.
  // The `(?:\\..+)?` captures the dot-suffix so the prompt fires for
  // any backup the writer produces, while the still-anchored `^…$`
  // keeps the prompt narrow (we still don't want every file under
  // `~/.wrongstack` to trip this).
  /^(?:config(?:\.local)?\.json(?:\..+)?|trust\.json|auth\.json|\.key)$/i;

/** Undo `escapeGlobSubject`'s backslash escapes so a subject compares as a path. */
function unescapeGlobSubject(value: string): string {
  return value.replace(/\\([*?[\]])/g, '$1');
}

/** Normalize a path for prefix comparison: forward slashes, case-folded on Windows. */
/**
 * Drop an NTFS alternate-data-stream suffix from the final path segment.
 *
 * On Windows `fs` resolves `.env::$DATA` to the *same file* as `.env` — reading
 * it returns the contents, and writing through `config.json::$DATA` overwrites
 * `config.json`. Every pattern in {@link SENSITIVE_READ_PATHS} and
 * {@link AGENT_STATE_SENSITIVE_BASENAMES} is `$`-anchored, so the suffix made
 * them all miss: `read` is `permission: 'auto'`, which turned
 * `{"path": ".env::$DATA"}` into a silent credential read, and it likewise
 * slipped past the YOLO agent-state write guard.
 *
 * Only the last segment is trimmed, and only past the first colon in it, so a
 * `C:/...` drive letter (its own leading segment) is untouched.
 */
function stripAdsSuffix(forwardSlashPath: string): string {
  const cut = forwardSlashPath.lastIndexOf('/');
  const dir = cut === -1 ? '' : forwardSlashPath.slice(0, cut + 1);
  const base = cut === -1 ? forwardSlashPath : forwardSlashPath.slice(cut + 1);
  const colon = base.indexOf(':');
  // `cut === -1 && colon === 1` is a bare drive spec like `C:` — leave it.
  if (colon === -1 || (cut === -1 && colon === 1 && base.length <= 2)) return forwardSlashPath;
  return dir + base.slice(0, colon);
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  return p.replace(/^~([\\/])/, (_, sep) => `${os.homedir()}${sep}`);
}

function normalizeForCompare(value: string): string {
  const expanded = expandHome(unescapeGlobSubject(value));
  const forward = stripAdsSuffix(expanded.replace(/\\/g, '/').replace(/\/+$/, ''));
  return process.platform === 'win32' ? forward.toLowerCase() : forward;
}

/**
 * Realpath of `p`'s deepest existing ancestor with the not-yet-created tail
 * re-joined (a write target may not exist yet), or `p` itself when nothing
 * resolves (e.g. the root does not exist yet on first boot).
 */
function realpathOfNearestExisting(p: string): string {
  let probe = expandHome(p);
  const tail: string[] = [];
  for (;;) {
    try {
      // `.native`, not the JS `realpathSync`: on Windows only the native call
      // expands an 8.3 short name (`WRONGS~1` → `.wrongstack`). The JS version
      // keeps the alias verbatim, so `~/WRONGS~1/config.json` — the same file —
      // never matched the root and was read silently. Matches the probe in
      // agent-state-sensitivity.ts, which already used `.native`.
      const real = realpathSync.native(probe);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return expandHome(p);
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * Realpaths of the agent-state root, keyed by the root's lexical form. The
 * root is stable for a given `WRONGSTACK_HOME`/home value, so the sync
 * realpath probe runs once per distinct root rather than per evaluation.
 */
const agentStateRootRealCache = new Map<string, string>();

/**
 * True when `absPath` is the wstack global root (`~/.wrongstack`, or
 * `WRONGSTACK_HOME`) or lives inside it.
 *
 * Callers use this to refuse *silent* access to WrongStack's own state. It is
 * not a containment check — the file tools deliberately allow this root so the
 * agent can manage its memory and sessions. What it gates is whether that
 * access may happen without the user seeing it.
 *
 * The comparison is realpath-aware on both sides: `~/.wrongstack` may itself
 * be a symlink, and the file tools canonicalize subjects to realpaths
 * (`safeResolveReal`, WS-048), so a purely lexical check misses every state
 * file under a symlinked root. The lexical pass stays first — it is free and
 * correct for the default layout — and the realpath pass only runs when it
 * fails, comparing the root (cached) against the subject's nearest existing
 * ancestor.
 */
export function isInsideAgentStateRoot(absPath: string): boolean {
  const lexicalRoot = normalizeForCompare(path.resolve(wstackGlobalRoot()));
  if (!lexicalRoot) return false;
  const target = normalizeForCompare(absPath);
  if (target === lexicalRoot || target.startsWith(`${lexicalRoot}/`)) return true;

  let realRoot = agentStateRootRealCache.get(lexicalRoot);
  if (realRoot === undefined) {
    realRoot = normalizeForCompare(realpathOfNearestExisting(path.resolve(wstackGlobalRoot())));
    agentStateRootRealCache.set(lexicalRoot, realRoot);
  }
  // No `realRoot === lexicalRoot` short-circuit: an unlinked root says nothing
  // about the SUBJECT, which can still reach the root through an alias spelling
  // (8.3 short name, a link elsewhere) that only its own realpath reveals.
  if (!realRoot) return false;
  const realTarget = normalizeForCompare(realpathOfNearestExisting(absPath));
  return realTarget === realRoot || realTarget.startsWith(`${realRoot}/`);
}

/**
 * True when writing `absPath` must not be silently auto-approved, because the
 * file is part of WrongStack's own trusted state rather than project content.
 */
export function isProtectedAgentStatePath(absPath: string): boolean {
  if (!isInsideAgentStateRoot(absPath)) return false;
  return AGENT_STATE_SENSITIVE_BASENAMES.test(path.basename(normalizeForCompare(absPath)));
}

function pathLooksSensitive(rawPath: string): boolean {
  // ADS strip before matching — see stripAdsSuffix. `.env::$DATA` reads `.env`,
  // but every pattern below is `$`-anchored and would miss it.
  const unquoted = expandHome(stripShellQuotes(rawPath));
  const normalized = stripAdsSuffix(unquoted.replace(/\\/g, '/'));
  if (SENSITIVE_READ_PATHS.some((pattern) => pattern.test(normalized))) return true;
  // `config.json` alone is far too common to put in SENSITIVE_READ_PATHS — it
  // would fire on nearly every project. Anchoring it to the global root keeps
  // the match precise.
  return isProtectedAgentStatePath(normalized);
}

/** Depth-1 scan: a string value, or any string inside an array value. */
function valueLooksSensitive(value: unknown): boolean {
  if (typeof value === 'string') return pathLooksSensitive(value);
  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === 'string' && pathLooksSensitive(entry));
  }
  return false;
}

export function inputPathLooksSensitive(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const obj = input as Record<string, unknown>;
  for (const key of SENSITIVE_PATH_INPUT_KEYS) {
    if (valueLooksSensitive(obj[key])) return true;
  }
  return false;
}

export function shellCommandReadsSensitivePath(command: string): boolean {
  const tokens =
    command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => stripShellQuotes(token).toLowerCase()) ??
    [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (!SHELL_READ_VERBS.has(token)) continue;
    const rest = tokens.slice(i + 1);
    if (rest.some((arg) => pathLooksSensitive(arg))) return true;
  }
  return false;
}

/**
 * True when `tool` + `input` amount to reading a credential-bearing path.
 *
 * Shared by both permission policies. It lived as a private method on
 * `DefaultPermissionPolicy`, so `AutoApprovePermissionPolicy` — the policy
 * subagents run under — had no way to apply it, and a delegated read of
 * `~/.aws/credentials` was auto-approved where the leader would have prompted.
 * Keeping one implementation here means widening the sensitive-path list
 * protects the leader and its subagents in the same edit.
 */
export function isSensitiveReadCall(tool: Tool, input: unknown): boolean {
  const isReadTool =
    hasCapability(tool, ToolCapabilities.FS_READ) ||
    tool.name === 'read' ||
    tool.name === 'grep' ||
    tool.name === 'glob' ||
    tool.name === 'tree';
  if (isReadTool && inputPathLooksSensitive(input)) return true;

  const hasShellCap = hasCapability(tool, [
    ToolCapabilities.SHELL_ARBITRARY,
    ToolCapabilities.SHELL_RESTRICTED,
    ToolCapabilities.SHELL_EXEC,
  ]);
  if (!hasShellCap && tool.name !== 'bash' && tool.name !== 'shell' && tool.name !== 'exec') {
    return false;
  }
  return shellCommandLinesFromInput(input).lines.some(shellCommandReadsSensitivePath);
}
