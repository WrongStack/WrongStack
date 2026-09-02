import { type AgentDefinition, HEAVY_BUDGET, LIGHT_BUDGET, TOOLS } from './types.js';
import { agentPrompt } from './agent-prompts.js';

const PLAN_TOOLS = [...TOOLS.read, ...TOOLS.index, 'plan', 'todo'];

/** Phase 2 · Planning — turn intent into requirements, plans, and architecture. */
export const PLANNING_AGENTS: AgentDefinition[] = [
  {
    config: {
      id: 'analyst',
      name: 'Analyst',
      role: 'analyst',
      tools: [...PLAN_TOOLS],
      prompt: agentPrompt('analyst'),
    },
    budget: LIGHT_BUDGET,
    capability: {
      phase: 'planning',
      summary:
        'Requirement analysis: turns vague requests into testable specs with acceptance criteria and open questions.',
      keywords: [
        'requirements',
        'analyze requirement',
        'acceptance criteria',
        'spec',
        'specification',
        'clarify',
        'scope',
        'user story',
        'what should it do',
      ],
    },
  },
  {
    config: {
      id: 'planner',
      name: 'Planner',
      role: 'planner',
      tools: [...PLAN_TOOLS],
      prompt: agentPrompt('planner'),
    },
    budget: LIGHT_BUDGET,
    capability: {
      phase: 'planning',
      summary:
        'Execution planning: decomposes a goal into ordered, dependency-aware, parallelizable steps with checkpoints.',
      keywords: [
        'plan',
        'execution plan',
        'break down',
        'decompose',
        'steps',
        'sequence',
        'roadmap',
        'task breakdown',
        'order of work',
        'milestones',
      ],
    },
  },
  {
    config: {
      id: 'architect',
      name: 'Architect',
      role: 'architect',
      tools: [...PLAN_TOOLS],
      prompt: agentPrompt('architect'),
    },
    budget: LIGHT_BUDGET,
    capability: {
      phase: 'planning',
      summary:
        'System architecture: designs module boundaries, interfaces, data flow, and records key decisions.',
      keywords: [
        'architecture',
        'design system',
        'module boundaries',
        'interfaces',
        'data flow',
        'component design',
        'system design',
        'decision record',
        'adr',
        'structure the',
      ],
    },
  },
  {
    config: {
      id: 'critic',
      name: 'Critic',
      role: 'critic',
      tools: [...TOOLS.read],
      prompt: agentPrompt('critic'),
    },
    budget: LIGHT_BUDGET,
    capability: {
      phase: 'planning',
      summary:
        'Adversarial review of plans/designs: finds gaps, risks, and unstated assumptions with ranked fixes.',
      keywords: [
        'critique',
        'review plan',
        'review design',
        'red team',
        'poke holes',
        'risks',
        'what could go wrong',
        'second opinion',
        'challenge',
        'flaws',
      ],
    },
  },
  {
    config: {
      id: 'refactor-planner',
      name: 'Refactor Planner',
      role: 'refactor-planner',
      tools: [...PLAN_TOOLS, 'diff'],
      prompt: agentPrompt('refactor-planner'),
    },
    budget: HEAVY_BUDGET,
    capability: {
      phase: 'planning',
      summary:
        'Refactoring planner: analyzes code structure, maps dependencies, produces risk-scored phased plans with rollback strategy.',
      keywords: [
        'refactor',
        'refactoring',
        'restructure',
        'debt',
        'technical debt',
        'clean up',
        'modularize',
        'decouple',
        'dependency graph',
        'code structure',
      ],
    },
  },
];
