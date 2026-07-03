/**
 * Well-known foreign coding-agent skill directories. All follow the
 * agentskills.io `SKILL.md` format, so the same loader reads them — this just
 * tells it WHERE each agent keeps them.
 *
 * Claude is handled separately by the loader (`claude-project` / `claude-user`
 * sources); this list covers the OTHER agents. Every tool here stores skills
 * under `~/.<tool>/skills` (+ `<project>/.<tool>/skills`).
 *
 * Dirs that don't exist are skipped gracefully, so listing many is cheap.
 *
 * NOTE: Cursor previously used a non-standard `skills-cursor` subdir. As of the
 * 2026-07 alignment with the broader skills.sh / antfu-skills-cli / vercel-labs
 * ecosystem, Cursor uses the standard `skills` subdir like everyone else.
 * (`skills-cursor` was WrongStack-only and meant real Cursor skills were never
 * discovered — see docs/skills.md.)
 */
export interface ForeignSkillTool {
  /** Tool id — also the directory name segment (`~/.<id>/…`). */
  id: string;
  /** Skills subdirectory name under `~/.<id>/`. */
  subdir: string;
}

export const FOREIGN_SKILL_TOOLS: readonly ForeignSkillTool[] = [
  { id: 'agents', subdir: 'skills' }, // shared store (asm / agentskills.io ecosystem)
  { id: 'codex', subdir: 'skills' }, // OpenAI Codex CLI
  { id: 'gemini', subdir: 'skills' }, // Gemini CLI
  { id: 'cursor', subdir: 'skills' }, // Cursor (standard subdir, aligned with skills.sh ecosystem)
  { id: 'qwen', subdir: 'skills' }, // Qwen Code
  { id: 'trae', subdir: 'skills' }, // Trae
  { id: 'windsurf', subdir: 'skills' }, // Windsurf
];

/** Set of known tool ids — used to flag typos in `config.skills.foreignSources`. */
const KNOWN_FOREIGN_IDS = new Set(FOREIGN_SKILL_TOOLS.map((t) => t.id));

/** Result of resolving a `foreignSources` config option. */
export interface ResolvedForeignTools {
  /** Tool ids that will be scanned (subset of {@link FOREIGN_SKILL_TOOLS}). */
  ids: string[];
  /** Tool ids the user asked for that aren't known — likely typos (e.g. `corser`). */
  unknownIds: string[];
}

/**
 * Resolve the `config.skills.foreignSources` option into the list of tool ids
 * to scan. Kept for backward compatibility (returns only `ids`).
 * - `false` → none
 * - `string[]` → only those ids (unknown ids silently dropped — see
 *   {@link resolveForeignToolIdsWithWarnings} to surface them)
 * - `true` / `undefined` → all well-known tools
 */
export function resolveForeignToolIds(opt: boolean | string[] | undefined): string[] {
  return resolveForeignToolIdsWithWarnings(opt).ids;
}

/**
 * Like {@link resolveForeignToolIds}, but also returns tool ids the caller asked
 * for that don't match any known agent. Callers that want to warn the user
 * about a likely typo (e.g. `foreignSources: ["corser"]`) should prefer this.
 *
 * - `false` → none
 * - `string[]` → known ids included, unknown ones returned in `unknownIds`
 * - `true` / `undefined` → all well-known tools (no unknowns possible)
 */
export function resolveForeignToolIdsWithWarnings(
  opt: boolean | string[] | undefined,
): ResolvedForeignTools {
  if (opt === false) return { ids: [], unknownIds: [] };
  if (Array.isArray(opt)) {
    const ids: string[] = [];
    const unknownIds: string[] = [];
    for (const id of opt) {
      if (KNOWN_FOREIGN_IDS.has(id)) ids.push(id);
      else unknownIds.push(id);
    }
    return { ids, unknownIds };
  }
  return { ids: FOREIGN_SKILL_TOOLS.map((t) => t.id), unknownIds: [] };
}

/**
 * Security tier bucket for a registry skill's `securityScore` (0–100).
 * Mirrors the ags (agentskill-sh/ags) thresholds: skills below 30 need
 * explicit confirmation before install.
 */
export type SkillSecurityTier = 'low' | 'medium' | 'high';

/** Classify a 0–100 security score into a tier. 0/undefined → unknown → `low`. */
export function securityScoreToTier(score: number | undefined | null): SkillSecurityTier {
  if (score == null || Number.isNaN(score)) return 'low';
  if (score < 30) return 'low';
  if (score < 70) return 'medium';
  return 'high';
}
