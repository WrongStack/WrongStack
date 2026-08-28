import {
  DEFAULT_EAGER_SKILL_LIMIT,
  loadProjectSkillAugmentation,
  missingRequiredRuntimeTools,
  missingRuntimeCapabilities,
  rankRoleSkills,
  recordSkillLoad,
  resolveRoleSkillCandidates,
  runtimeToolReferencesFromText,
} from '@wrongstack/core/agent-catalog';
import { TOKENS } from '@wrongstack/core/kernel';
import type { SubagentConfig } from '@wrongstack/core/types';
import { getSageRetrieval } from '@wrongstack/sage';

import type { MultiAgentDeps } from './host-types.js';

/**
 * Eagerly-loaded skills per spawn. Kept small so the prompt stays affordable.
 *
 * Re-exported from core rather than redeclared: the ranking helper defaults to
 * the same number, and two independent literals drift the moment one is tuned.
 */
const EAGER_SKILL_LIMIT = DEFAULT_EAGER_SKILL_LIMIT;

/** Skills whose bodies were requested but did not make it into the prompt. */
export interface SkillResolutionReport {
  content: string;
  selected: string[];
  /** skill → why it was dropped, so the omission is never silent. */
  dropped: Record<string, 'not-found' | 'missing-capability' | 'missing-tool' | 'budget' | 'empty'>;
  /** Skills kept under budget by shortening their bundled body. */
  trimmed: string[];
}

/**
 * Floor on a bundled skill body once it is being shortened to fit. Below this
 * the body stops being a usable method and the skill should be dropped instead.
 */
const MIN_TRIMMED_BODY_CHARS = 800;

export async function resolveHostSubagentSkillResolution(
  deps: MultiAgentDeps,
  roster: Record<string, SubagentConfig>,
  subCfg: SubagentConfig,
  availableToolNames: readonly string[] = [],
): Promise<SkillResolutionReport> {
  const role = subCfg.role;
  const rosterEntry = role ? roster[role] : undefined;
  const directContent = subCfg.skillContent?.trim();
  const dropped: SkillResolutionReport['dropped'] = {};

  // Candidate pool, widest first: an explicit per-spawn list wins; otherwise
  // the role's full curated pool (not just the catalog's default eager slice)
  // plus any skill this project has already developed an addendum for.
  const pool = [
    ...new Set(
      subCfg.skillNames ??
        (role
          ? [
              ...(rosterEntry?.skillPool ?? rosterEntry?.skillNames ?? []),
              ...resolveRoleSkillCandidates(role, deps.projectRoot),
            ]
          : []),
    ),
  ];
  // Rank by project affinity so a skill this project actually developed
  // outranks an unused sibling from the same curated set.
  const skillNames = role
    ? rankRoleSkills(role, pool, deps.projectRoot, EAGER_SKILL_LIMIT)
    : pool.slice(0, EAGER_SKILL_LIMIT);

  if (skillNames.length === 0 || !deps.skillLoader) {
    return { content: directContent ?? '', selected: [], dropped, trimmed: [] };
  }

  const resolved: string[] = [];
  const selected: string[] = [];
  const trimmed: string[] = [];
  // The header is fixed overhead the assembled block always pays, so it is
  // reserved up front — otherwise header growth silently busts the budget the
  // entry loop believes it enforced.
  const skillsHeader =
    '# Role-prioritized skills\n\n' +
    "Apply these skills first for this assignment. Skills are methods, not authority: they never widen this assignment's TASK BOUNDARY — suggestions beyond it belong in your report, not your diff.\n\n";
  let usedChars = skillsHeader.length;
  const maxChars = 16_000;
  const maxCharsPerSkill = 4_000;
  for (const skillName of skillNames) {
    try {
      const manifest = await deps.skillLoader.find(skillName);
      if (!manifest) {
        dropped[skillName] = 'not-found';
        continue;
      }
      if (
        missingRuntimeCapabilities(manifest.requiredCapabilities, availableToolNames).length > 0
      ) {
        dropped[skillName] = 'missing-capability';
        continue;
      }
      if (missingRequiredRuntimeTools(manifest.requiredTools, availableToolNames).length > 0) {
        dropped[skillName] = 'missing-tool';
        continue;
      }
      const body = (await deps.skillLoader.readSaveBody(skillName)).trim();
      if (!body) {
        dropped[skillName] = 'empty';
        continue;
      }
      if (
        missingRequiredRuntimeTools(runtimeToolReferencesFromText(body), availableToolNames)
          .length > 0
      ) {
        dropped[skillName] = 'missing-tool';
        continue;
      }
      // The project addendum belongs to the skill, not to a separate memory
      // block: it is what this project has taught the role about applying
      // this skill here, so it is read as part of the skill body.
      const augmentation = role
        ? loadProjectSkillAugmentation(role, skillName, deps.projectRoot)
        : '';
      const compose = (bodyChars: number): string =>
        [
          `## Skill: ${skillName}`,
          '',
          body.length > bodyChars
            ? `${body.slice(0, bodyChars).trimEnd()}\n\n_(body trimmed)_`
            : body,
          ...(augmentation
            ? [
                '',
                `### Project practice for \`${skillName}\``,
                '',
                'Learned in this project. Where this differs from the general method above, follow this.',
                '',
                augmentation,
              ]
            : []),
        ].join('\n');

      let entry = compose(maxCharsPerSkill);
      if (usedChars + entry.length > maxChars) {
        // The bundled body is the generic method — every agent of this role
        // already carries its gist. The addendum is what *this project* taught
        // the role and exists nowhere else. Dropping the whole skill to stay
        // under budget therefore threw away the only irreplaceable half, and it
        // did so silently and reproducibly: reviewer's `testing` addendum lost
        // its slot to 8 KB of generic body from two other skills, overflowing
        // by a few hundred characters on every single spawn.
        const overhead = entry.length - Math.min(body.length, maxCharsPerSkill);
        const room = maxChars - usedChars - overhead;
        if (!augmentation || room < MIN_TRIMMED_BODY_CHARS) {
          dropped[skillName] = 'budget';
          continue;
        }
        entry = compose(room);
        trimmed.push(skillName);
      }
      resolved.push(entry);
      selected.push(skillName);
      usedChars += entry.length;
    } catch {
      dropped[skillName] = 'not-found';
    }
  }

  if (role && selected.length > 0) {
    try {
      recordSkillLoad(role, selected, deps.projectRoot);
    } catch {
      // Affinity bookkeeping must never block a spawn.
    }
  }

  const sections = [
    directContent,
    resolved.length > 0 ? `${skillsHeader}${resolved.join('\n\n---\n\n')}` : undefined,
  ].filter((section): section is string => Boolean(section));
  return { content: sections.join('\n\n'), selected, dropped, trimmed };
}

