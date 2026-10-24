import type { SubagentConfig, TextBlock } from '@wrongstack/contracts/types';
import { DEFAULT_EXPLORE_COMPANION_AGENT_ID, FLEET_ROSTER } from '@wrongstack/core/coordination';

export const EXPLORE_COMPANION_ID_PREFIX = `${DEFAULT_EXPLORE_COMPANION_AGENT_ID}-`;

/**
 * The host-spawned resident (`createHostExploreCompanion`), not any spawn that
 * names the role. This predicate only narrows privileges and prompt; copying
 * the prefix cannot grant anything.
 */
export function isExploreCompanion(config: SubagentConfig): boolean {
  return (
    config.role === DEFAULT_EXPLORE_COMPANION_AGENT_ID &&
    config.id?.startsWith(EXPLORE_COMPANION_ID_PREFIX) === true
  );
}

/**
 * Tool-output bytes one probe step may add to its context. Every byte is
 * re-sent on each later request of the probe; a narrow lookup that needs more
 * than ~7k tokens of raw output in one step is asking the wrong question.
 */
export const EXPLORE_COMPANION_OUTPUT_CAP_BYTES = 24_000;

/** Reapply the read-only, skill-free surface AFTER project role overrides. */
export function constrainExploreCompanion(config: SubagentConfig): SubagentConfig {
  return {
    ...config,
    tools: [...(FLEET_ROSTER[DEFAULT_EXPLORE_COMPANION_AGENT_ID]?.tools ?? [])],
    // The role brief carries the navigation method; skill bodies and their
    // project addenda were ~16 KB of every request for a 2–4 call lookup.
    skillNames: [],
    skillPool: [],
    skillContent: undefined,
    gracefulFinish: false,
    textStream: 'silent',
    toolStream: 'silent',
    sealed: true,
    spawnBudgetExempt: true,
  };
}

const PROJECT_CONTEXT_BLOCK =
  /\s*<!-- wrongstack:project-agent-context:start -->[\s\S]*?<!-- wrongstack:project-agent-context:end -->\s*/g;

/**
 * The whole system prompt of a probe: role brief plus the facts a path-citing
 * reader needs. Measured on this repository the general subagent prompt cost
 * ~27k tokens on every request of every probe — the code-writing baseline,
 * user and project AGENTS.md, tool guides, three skills with addenda, the
 * consolidated role document and the LEARNED-capture brief — against a median
 * of five requests per probe. None of it changes how a read-only lookup is
 * answered, so the companion gets none of it. The project overlay is stripped
 * from the roster prompt too: it asks for `## LEARNED` blocks this role no
 * longer feeds, and its consolidated document pushed probes toward repo-wide
 * closure instead of the narrow answer the leader is waiting on.
 */
export function exploreCompanionSystemPrompt(input: {
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
      // Identical for every probe of a project, so one cached prefix serves
      // the resident's whole life.
      cache_control: { type: 'ephemeral' },
    },
  ];
}
