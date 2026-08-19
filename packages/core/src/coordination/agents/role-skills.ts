import { inferRuntimeCapabilities } from './capability-manifest.js';
import type { AgentDefinition } from './types.js';

/**
 * Bundled skills currently assigned to built-in roster agents.
 *
 * Keeping this list explicit makes role assignments auditable and prevents a
 * typo from silently degrading a worker into its persona-only fallback.
 * Exported so an integrity test can assert every name resolves to a real
 * bundled skill (see tests/coordination/role-skills.test.ts).
 */
export const BUNDLED_AGENT_SKILLS = [
  'api-design',
  'audit-log',
  'bug-hunter',
  'chimera',
  'data-governance',
  'docker-deploy',
  'git-flow',
  'mnemosyne',
  'multi-agent',
  'node-modern',
  'observability',
  'output-standards',
  'plugin-author',
  'prompt-engineering',
  'react-modern',
  'refactor-planner',
  'research-web',
  'sdd',
  'security-scanner',
  'skill-creator',
  'tech-stack',
  'testing',
  'typescript-strict',
  'wrongstack-mailbox',
] as const;

export type BundledAgentSkill = (typeof BUNDLED_AGENT_SKILLS)[number];

const skillSet = (...names: BundledAgentSkill[]): BundledAgentSkill[] => names;

/**
 * Curated cross-disciplinary skill sets for every catalog role.
 *
 * A role prompt supplies the specialist persona; these skills add reusable
 * methods and safety rails from adjacent disciplines. Sets intentionally mix
 * domain knowledge, verification, security, and delivery rather than merely
 * repeating the role name.
 */
