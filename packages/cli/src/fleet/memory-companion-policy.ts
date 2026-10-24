import type { SubagentConfig, Tool } from '@wrongstack/contracts/types';
import { makeSubagentResultTool } from '@wrongstack/core/coordination';

export const MEMORY_COMPANION_READ_TOOLS = [
  'read',
  'grep',
  'glob',
  'codebase-search',
  'codebase-skeleton',
];
const READ_NAMES = new Set(MEMORY_COMPANION_READ_TOOLS);
const CAPS = {
  maxIterations: 8,
  maxToolCalls: 12,
  maxTokens: 64000,
  maxCostUsd: 0.15,
  timeoutMs: 60000,
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
  for (const key of Object.keys(CAPS) as Array<keyof typeof CAPS>) {
    const value = config[key];
    limited[key] =
      typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.min(value, CAPS[key])
        : CAPS[key];
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
