import {
  missingRequiredRuntimeTools,
  missingRuntimeCapabilities,
} from '@wrongstack/contracts/types/runtime-capability-manifest';
import type { SkillManifest } from '@wrongstack/contracts/types/skill';

const HIDDEN_AUDIENCES = new Set(['roster', 'external']);

export function isSkillHiddenFromPrompt(audience: string | undefined): boolean {
  return audience !== undefined && HIDDEN_AUDIENCES.has(audience.trim().toLowerCase());
}

/** Undefined tools means inventory-only discovery, not a claim of runtime availability. */
export function skillPromptExclusionReasons(
  skill: SkillManifest,
  availableToolNames?: readonly string[],
): string[] {
  const reasons: string[] = [];
  if (isSkillHiddenFromPrompt(skill.audience)) reasons.push(`audience: ${skill.audience?.trim()}`);
  if (availableToolNames !== undefined) {
    for (const capability of missingRuntimeCapabilities(
      skill.requiredCapabilities,
      availableToolNames,
    ))
      reasons.push(`missing capability: ${capability}`);
    for (const tool of missingRequiredRuntimeTools(skill.requiredTools, availableToolNames))
      reasons.push(`missing tool: ${tool}`);
  }
  return reasons;
}

/** Keep the complete description and any additional trigger, without repeating the same prose. */
export function skillUseWhenText(
  description?: string,
  trigger?: string,
  fallback?: string,
): string {
  const normalize = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
  const full = normalize(description);
  const extra = normalize(trigger);
  if (!full) return extra || normalize(fallback);
  if (!extra || full.toLowerCase().includes(extra.toLowerCase())) return full;
  return `${full} ${extra}`;
}
