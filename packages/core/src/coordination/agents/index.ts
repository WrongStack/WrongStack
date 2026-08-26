/**
 * Agent catalog aggregator.
 *
 * Collects every phase's `AgentDefinition[]` into:
 *   - `ALL_AGENT_DEFINITIONS` — flat list, catalog order (phase 1 → 9 + waves)
 *   - `AGENT_CATALOG`         — keyed by role for O(1) lookup
 *   - `AGENTS_BY_PHASE`       — grouped for statusline / dispatcher tie-breaks
 *
 * `fleet.ts` derives `FLEET_ROSTER` + `FLEET_ROSTER_BUDGETS` from this, and the
 * dispatcher routes free-form tasks against `capability` metadata here.
 */

import { DISCOVERY_AGENTS } from './phase1-discovery.js';
import { PLANNING_AGENTS } from './phase2-planning.js';
import { BUILD_AGENTS } from './phase3-build.js';
import { WAVE1_AGENTS } from './phase3-wave1-platform.js';
import { WAVE2_AGENTS } from './phase3-wave2-meta.js';
import { VERIFY_AGENTS } from './phase4-verify.js';
import { REVIEW_AGENTS } from './phase5-review.js';
import { DOMAIN_AGENTS } from './phase6-domain.js';
import { KNOWLEDGE_AGENTS } from './phase7-knowledge.js';
import { DELIVERY_AGENTS } from './phase8-delivery.js';
import { WAVE3_AGENTS } from './phase8-wave3-products.js';
import { META_AGENTS } from './phase9-meta.js';
import { WAVE4_AGENTS } from './phase9-wave4-platform-meta.js';
import { assignSkillsToAgents, ROLE_SKILL_SETS, SHADOW_AGENT_SKILLS } from './role-skills.js';
import type { AgentCapability, AgentDefinition, AgentPhase } from './types.js';

export * from './capability-manifest.js';
export * from './phase3-wave1-platform.js';
export * from './phase3-wave2-meta.js';
export * from './phase8-wave3-products.js';
export * from './phase9-wave4-platform-meta.js';
export * from './project-agent-identity.js';
export * from './role-skills.js';
export * from './types.js';
export {
  BUILD_AGENTS,
  DELIVERY_AGENTS,
  DISCOVERY_AGENTS,
  DOMAIN_AGENTS,
  KNOWLEDGE_AGENTS,
  META_AGENTS,
  PLANNING_AGENTS,
  REVIEW_AGENTS,
  VERIFY_AGENTS,
  WAVE1_AGENTS,
  WAVE2_AGENTS,
  WAVE3_AGENTS,
  WAVE4_AGENTS,
};

/** Every catalog agent, in phase order, enriched with its curated skills. */
export const ALL_AGENT_DEFINITIONS: AgentDefinition[] = assignSkillsToAgents([
  ...DISCOVERY_AGENTS,
  ...PLANNING_AGENTS,
  ...BUILD_AGENTS,
  ...WAVE1_AGENTS,
  ...WAVE2_AGENTS,
  ...VERIFY_AGENTS,
  ...REVIEW_AGENTS,
  ...DOMAIN_AGENTS,
  ...KNOWLEDGE_AGENTS,
  ...DELIVERY_AGENTS,
  ...WAVE3_AGENTS,
  ...META_AGENTS,
  ...WAVE4_AGENTS,
]);

/** Phase → its enriched agents, for grouped display and dispatcher fallbacks. */
const agentsInPhase = (phase: AgentPhase): AgentDefinition[] =>
  ALL_AGENT_DEFINITIONS.filter((definition) => definition.capability.phase === phase);

export const AGENTS_BY_PHASE = {
  discovery: agentsInPhase('discovery'),
  planning: agentsInPhase('planning'),
  build: agentsInPhase('build'),
  verify: agentsInPhase('verify'),
  review: agentsInPhase('review'),
  domain: agentsInPhase('domain'),
  knowledge: agentsInPhase('knowledge'),
  delivery: agentsInPhase('delivery'),
  meta: agentsInPhase('meta'),
} satisfies Record<AgentPhase, AgentDefinition[]>;

/**
 * Role → definition. Built once at module load. Throws on a duplicate role so
 * a copy-paste collision fails loudly at startup instead of silently shadowing.
 */
export const AGENT_CATALOG: Record<string, AgentDefinition> = (() => {
  const map: Record<string, AgentDefinition> = {};
  for (const def of ALL_AGENT_DEFINITIONS) {
    const role = def.config.role;
    if (!role) {
      throw new Error(`Agent "${def.config.name}" is missing a role`);
    }
    if (map[role]) {
      throw new Error(`Duplicate agent role in catalog: "${role}"`);
    }
    map[role] = def;
  }
  return map;
})();

/** Role lookup helper. Returns undefined for unknown roles. */
export function getAgentDefinition(role: string): AgentDefinition | undefined {
  return AGENT_CATALOG[role];
}

/**
 * Role → dispatcher rationale, for every role that declares one.
 *
 * Derived from the catalog rather than hand-listed. There used to be four
 * hand-maintained `WAVE*_ROLE_METAS` maps beside the agent arrays; nothing
 * read them, and `WAVE2_ROLE_METAS` had drifted to carry six roles that live
 * in `WAVE4_AGENTS` — a duplicate set no consumer would ever have noticed
 * because the map itself was dead. Deriving from `AGENT_CATALOG` makes that
 * class of drift impossible: a role is listed here exactly when its own
 * `capability.rationale` is set.
 */
export const ROLE_DISPATCH_RATIONALE: Record<
  string,
  NonNullable<AgentCapability['rationale']>
> = (() => {
  const map: Record<string, NonNullable<AgentCapability['rationale']>> = {};
  for (const def of ALL_AGENT_DEFINITIONS) {
    const role = def.config.role;
    const rationale = def.capability.rationale;
    if (role && rationale) map[role] = rationale;
  }
  return map;
})();

// Re-export the skill-set aliases that some callers historically imported
// from this module so the wave-1/2/3/4 surface keeps backward compatibility.
export { ROLE_SKILL_SETS, SHADOW_AGENT_SKILLS };
