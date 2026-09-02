import { type AgentDefinition, LIGHT_BUDGET, TOOLS } from './types.js';
import { agentPrompt } from './agent-prompts.js';

/**
 * Phase 3 · Tech Stack — dependency version watchdog.
 *
 * Automatically triggered when package manifests (package.json, go.mod, etc.)
 * are created or edited. Detects the ecosystem, looks up latest versions from
 * registries, and sends warning messages to the agent that last touched the
 * file (or broadcasts if unknown).
 *
 * Tools: read (manifests), fetch (registry APIs), mailbox (send warnings).
 */
export const TECHSTACK_AGENTS: AgentDefinition[] = [
  {
    config: {
      id: 'tech-stack',
      name: 'TechStack',
      role: 'tech-stack',
      tools: [...TOOLS.read, 'fetch', 'mailbox'],
      prompt: agentPrompt('tech-stack-watchdog'),
    },
    budget: LIGHT_BUDGET,
    capability: {
      phase: 'build',
      summary:
        'Dependency version watchdog: monitors package manifests, looks up latest versions from registries, and warns authors about outdated packages.',
      keywords: [
        'tech-stack',
        'dependency',
        'version',
        'outdated',
        'package.json',
        'go.mod',
        'cargo.toml',
        'registry',
        'npm',
        'pypi',
        'crates',
      ],
    },
  },
];
