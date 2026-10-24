import type { SubagentConfig } from '@wrongstack/contracts/types/multi-agent';
import { renderInstructionLayer } from '../core/instruction-template.js';
import {
  composeDirectorPrompt,
  composeSubagentPrompt,
  rosterSummaryFromConfigs,
} from './director-prompts.js';
import type { DefaultMultiAgentCoordinator } from './multi-agent-coordinator.js';

export interface DirectorPromptHost {
  readonly coordinator: DefaultMultiAgentCoordinator;
  readonly directorPreamble: string;
  readonly roster: Record<string, SubagentConfig> | undefined;
  readonly subagentBaseline: string;
  readonly sharedScratchpadPath: string | null;
}

export function directorLeaderPrompt(host: DirectorPromptHost, basePrompt?: string): string {
  return composeDirectorPrompt({
    basePrompt: basePrompt ?? host.coordinator.config.leaderSystemPrompt,
    directorPreamble: host.directorPreamble,
    rosterSummary: host.roster ? rosterSummaryFromConfigs(host.roster) : undefined,
  });
}

export function directorSubagentPrompt(
  host: DirectorPromptHost,
  config: SubagentConfig,
  taskBrief?: string,
): string {
  return composeSubagentPrompt({
    baseline: renderInstructionLayer(host.subagentBaseline, {
      toolNames: new Set(config.tools ?? []),
      tier: 'off',
      subagent: true,
      strictToolReferences: true,
    }),
    role: config.prompt,
    task: taskBrief,
    sharedScratchpad: host.sharedScratchpadPath ?? undefined,
    skills: config.skillContent,
    override: config.systemPromptOverride,
  });
}
