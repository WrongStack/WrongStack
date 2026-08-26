import { agentPrompt } from './agent-prompts.js';
import type { BundledAgentSkill } from './role-skills.js';
import {
  type AgentDefinition,
  LIGHT_BUDGET,
  MEDIUM_BUDGET,
  type RoleDispatcherSignal,
  SPECIALIST_TOOLS,
  TOOLS,
} from './types.js';

const skillSet = (...names: BundledAgentSkill[]): BundledAgentSkill[] => names;

/**
 * Wave 4: Agent platform and quality.
 *
 * Six roles that improve the agent system itself. The existing
 * `skill-manage`, `self-improving`, `context`, `cost` and `tech-stack` roles
 * are kept; the new roles focus on quality measurement and the platform
 * surface that the host exposes to extensions.
 */

const PROMPT_evaluator_META = {
  rationale:
    'Prompt evaluator: builds rubrics, adversarial tests and regression suites. Independent measurement counterpart to the `prompt` author role.',
  signals: [
    'prompt eval',
    'prompt regression',
    'rubric',
    'adversarial prompt',
    'prompt benchmark',
    'judge prompt',
    'eval suite',
  ] as const,
  differentiatesFrom:
    'prompt authors prompts; prompt-evaluator independently measures them with rubrics and adversarial inputs.',
} satisfies RoleDispatcherSignal;

const BENCHMARK_ENGINEER_META = {
  rationale:
    'Benchmark engineer: reproducible benchmark design and methodology. The measurement-infrastructure counterpart to `performance`.',
  signals: [
    'benchmark',
    'reproducible',
    'evaluation harness',
    'regression suite',
    'metric methodology',
    'baseline',
    'deterministic run',
  ] as const,
  differentiatesFrom:
    'performance optimizes product code; benchmark-engineer builds the measurement infrastructure that supports comparison.',
} satisfies RoleDispatcherSignal;

const MEMORY_CURATOR_META = {
  rationale:
    'Memory curator: validates, merges and de-duplicates long-term memory with audience scope. Quality counterpart to `context`.',
  signals: [
    'memory',
    'curate',
    'memory audit',
    'memory merge',
    'memory expiry',
    'audience scope',
    'memory recall quality',
  ] as const,
  differentiatesFrom:
    'context manages the active context window; memory-curator curates the long-term memory store for accuracy.',
} satisfies RoleDispatcherSignal;

const FLEET_COORDINATOR_META = {
  rationale:
    'Fleet coordinator: multi-agent job partitioning, capacity planning and result synthesis. Operational counterpart to `planner`.',
  signals: [
    'fleet',
    'fan out',
    'parallel agents',
    'synthesis',
    'subagent capacity',
    'coordinator',
    'result aggregation',
  ] as const,
  differentiatesFrom:
    'planner designs ordered steps for one worker; fleet-coordinator runs many workers in parallel and merges their results.',
} satisfies RoleDispatcherSignal;

const PLUGIN_AUTHOR_META = {
  rationale:
    'Plugin author: build, package and ship runnable WrongStack plugins. The production counterpart to `skill-manage`.',
  signals: [
    'plugin',
    'plugin api',
    'lifecycle',
    'health',
    'teardown',
    'packaging',
    'distribution',
  ] as const,
  differentiatesFrom:
    'skill-manage authors skills; plugin-author authors full lifecycle plugins with health and teardown.',
} satisfies RoleDispatcherSignal;

const TOOL_AUTHOR_META = {
  rationale:
    'Tool author: tool schema, capability declaration, permission and error contract. The narrow, security-focused counterpart to `plugin-author`.',
  signals: [
    'tool',
    'tool schema',
    'capability',
    'permission',
    'tool contract',
    'tool error',
    'tool lifecycle',
  ] as const,
  differentiatesFrom:
    'plugin-author writes full plugin lifecycle; tool-author focuses on a single tool contract and capability set.',
} satisfies RoleDispatcherSignal;