export const ROLE_SKILL_SETS = {
  explore: skillSet('research-web', 'node-modern', 'typescript-strict'),
  'explore-companion': skillSet('node-modern', 'typescript-strict'),
  search: skillSet('bug-hunter', 'typescript-strict', 'research-web'),
  research: skillSet('research-web', 'tech-stack', 'security-scanner', 'api-design'),

  analyst: skillSet('sdd', 'api-design', 'testing', 'security-scanner'),
  planner: skillSet('sdd', 'multi-agent', 'refactor-planner', 'testing'),
  architect: skillSet('sdd', 'api-design', 'refactor-planner', 'security-scanner', 'observability'),
  critic: skillSet('chimera', 'bug-hunter', 'security-scanner', 'refactor-planner'),
  'refactor-planner': skillSet(
    'refactor-planner',
    'sdd',
    'typescript-strict',
    'testing',
    'bug-hunter',
  ),

  executor: skillSet('sdd', 'typescript-strict', 'node-modern', 'testing', 'git-flow'),
  refactor: skillSet('refactor-planner', 'typescript-strict', 'testing', 'bug-hunter'),
  simplifier: skillSet('bug-hunter', 'typescript-strict', 'testing', 'refactor-planner'),
  migration: skillSet('tech-stack', 'node-modern', 'typescript-strict', 'testing', 'git-flow'),
  vision: skillSet('react-modern', 'testing', 'typescript-strict', 'security-scanner'),
  debugger: skillSet('bug-hunter', 'testing', 'typescript-strict', 'observability', 'audit-log'),
  tracer: skillSet('observability', 'audit-log', 'bug-hunter', 'testing'),

  verifier: skillSet('testing', 'typescript-strict', 'security-scanner', 'chimera'),
  test: skillSet('testing', 'typescript-strict', 'bug-hunter', 'security-scanner'),
  e2e: skillSet('testing', 'react-modern', 'api-design', 'security-scanner'),
  browser: skillSet('testing', 'react-modern', 'security-scanner', 'research-web'),
  performance: skillSet('observability', 'testing', 'node-modern', 'audit-log'),
  chaos: skillSet('testing', 'observability', 'security-scanner', 'audit-log'),
  'security-scanner': skillSet('security-scanner', 'bug-hunter', 'api-design', 'tech-stack'),
  'bug-hunter': skillSet('bug-hunter', 'typescript-strict', 'testing', 'security-scanner'),
  'audit-log': skillSet('audit-log', 'observability', 'bug-hunter', 'output-standards'),

  reviewer: skillSet('chimera', 'bug-hunter', 'security-scanner', 'testing'),
  'code-reviewer': skillSet('chimera', 'bug-hunter', 'typescript-strict', 'testing'),
  'security-reviewer': skillSet('security-scanner', 'chimera', 'api-design', 'tech-stack'),
  accessibility: skillSet('react-modern', 'testing', 'chimera', 'security-scanner'),
  compliance: skillSet('security-scanner', 'audit-log', 'tech-stack', 'chimera'),

  database: skillSet('api-design', 'testing', 'security-scanner', 'observability'),
  api: skillSet('api-design', 'typescript-strict', 'node-modern', 'testing', 'security-scanner'),
  auth: skillSet('security-scanner', 'api-design', 'testing', 'typescript-strict', 'audit-log'),
  data: skillSet('typescript-strict', 'testing', 'observability', 'security-scanner'),
  frontend: skillSet('react-modern', 'typescript-strict', 'testing', 'security-scanner'),
  backend: skillSet('node-modern', 'typescript-strict', 'api-design', 'testing', 'observability'),
  designer: skillSet('react-modern', 'prompt-engineering', 'research-web', 'output-standards'),
  ios: skillSet('sdd', 'testing', 'security-scanner', 'research-web'),

  document: skillSet('output-standards', 'research-web', 'api-design', 'prompt-engineering'),
  uml: skillSet('sdd', 'refactor-planner', 'api-design', 'output-standards'),
  i18n: skillSet('react-modern', 'testing', 'typescript-strict', 'output-standards'),
  prompt: skillSet('prompt-engineering', 'skill-creator', 'output-standards', 'testing'),

  git: skillSet('git-flow', 'chimera', 'testing', 'security-scanner'),
  release: skillSet('git-flow', 'tech-stack', 'chimera', 'security-scanner'),
  devops: skillSet('docker-deploy', 'observability', 'security-scanner', 'git-flow', 'tech-stack'),
  observability: skillSet('observability', 'node-modern', 'testing', 'audit-log'),
  dependency: skillSet('tech-stack', 'security-scanner', 'node-modern', 'git-flow'),

  'skill-manage': skillSet(
    'skill-creator',
    'prompt-engineering',
    'security-scanner',
    'output-standards',
  ),
  'self-improving': skillSet(
    'audit-log',
    'mnemosyne',
    'prompt-engineering',
    'bug-hunter',
    'observability',
  ),
  context: skillSet('mnemosyne', 'output-standards', 'prompt-engineering', 'audit-log'),
  cost: skillSet('audit-log', 'tech-stack', 'observability', 'research-web'),
  'tech-stack': skillSet('tech-stack', 'research-web', 'security-scanner', 'node-modern'),

  // ── Wave 1: Platform and systems engineering ──────────────────────────
  android: skillSet(
    'react-modern',
    'typescript-strict',
    'testing',
    'security-scanner',
    'tech-stack',
  ),
  desktop: skillSet(
    'node-modern',
    'typescript-strict',
    'testing',
    'security-scanner',
    'tech-stack',
  ),
  realtime: skillSet(
    'api-design',
    'observability',
    'node-modern',
    'typescript-strict',
    'testing',
    'tech-stack',
  ),
  'distributed-systems': skillSet(
    'api-design',
    'observability',
    'typescript-strict',
    'testing',
    'security-scanner',
    'tech-stack',
  ),
  concurrency: skillSet(
    'bug-hunter',
    'typescript-strict',
    'testing',
    'observability',
    'node-modern',
    'tech-stack',
  ),
  'platform-engineer': skillSet(
    'node-modern',
    'typescript-strict',
    'git-flow',
    'docker-deploy',
    'tech-stack',
  ),

  // ── Wave 3: Product and data specialists ──────────────────────────────
  payments: skillSet(
    'api-design',
    'security-scanner',
    'audit-log',
    'testing',
    'typescript-strict',
    'tech-stack',
  ),
  messaging: skillSet(
    'api-design',
    'observability',
    'node-modern',
    'testing',
    'security-scanner',
    'tech-stack',
  ),
  'search-relevance': skillSet(
    'api-design',
    'observability',
    'testing',
    'typescript-strict',
    'data-governance',
    'tech-stack',
  ),
  storage: skillSet(
    'api-design',
    'security-scanner',
    'testing',
    'observability',
    'node-modern',
    'tech-stack',
  ),
  'ml-engineer': skillSet(
    'observability',
    'typescript-strict',
    'testing',
    'security-scanner',
    'data-governance',
    'tech-stack',
  ),
  'data-governance': skillSet(
    'audit-log',
    'security-scanner',
    'observability',
    'testing',
    'output-standards',
    'tech-stack',
  ),

  // ── Wave 4: Agent platform and quality ───────────────────────────────
  'plugin-author': skillSet(
    'plugin-author',
    'node-modern',
    'typescript-strict',
    'testing',
    'security-scanner',
    'tech-stack',
  ),
  'tool-author': skillSet(
    'typescript-strict',
    'security-scanner',
    'testing',
    'output-standards',
    'tech-stack',
  ),
  'prompt-evaluator': skillSet(
    'prompt-engineering',
    'testing',
    'output-standards',
    'security-scanner',
    'tech-stack',
  ),
  'benchmark-engineer': skillSet('observability', 'testing', 'output-standards', 'tech-stack'),
  'memory-curator': skillSet('mnemosyne', 'audit-log', 'testing', 'output-standards', 'tech-stack'),
  'fleet-coordinator': skillSet('multi-agent', 'sdd', 'output-standards', 'testing', 'tech-stack'),

  // ── Wave 2: Security, resilience, governance and agent platform ────────
  'threat-modeler': skillSet(
    'security-scanner',
    'api-design',
    'tech-stack',
    'audit-log',
    'testing',
  ),
  'secure-coding-coach': skillSet(
    'security-scanner',
    'testing',
    'typescript-strict',
    'api-design',
    'tech-stack',
  ),
  'resilience-engineer': skillSet(
    'observability',
    'testing',
    'typescript-strict',
    'api-design',
    'tech-stack',
  ),
  'chaos-engineer': skillSet(
    'observability',
    'testing',
    'security-scanner',
    'git-flow',
    'tech-stack',
  ),
  'compliance-auditor': skillSet(
    'audit-log',
    'security-scanner',
    'output-standards',
    'testing',
    'tech-stack',
  ),
  'privacy-engineer': skillSet(
    'security-scanner',
    'audit-log',
    'api-design',
    'data-governance',
    'tech-stack',
  ),
} as const satisfies Record<string, readonly BundledAgentSkill[]>;

