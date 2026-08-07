import { agentPrompt } from './agent-prompts.js';
import { type AgentDefinition, MEDIUM_BUDGET, SPECIALIST_TOOLS, TOOLS } from './types.js';

/** Phase 8 · Delivery & Ops — ship it, run it, keep it healthy. */
export const DELIVERY_AGENTS: AgentDefinition[] = [
  {
    config: {
      id: 'git',
      name: 'Git',
      role: 'git',
      tools: [...TOOLS.vcs, 'bash'],
      prompt: agentPrompt('git'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'delivery',
      summary:
        'Git automation: focused commits, branch/rebase/conflict handling, PR prep, history investigation.',
      keywords: [
        'git',
        'commit',
        'branch',
        'rebase',
        'merge',
        'pull request',
        'pr',
        'conflict',
        'blame',
        'bisect',
        'cherry-pick',
        'stash',
      ],
    },
  },
  {
    config: {
      id: 'release',
      name: 'Release',
      role: 'release',
      tools: [...TOOLS.vcs, 'bash', 'json'],
      prompt: agentPrompt('release'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'delivery',
      summary:
        'Release management: semver bumps, changelogs, and release notes derived from real history.',
      keywords: [
        'release',
        'version',
        'semver',
        'changelog',
        'release notes',
        'tag',
        'bump version',
        'publish',
        'versioning',
      ],
    },
  },
  {
    config: {
      id: 'devops',
      name: 'DevOps',
      role: 'devops',
      tools: [...TOOLS.build, ...SPECIALIST_TOOLS.mcp],
      prompt: agentPrompt('devops'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'delivery',
      summary:
        'CI/CD, containerization, and deployment config: reproducible builds and safe deploys with rollback.',
      keywords: [
        'devops',
        'ci',
        'cd',
        'ci/cd',
        'pipeline',
        'docker',
        'dockerfile',
        'kubernetes',
        'k8s',
        'deploy',
        'ssh',
        'remote ssh',
        'remote server',
        'sftp',
        'tunnel',
        'bastion',
        'jump host',
        'github actions',
        'container',
      ],
    },
  },
  {
    config: {
      id: 'observability',
      name: 'Observability',
      role: 'observability',
      tools: [...TOOLS.build, 'logs'],
      prompt: agentPrompt('observability'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'delivery',
      summary:
        'Observability: structured logging, metrics, distributed tracing, and alerts/dashboards.',
      keywords: [
        'observability',
        'logging',
        'metrics',
        'tracing',
        'telemetry',
        'opentelemetry',
        'otel',
        'prometheus',
        'monitoring',
        'alert',
        'dashboard',
        'instrument',
      ],
    },
  },
  {
    config: {
      id: 'dependency',
      name: 'Dependency',
      role: 'dependency',
      tools: [...TOOLS.deps, 'bash'],
      prompt: agentPrompt('dependency'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'delivery',
      summary:
        'Package management + supply-chain safety: CVE audit, safe upgrades, pruning, install-script review.',
      keywords: [
        'dependency',
        'dependencies',
        'package',
        'npm',
        'pnpm',
        'cve',
        'vulnerability scan',
        'upgrade deps',
        'audit',
        'supply chain',
        'outdated',
        'lockfile',
      ],
    },
  },
];