export const WAVE4_AGENTS: AgentDefinition[] = [
  {
    config: {
      id: 'plugin-author',
      name: 'Plugin Author',
      role: 'plugin-author',
      tools: [...TOOLS.write, 'fetch'],
      prompt: agentPrompt('plugin-author'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'meta',
      summary:
        'Plugin author: build, package and ship runnable WrongStack plugins with full lifecycle, health and teardown.',
      rationale: PLUGIN_AUTHOR_META,
      keywords: [
        ...PLUGIN_AUTHOR_META.signals,
        'plugin',
        'plugin-author',
        'lifecycle',
        'health',
        'teardown',
        'plugin-packaging',
      ],
    },
  },
  {
    config: {
      id: 'tool-author',
      name: 'Tool Author',
      role: 'tool-author',
      tools: [...TOOLS.write, 'install'],
      prompt: agentPrompt('tool-author'),
    },
    budget: LIGHT_BUDGET,
    capability: {
      phase: 'meta',
      summary:
        'Tool author: design tool schemas, capability declarations, permissions and error contracts with security as the first concern.',
      rationale: TOOL_AUTHOR_META,
      keywords: [
        ...TOOL_AUTHOR_META.signals,
        'tool',
        'tool-author',
        'capability',
        'permission',
        'tool-schema',
        'tool-error',
      ],
    },
  },
  {
    config: {
      id: 'prompt-evaluator',
      name: 'Prompt Evaluator',
      role: 'prompt-evaluator',
      tools: [...TOOLS.read, 'write'],
      prompt: agentPrompt('prompt-evaluator'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'meta',
      summary:
        'Prompt evaluator: build rubrics, adversarial prompt tests and regression suites for independent measurement.',
      rationale: PROMPT_evaluator_META,
      keywords: [
        ...PROMPT_evaluator_META.signals,
        'prompt-evaluator',
        'rubric',
        'adversarial',
        'regression',
        'judge',
      ],
    },
  },
  {
    config: {
      id: 'benchmark-engineer',
      name: 'Benchmark Engineer',
      role: 'benchmark-engineer',
      tools: [...TOOLS.read, 'write', 'logs'],
      prompt: agentPrompt('benchmark-engineer'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'meta',
      summary:
        'Benchmark engineer: design reproducible benchmarks and methodology with deterministic baselines.',
      rationale: BENCHMARK_ENGINEER_META,
      keywords: [
        ...BENCHMARK_ENGINEER_META.signals,
        'benchmark-engineer',
        'benchmark',
        'baseline',
        'eval-harness',
        'deterministic',
      ],
    },
  },
  {
    config: {
      id: 'memory-curator',
      name: 'Memory Curator',
      role: 'memory-curator',
      tools: [...TOOLS.read, ...SPECIALIST_TOOLS.memory],
      prompt: agentPrompt('memory-curator'),
    },
    budget: LIGHT_BUDGET,
    capability: {
      phase: 'meta',
      summary:
        'Memory curator: validate, merge and de-duplicate long-term memory entries with audience scoping.',
      rationale: MEMORY_CURATOR_META,
      keywords: [
        ...MEMORY_CURATOR_META.signals,
        'memory-curator',
        'curate',
        'memory-audit',
        'memory-merge',
        'audience-scope',
      ],
    },
  },
  {
    config: {
      id: 'fleet-coordinator',
      name: 'Fleet Coordinator',
      role: 'fleet-coordinator',
      tools: [...TOOLS.read, 'plan'],
      prompt: agentPrompt('fleet-coordinator'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'meta',
      summary:
        'Fleet coordinator: own multi-agent job partitioning, capacity planning and result synthesis across many parallel workers.',
      rationale: FLEET_COORDINATOR_META,
      keywords: [
        ...FLEET_COORDINATOR_META.signals,
        'fleet-coordinator',
        'fan-out',
        'parallel',
        'synthesis',
        'subagent-capacity',
      ],
    },
  },
];

void skillSet;
