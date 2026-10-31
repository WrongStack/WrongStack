import type { SubagentConfig, Tool } from '@wrongstack/contracts/types';
import { makeSubagentResultTool } from '@wrongstack/coordination';

const MEMORY_COMPANION_READ_TOOLS = [
  'read',
  'grep',
  'glob',
  'codebase-search',
  'codebase-skeleton',
  'codebase-context',
  'codebase-read-symbol',
  'codebase-incoming-calls',
  'codebase-outgoing-calls',
  'codebase-impact-analysis',
  'tree',
  'codebase-repo-map',
  'codebase-stats',
];
const READ_NAMES = new Set(MEMORY_COMPANION_READ_TOOLS);
const DEFAULT_MEMORY_COMPANION_BUDGET = {
  maxIterations: 30_000,
  maxToolCalls: 80_000,
  maxTokens: 10_000_000,
  maxCostUsd: 200,
  timeoutMs: 18_000_000,
};

/** This predicate only narrows privileges; copying the prefix cannot grant any. */
export function isMemoryCompanion(config: SubagentConfig): boolean {
  return config.role === 'memory-curator' && config.id?.startsWith('memory-companion-') === true;
}

/** Reapply the host's read-only boundary AFTER project role/model overrides. */
export function constrainMemoryCompanion(config: SubagentConfig): SubagentConfig {
  const limited: SubagentConfig = {
    ...config,
    tools: [...MEMORY_COMPANION_READ_TOOLS],
    disabledTools: undefined,
    capabilities: [],
    allowedCapabilities: ['fs.read'],
    skillNames: [],
    skillPool: [],
    skillContent: undefined,
    gracefulFinish: false,
    spawnBudgetExempt: true,
    textStream: 'silent',
    toolStream: 'silent',
    sealed: true,
  };
  // Project budgets may be smaller or larger; the read-only tool boundary
  // is independent of how much time and model usage the review receives.
  for (const key of Object.keys(DEFAULT_MEMORY_COMPANION_BUDGET) as Array<
    keyof typeof DEFAULT_MEMORY_COMPANION_BUDGET
  >) {
    const value = config[key];
    limited[key] =
      typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : DEFAULT_MEMORY_COMPANION_BUDGET[key];
  }
  return limited;
}

/** Do not auto-add session_note: all conclusions must pass the host's evidence gate. */
export function memoryCompanionTools(available: readonly Tool[]): Tool[] {
  return [
    ...available.filter((tool) => READ_NAMES.has(tool.name) && !tool.mutating),
    makeSubagentResultTool(),
  ];
}
