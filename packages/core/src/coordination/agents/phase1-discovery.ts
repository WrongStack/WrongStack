import { agentPrompt } from './agent-prompts.js';
import { type AgentDefinition, LIGHT_BUDGET, MEDIUM_BUDGET, TOOLS } from './types.js';

/** Phase 1 · Discovery — map the territory before any work begins. */
export const DISCOVERY_AGENTS: AgentDefinition[] = [
  {
    config: {
      id: 'explore',
      name: 'Explore',
      role: 'explore',
      tools: [...TOOLS.read, ...TOOLS.index],
      prompt: agentPrompt('explore'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'discovery',
      summary:
        'Maps unfamiliar codebases: entry points, structure, architecture, feature flow (read-only).',
      keywords: [
        'explore',
        'map',
        'understand',
        'where is',
        'how does',
        'codebase',
        'architecture',
        'structure',
        'overview',
        'find file',
        'entry point',
        'orient',
      ],
    },
  },
  {
    config: {
      id: 'search',
      name: 'Search',
      role: 'search',
      tools: [...TOOLS.read, ...TOOLS.index],
      prompt: agentPrompt('search'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'discovery',
      summary:
        'Semantic + lexical code search across repos; finds definitions, references, duplicates, ranks by relevance.',
      keywords: [
        'search',
        'find all',
        'references',
        'usages',
        'call sites',
        'grep',
        'locate symbol',
        'duplicate',
        'where used',
        'occurrences',
        'cross-repo',
      ],
    },
  },
  {
    config: {
      id: 'research',
      name: 'Research',
      role: 'research',
      tools: [...TOOLS.research],
      prompt: agentPrompt('research'),
    },
    budget: LIGHT_BUDGET,
    capability: {
      phase: 'discovery',
      summary:
        'Technical research and feasibility: compares libraries/approaches, recommends a path with evidence and tradeoffs.',
      keywords: [
        'research',
        'feasibility',
        'compare libraries',
        'which library',
        'best practice',
        'tradeoff',
        'investigate',
        'evaluate approach',
        'should we use',
        'pros and cons',
      ],
    },
  },
];
