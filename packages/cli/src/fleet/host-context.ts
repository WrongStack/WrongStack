import { TOKENS } from '@wrongstack/core/kernel';
import type { SubagentConfig } from '@wrongstack/core/types';
import { getSageRetrieval } from '@wrongstack/sage';

import type { MultiAgentDeps } from './host-types.js';

export async function resolveHostSubagentSkillContent(
  deps: MultiAgentDeps,
  roster: Record<string, SubagentConfig>,
  subCfg: SubagentConfig,
): Promise<string> {
  const rosterSkillNames = subCfg.role ? roster[subCfg.role]?.skillNames : undefined;
  const skillNames = [...new Set(subCfg.skillNames ?? rosterSkillNames ?? [])];
  const directContent = subCfg.skillContent?.trim();
  if (skillNames.length === 0 || !deps.skillLoader) return directContent ?? '';

  const resolved: string[] = [];
  let usedChars = 0;
  const maxChars = 16_000;
  const maxCharsPerSkill = 4_000;
  for (const skillName of skillNames) {
    try {
      const manifest = await deps.skillLoader.find(skillName);
      if (!manifest) continue;
      const body = (await deps.skillLoader.readSaveBody(skillName)).trim();
      if (!body) continue;
      const entry = `## Skill: ${skillName}\n\n${body.slice(0, maxCharsPerSkill)}`;
      if (usedChars + entry.length > maxChars) {
        console.warn(
          `[MultiAgentHost] resolveSubagentSkillContent: budget (${maxChars}) exhausted ` +
            `after ${resolved.length} skill(s); dropping "${skillName}" and remaining skills`,
        );
        break;
      }
      resolved.push(entry);
      usedChars += entry.length;
    } catch {
      // Optional role skills should not prevent the worker from spawning.
    }
  }

  const sections = [
    directContent,
    resolved.length > 0
      ? `# Role-prioritized skills\n\nApply these skills first for this assignment.\n\n${resolved.join('\n\n---\n\n')}`
      : undefined,
  ].filter((section): section is string => Boolean(section));
  return sections.join('\n\n');
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
