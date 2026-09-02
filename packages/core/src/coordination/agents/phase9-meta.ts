import { type AgentDefinition, LIGHT_BUDGET, MEDIUM_BUDGET, TOOLS } from './types.js';
import { agentPrompt } from './agent-prompts.js';

/** Phase 9 · Meta — agents that improve the agent system itself. */
export const META_AGENTS: AgentDefinition[] = [
  {
    config: {
      id: 'skill-manage',
      name: 'Skill Manager',
      role: 'skill-manage',
      tools: [...TOOLS.write],
      prompt: agentPrompt('skill-manage'),
    },
    budget: LIGHT_BUDGET,
    capability: {
      phase: 'meta',
      summary:
        'Skill curation: audits, refines descriptions/triggers, scaffolds, and retires skills.',
      keywords: [
        'skill',
        'skills',
        'curate skill',
        'skill description',
        'create skill',
        'skill library',
        'skill trigger',
        'manage skills',
      ],
    },
  },
  {
    config: {
      id: 'self-improving',
      name: 'Self-Improving',
      role: 'self-improving',
      tools: [...TOOLS.inspect],
      prompt: agentPrompt('self-improving'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'meta',
      summary:
        'Learns from execution logs: mines recurring failures/inefficiencies and proposes evidence-based improvements.',
      keywords: [
        'self-improving',
        'learn from',
        'session logs',
        'execution analysis',
        'recurring failure',
        'improve agents',
        'post-mortem',
        'retrospective',
        'meta-analysis',
      ],
    },
  },
  {
    config: {
      id: 'context',
      name: 'Context',
      role: 'context',
      tools: [...TOOLS.inspect, 'remember', 'forget'],
      prompt: agentPrompt('context'),
    },
    budget: LIGHT_BUDGET,
    capability: {
      phase: 'meta',
      summary:
        'Memory + context-window management: compaction, recall, and curation within a token budget.',
      keywords: [
        'context',
        'context window',
        'memory',
        'compact',
        'summarize history',
        'recall',
        'token budget',
        'prune context',
        'remember',
        'dfmt',
      ],
    },
  },
  {
    config: {
      id: 'cost',
      name: 'Cost',
      role: 'cost',
      tools: [...TOOLS.inspect],
      prompt: agentPrompt('cost'),
    },
    budget: LIGHT_BUDGET,
    capability: {
      phase: 'meta',
      summary:
        'Token/cloud cost optimization: finds spend waste, recommends model routing and trimming with $ estimates.',
      keywords: [
        'cost',
        'token cost',
        'optimize cost',
        'spend',
        'cheaper',
        'model routing',
        'budget',
        'expensive',
        'reduce tokens',
        'pricing',
        'cloud cost',
      ],
    },
  },
  {
    config: {
      id: 'tech-stack',
      name: 'Tech Stack Validator',
      role: 'tech-stack',
      tools: ['search', 'fetch', 'read', 'grep', 'glob', 'outdated', 'audit', 'json', 'mailbox'],
      prompt: agentPrompt('tech-stack'),
    },
    budget: {
      timeoutMs: 120_000,
      maxIterations: 10,
      maxToolCalls: 40,
      maxTokens: 60_000,
      maxCostUsd: 0.25,
    },
    capability: {
      phase: 'meta',
      summary:
        'Single-shot tech stack validator: checks npm for latest versions, rejects dead/obsolete packages, enforces modern alternatives.',
      keywords: [
        'tech stack',
        'version',
        'package',
        'library',
        'framework',
        'dependency',
        'install',
        'upgrade',
        'latest',
        'npm',
        'pnpm add',
        'outdated',
        'obsolete',
        'deprecated',
        'what version',
        'which package',
        'check version',
        'verify version',
        'is this current',
      ],
    },
  },
];
