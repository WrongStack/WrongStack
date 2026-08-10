import {
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

/** Eagerly-loaded skills per spawn. Kept small so the prompt stays affordable. */
const EAGER_SKILL_LIMIT = 3;

/** Skills whose bodies were requested but did not make it into the prompt. */
export interface SkillResolutionReport {
  content: string;
  selected: string[];
  /** skill → why it was dropped, so the omission is never silent. */
  dropped: Record<string, 'not-found' | 'missing-capability' | 'missing-tool' | 'budget' | 'empty'>;
}

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
    return { content: directContent ?? '', selected: [], dropped };
  }

  const resolved: string[] = [];
  const selected: string[] = [];
  let usedChars = 0;
  const maxChars = 16_000;
  const maxCharsPerSkill = 4_000;
  for (const skillName of skillNames) {
    try {
      const manifest = await deps.skillLoader.find(skillName);
      if (!manifest) {
        dropped[skillName] = 'not-found';
        continue;
      }
      if (missingRuntimeCapabilities(manifest.requiredCapabilities, availableToolNames).length > 0) {
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
      const entry = [
        `## Skill: ${skillName}`,
        '',
        body.slice(0, maxCharsPerSkill),
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
      if (usedChars + entry.length > maxChars) {
        dropped[skillName] = 'budget';
        continue;
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
    resolved.length > 0
      ? `# Role-prioritized skills\n\nApply these skills first for this assignment.\n\n${resolved.join('\n\n---\n\n')}`
      : undefined,
  ].filter((section): section is string => Boolean(section));
  return { content: sections.join('\n\n'), selected, dropped };
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
      deps.session.id,
    );
    return matches.map((item) => item.text);
  } catch {
    return [];
  }
}
