import type { SubagentConfig, TextBlock } from '@wrongstack/contracts/types';

const PROJECT_CONTEXT_BLOCK =
  /\s*<!-- wrongstack:project-agent-context:start -->[\s\S]*?<!-- wrongstack:project-agent-context:end -->\s*/g;

/**
 * Output cap per tool iteration for Chimera reviewers. Diffs and line numbers
 * are already embedded in the task bundle, so bounded excerpts keep follow-up
 * turns lean.
 */
export const CHIMERA_REVIEWER_OUTPUT_CAP_BYTES = 40_000;

export const CHIMERA_REVIEWER_READ_ONLY_TOOLS = Object.freeze([
  'read',
  'grep',
  'glob',
  'codebase-skeleton',
  'codebase-context',
  'codebase-incoming-calls',
  'codebase-outgoing-calls',
] as const);

/**
 * Detect ephemeral Chimera reviewer subagents (`name === 'chimera-review'` and
 * `role === 'reviewer'`). Like `isExploreCompanion`, this predicate only
 * narrows privileges and bypasses general code-writing prompt bloat (~25k
 * tokens of AGENTS.md, skill bodies, memory retrieval, mailbox directories, and
 * `## LEARNED` capture instructions).
 *
 * Deliberately does NOT set `sealed: true` so `coordinator.assign()` works and
 * in-band BTW pacing / `gracefulFinish: true` notifications still reach the
 * reviewer loop.
 */
export function isChimeraReviewer(config: SubagentConfig): boolean {
  return config.name === 'chimera-review' && config.role === 'reviewer';
}

/**
 * Reapply the read-only, skill-free, silent, budget-exempt reviewer surface
 * AFTER project role overrides so `.wrongstack/agents/reviewer` cannot widen
 * tools, re-inject heavy skill pools, or disable graceful finish.
 */
export function constrainChimeraReviewer(config: SubagentConfig): SubagentConfig {
  return {
    ...config,
    tools: [...CHIMERA_REVIEWER_READ_ONLY_TOOLS],
    allowedCapabilities: ['fs.read'],
    worktree: 'off',
    skillNames: [],
    skillPool: [],
    skillContent: undefined,
    gracefulFinish: true,
    textStream: 'silent',
    toolStream: 'silent',
    spawnBudgetExempt: true,
  };
}

/**
 * Deterministic, ephemeral-cached system prompt for Chimera reviewers (~2k
 * tokens instead of ~27k). Identical across every review of a project so
 * Anthropic / OpenAI / Gemini prefix caching hits across both multi-turn tool
 * loops and successive mid-session / post-session reviews.
 */
export function chimeraReviewerSystemPrompt(input: {
  rolePrompt: string | undefined;
  projectRoot: string;
  platform?: NodeJS.Platform | undefined;
}): TextBlock[] {
  const brief = (input.rolePrompt ?? '').replace(PROJECT_CONTEXT_BLOCK, '\n').trim();
  const environment = [
    '# Environment',
    `- Project root: ${input.projectRoot}`,
    `- Platform: ${input.platform ?? process.platform}`,
    '- Paths in findings are relative to the project root.',
  ].join('\n');
  return [
    {
      type: 'text',
      text: brief ? `${brief}\n\n${environment}` : environment,
      cache_control: { type: 'ephemeral' },
    },
  ];
}