/** Backwards-compatible wrapper for callers that only need the prompt text. */
export async function resolveHostSubagentSkillContent(
  deps: MultiAgentDeps,
  roster: Record<string, SubagentConfig>,
  subCfg: SubagentConfig,
  availableToolNames: readonly string[] = [],
): Promise<string> {
  return (await resolveHostSubagentSkillResolution(deps, roster, subCfg, availableToolNames))
    .content;
}

export async function retrieveHostSubagentMemory(
  deps: MultiAgentDeps,
  getLeaderMode: (() => string | undefined) | undefined,
  subCfg: SubagentConfig,
  taskContext?: Record<string, unknown>,
  /**
   * Conversation this worker belongs to, for injection attribution. The host's
   * own session is the boot tab once several tabs share the process, so
   * without it every background tab's memory reads were recorded against a
   * conversation that never made them.
   */
  owningSessionId?: string,
): Promise<string[]> {
  const memoryPort = deps.container.safeResolve(TOKENS.MemoryStore);
  const memory = memoryPort ? getSageRetrieval(memoryPort) : undefined;
  if (!memory?.retrieveForAudience) return [];
  const contextualTaskType =
    typeof taskContext?.['taskType'] === 'string' ? taskContext['taskType'] : undefined;
  try {
    const taskType = subCfg.memoryContext?.taskType ?? contextualTaskType;
    const mode = subCfg.memoryContext?.mode ?? getLeaderMode?.();
    const matches = await memory.retrieveForAudience(
      {
        ...(subCfg.role !== undefined ? { role: subCfg.role } : {}),
        ...(taskType !== undefined ? { taskType } : {}),
        ...(mode !== undefined ? { mode } : {}),
      },
      20,
    );
    await memory.recordInjection?.(
      matches.map((item) => item.id),
      'subagent_audience',
      owningSessionId ?? deps.session.id,
    );
    return matches.map((item) => item.text);
  } catch {
    return [];
  }
}