export type CatalogRoleWithSkills = keyof typeof ROLE_SKILL_SETS;

/** Standalone operational role that lives outside the phase catalog. */
export const SHADOW_AGENT_SKILLS = skillSet(
  'wrongstack-mailbox',
  'multi-agent',
  'audit-log',
  'observability',
  'security-scanner',
);

export const MAX_EAGER_ROSTER_SKILLS = 3;

/**
 * Attach a bounded, fresh skill-name array so catalog templates remain
 * mutation-safe.
 *
 * `skillNames` stays capped at `MAX_EAGER_ROSTER_SKILLS` — it is the default
 * eager set for a project with no learning history. The full curated set is
 * also carried as `skillPool` so the spawn path can rank *all* candidates by
 * project affinity instead of being permanently limited to whichever three
 * happened to be written first in this file.
 */
export function assignSkillsToAgents(definitions: readonly AgentDefinition[]): AgentDefinition[] {
  return definitions.map((definition) => {
    const role = definition.config.role;
    if (!role || !Object.hasOwn(ROLE_SKILL_SETS, role)) {
      throw new Error(
        `Missing curated skill set for roster role: "${role ?? definition.config.name}"`,
      );
    }
    const skills = ROLE_SKILL_SETS[role as CatalogRoleWithSkills];
    return {
      ...definition,
      config: {
        ...definition.config,
        capabilities: inferRuntimeCapabilities(definition.config.tools ?? []),
        skillNames: skills.slice(0, MAX_EAGER_ROSTER_SKILLS),
        skillPool: [...skills],
      },
    };
  });
}
