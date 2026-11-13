/**
 * Which writes under the wstack global root (`~/.wrongstack`, or
 * `WRONGSTACK_HOME`) are agent-state — the locked approval kind that prompts
 * even under YOLO.
 *
 * The root is always reachable by the file tools, and most of what lives there
 * is the agent's own working state: project plans, goals, specs, SDD boards,
 * project memory, caches, logs, tool output, the prompt library. Gating all of
 * it made routine work stop for approval with no reason the user could see.
 * What stays gated is the state a silent write could turn against the user:
 *
 * - **code that runs** — `plugins/` (loaded at boot), `updates/` (`pending.json`
 *   names the executable swapped in at exit), `automation/` (scheduled
 *   unattended runs), and every `config*.json` (`hooks` / `mcpServers` /
 *   `plugins` run at boot) with its backups in `config-history/`;
 * - **approval itself** — `trust.json`, `plugin-trust.json`, and session
 *   journals under `projects/<slug>/sessions/`, whose `permission_overrides`
 *   come back live on resume;
 * - **secrets and egress** — `.key`, `auth.json`, `sync.json`;
 * - **instructions every session obeys** — the profile's `instructions/`,
 *   `skills/` and `memory.md`, and the global `AGENTS.md`: a planted line there
 *   reaches the system prompt of every future session in every project.
 *
 * A leaf among the security modules so both the policy (`permission-helpers.ts`) and
 * the shell detector (`yolo-state-risk.ts`) can share one list without an
 * import cycle.
 */

import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { wstackGlobalRoot } from '../utils/wstack-paths.js';

/** Basenames that are sensitive wherever they sit under the root. */
const SENSITIVE_BASENAMES =
  /^(?:config(?:\.local)?\.json(?:\..+)?|trust\.json|plugin-trust\.json|auth\.json|sync\.json|adversary\.md|\.key)$/i;

/** Subtrees (root-relative, forward slashes) whose every write is sensitive. */
const SENSITIVE_SUBTREES: readonly RegExp[] = [
  /^plugins(?:\/|$)/i,
  /^updates(?:\/|$)/i,
  /^automation(?:\/|$)/i,
  /^config-history(?:\/|$)/i,
  /^projects\/[^/]+\/sessions(?:\/|$)/i,
  /^projects\/[^/]+\/decisions(?:\/|$)/i,
  /^profiles\/[^/]+\/(?:instructions|skills)(?:\/|$)/i,
  /^(?:profiles\/[^/]+\/)?memory\.md$/i,
  /^agents\.md$/i,
];

/**
 * Directories an archive must not be extracted into: the root, the subtrees
 * above, and every directory a sensitive basename is LOADED from — extraction
 * writes whatever names the archive carries, so a benign-looking target like
 * `profiles/default` can still drop a `config.json`.
 */
const SENSITIVE_EXTRACTION_DIRS = /^(?:|profiles(?:\/[^/]+)?|projects(?:\/[^/]+)?|hq)$/i;

function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * True when a write to `rel` (a path relative to the global root) is
 * agent-state. The root itself counts: a write naming the directory replaces
 * or removes everything in it.
 */
export function isSensitiveAgentStateRelPath(rel: string): boolean {
  const normalized = normalizeRel(rel);
  if (normalized === '') return true;
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (SENSITIVE_BASENAMES.test(basename)) return true;
  return SENSITIVE_SUBTREES.some((pattern) => pattern.test(normalized));
}

/** True when extracting an archive into `rel` could plant agent-state. */
export function isSensitiveAgentStateExtractionDir(rel: string): boolean {
  const normalized = normalizeRel(rel);
  return SENSITIVE_EXTRACTION_DIRS.test(normalized) || isSensitiveAgentStateRelPath(normalized);
}

/** Sensitive basenames on their own, for paths outside the global root. */
export function isSensitiveAgentStateBasename(basename: string): boolean {
  return SENSITIVE_BASENAMES.test(basename);
}

// ── Absolute paths ─────────────────────────────────────────────────────────

/**
 * Forward slashes, no trailing slash, no NTFS alternate-data-stream suffix on
 * the last segment (`config.json::$DATA` writes `config.json`), case-folded on
 * Windows. Windows also drops trailing dots and spaces from path segments
 * (`cmd`/PowerShell write `config.local.json.` as `config.local.json`).
 */
function normalizeAbs(value: string): string {
  const forward = value.replace(/\\/g, '/').replace(/\/+$/, '');
  const cut = forward.lastIndexOf('/');
  const base = forward.slice(cut + 1);
  const colon = base.indexOf(':');
  const stripped = colon > 0 ? forward.slice(0, cut + 1) + base.slice(0, colon) : forward;
  if (process.platform !== 'win32') return stripped;
  return stripped
    .split('/')
    .map((seg) => seg.replace(/[. ]+$/, '') || seg)
    .join('/')
    .toLowerCase();
}

/** Realpath of `p`'s deepest existing ancestor with the missing tail re-joined. */
function realpathOfNearestExisting(p: string): string {
  let probe = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(probe), ...tail);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return p;
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

function relInside(root: string, target: string): string | undefined {
  if (target === root) return '';
  return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : undefined;
}

/**
 * Every root-relative spelling of `absPath`: the lexical one, and the one
 * through symlinks. Both matter — a link at a benign name (`cache/t`) can point
 * at `trust.json`, and a link outside the root can point inside it. Empty when
 * the path is outside the root either way.
 */
export function agentStateRelPaths(absPath: string): string[] {
  const resolved = path.resolve(absPath);
  const root = path.resolve(wstackGlobalRoot());
  const rels = new Set<string>();
  const lexical = relInside(normalizeAbs(root), normalizeAbs(resolved));
  if (lexical !== undefined) rels.add(lexical);
  const real = relInside(
    normalizeAbs(realpathOfNearestExisting(root)),
    normalizeAbs(realpathOfNearestExisting(resolved)),
  );
  if (real !== undefined) rels.add(real);
  return [...rels];
}

/** True when a write to `absPath` lands on agent-state, by name or through a link. */
export function isAgentStateWriteTarget(absPath: string): boolean {
  return agentStateRelPaths(absPath).some(isSensitiveAgentStateRelPath);
}

/** True when extracting an archive into `absPath` could plant agent-state. */
export function isAgentStateExtractionTarget(absPath: string): boolean {
  return agentStateRelPaths(absPath).some(isSensitiveAgentStateExtractionDir);
}
