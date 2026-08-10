/**
 * System-prompt composition helpers for the Director ecosystem.
 *
 * Two callers need composed prompts:
 *
 *   1. The **leader** (the director's own Agent) — needs a preamble that
 *      explains the fleet protocol: when to spawn, when to await, how to
 *      roll up, and the eight orchestration tools it owns.
 *
 *   2. Each **subagent** — needs a baseline that explains it has a parent
 *      it can call via the bridge, a role-specific block, the task brief,
 *      and finally any per-spawn `systemPromptOverride` from `SubagentConfig`.
 *
 * Both composers are pure functions: feed them parts, they return a string.
 * No I/O, no side effects, no implicit defaults beyond the ones exported
 * here. Callers (CLI multi-agent factory, Director itself) decide which
 * parts to fill in — that keeps the composition seam visible and testable.
 */

import { readBundledInstructionText } from '../utils/instruction-file.js';

/**
 * Default fleet-protocol preamble injected at the **front** of the
 * director-agent's system prompt.
 */
export const DEFAULT_DIRECTOR_PREAMBLE = readBundledInstructionText(
  'coordination/director-preamble.md',
);

/**
 * Default baseline prepended to every subagent's system prompt.
 */
export const DEFAULT_SUBAGENT_BASELINE = readBundledInstructionText(
  'coordination/subagent-baseline.md',
);

/** Parts the leader-prompt composer accepts. All optional. */
export interface DirectorPromptParts {
  /** The user's existing leader system prompt — typically what was passed
   *  via `MultiAgentConfig.leaderSystemPrompt`. */
  basePrompt?: string | undefined;
  /** Override the built-in fleet preamble. Pass empty string to suppress. */
  directorPreamble?: string | undefined;
  /** Optional roster summary block — a short list of pre-configured roles
   *  the director can spawn (e.g. "researcher, coder, reviewer"). Helps
   *  small models discover the available shapes without scanning tools. */
  rosterSummary?: string | undefined;
}

/**
 * Compose the leader/director's system prompt. Order:
 *   1. Director preamble (fleet protocol)
 *   2. Roster summary (optional, when provided)
 *   3. User base prompt (the per-project leader prompt)
 *
 * Sections are separated by a blank line. Empty parts are skipped so the
 * output never contains stray blank-line runs.
 */
export function composeDirectorPrompt(parts: DirectorPromptParts = {}): string {
  const sections: string[] = [];
  const preamble = parts.directorPreamble ?? DEFAULT_DIRECTOR_PREAMBLE;
  if (preamble && preamble.trim().length > 0) sections.push(preamble.trim());
  if (parts.rosterSummary && parts.rosterSummary.trim().length > 0) {
    // Naming the shape of the list matters as much as the list. Presented as a
    // bare menu, a leader reaches for the few ids it can recall and the deep
    // specialists never get picked; saying out loud that a specialist probably
    // exists, and that describing the work will find it, is what turns the
    // roster from a reference into a routing instruction.
    sections.push(
      'Roles you can spawn. This roster is deep and specialised — before handing work to a ' +
        'generalist, look for the agent built for exactly this job, and prefer describing the ' +
        'work (`description`) over recalling an id (`role`) so the dispatcher can find it:\n' +
        parts.rosterSummary.trim(),
    );
  }
  if (parts.basePrompt && parts.basePrompt.trim().length > 0) {
    sections.push(parts.basePrompt.trim());
  }
  return sections.join('\n\n');
}

/** Parts the subagent-prompt composer accepts. Layered from generic to
 *  specific; later layers override earlier ones when they conflict. */
export interface SubagentPromptParts {
  /** Base persona/identity for *every* subagent. Defaults to the bridge
   *  contract baseline. Pass empty string to suppress. */
  baseline?: string | undefined;
  /** Role-specific block, e.g. "You are a code reviewer. Focus on…". */
  role?: string | undefined;
  /** Task brief — usually the same string the runner passes as user input,
   *  but exposed here in case the factory wants it duplicated in the
   *  system prompt for reinforcement. */
  task?: string | undefined;
  /**
   * Absolute path to a shared scratchpad directory the whole fleet can
   * read/write. When set, the composer adds a "Shared notes" block that
   * tells the subagent where to drop findings and where to look for
   * sibling output. This is the cheap fleet-coordination channel —
   * agents don't need each other's transcripts, just each other's
   * conclusions. Falls between `task` and `override` so the override
   * can still narrow or replace it.
   */
  sharedScratchpad?: string | undefined;
  /**
   * Optional skill body content injected into the subagent's system prompt.
   * Use this to provide domain-specific knowledge (SKILL.md bodies) to
   * subagents that need it. Placed after `sharedScratchpad` and before
   * `override` so the override can still narrow or replace it.
   */
  skills?: string | undefined;
  /** Final per-spawn override from `SubagentConfig.systemPromptOverride`.
   *  Added last so it wins on conflict — that's by design: the spawn site
   *  knows the most about what this specific subagent should do. */
  override?: string | undefined;
}

/**
 * Compose a subagent's system prompt. Order:
 *   1. Baseline (bridge contract)
 *   2. Role
 *   3. Task brief
 *   4. Shared scratchpad
 *   5. Skills (domain knowledge from SKILL.md)
 *   6. Per-spawn override
 *
 * Same blank-line-separated joining as the director composer.
 *
 * Layering rationale: the baseline never needs to change between
 * subagents; the role is the "what kind of worker is this"; the task is
 * the "what should you do *now*"; skills provide reusable domain knowledge
 * (e.g. bug-hunting patterns, security scanning rules); the override is
 * the spawn-site escape hatch ("…and respond only in JSON"). Putting
 * override last means it never gets squashed by something earlier in the chain.
 */
export function composeSubagentPrompt(parts: SubagentPromptParts = {}): string {
  const sections: string[] = [];
  const baseline = parts.baseline ?? DEFAULT_SUBAGENT_BASELINE;
  if (baseline && baseline.trim().length > 0) sections.push(baseline.trim());
  if (parts.role && parts.role.trim().length > 0) {
    sections.push(`Role:\n${parts.role.trim()}`);
  }
  if (parts.task && parts.task.trim().length > 0) {
    sections.push(`Task:\n${parts.task.trim()}`);
  }
  if (parts.sharedScratchpad && parts.sharedScratchpad.trim().length > 0) {
    sections.push(
      `Shared notes:\n` +
        `A scratchpad shared with the rest of the fleet is mounted at \`${parts.sharedScratchpad.trim()}\`.\n` +
        `- Write your final findings as markdown files there (e.g. \`findings.md\`, \`security.md\`).\n` +
        `- Before starting, list the directory and read any sibling files relevant to your task — ` +
        `they may already contain context you can build on.\n` +
        `- Use stable filenames (one file per concern); overwrite instead of appending so the ` +
        `Director sees the latest state.`,
    );
  }
  if (parts.skills && parts.skills.trim().length > 0) {
    sections.push(`Domain knowledge:\n${parts.skills.trim()}`);
  }
  if (parts.override && parts.override.trim().length > 0) {
    sections.push(parts.override.trim());
  }
  return sections.join('\n\n');
}

/** Longest capability line rendered per role before it is cut. */
const ROSTER_SUMMARY_MAX_CHARS = 150;

/** A display name that only re-states the role id carries no information. */
function nameAddsInformation(roleId: string, name: string): boolean {
  const flatten = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return flatten(name) !== flatten(roleId);
}

/**
 * Render a bullet list summarising a roster — stuffed into
 * `composeDirectorPrompt({ rosterSummary })` so the leader can see the roles it
 * may spawn without scanning tool descriptions.
 *
 * Each entry: `- <role-id>[ (<name>)][ (provider/model)] — <capability>`
 *
 * The capability comes from `dispatch.summary`, the curated one-liner the
 * catalog already writes for every agent and the dispatcher already routes on.
 * It used to come from the first 80 characters of `config.prompt`, which is
 * how a 77-role menu came to read as 77 variations of "You are the X agent.
 * Your job is…" with the discriminating half cut off. A leader given that list
 * can only reliably pick the roles whose id spells out the job — and the usage
 * data matched exactly that: 57 of the 77 roles had never once been chosen.
 *
 * The prompt headline stays as the fallback for roles with no dispatch
 * metadata, so a hand-written project role is still listed.
 */
export function rosterSummaryFromConfigs(
  roster: Record<
    string,
    {
      name: string;
      provider?: string | undefined;
      model?: string | undefined;
      prompt?: string | undefined;
      role?: string | undefined;
      dispatch?: { summary: string; keywords: string[] } | undefined;
    }
  >,
): string {
  const lines: string[] = [];
  for (const [roleId, cfg] of Object.entries(roster)) {
    const tag = cfg.provider && cfg.model ? ` (${cfg.provider}/${cfg.model})` : '';
    const label = nameAddsInformation(roleId, cfg.name) ? ` (${cfg.name})` : '';
    const capability =
      cfg.dispatch?.summary?.trim() ||
      // Fallback headline: a role prompt that opens with a markdown heading
      // would otherwise render as "# Generic Project Agent", which reads as
      // formatting rather than as a capability.
      (cfg.prompt
        ? (cfg.prompt.split('\n').find((l) => l.trim().length > 0) ?? '')
            .replace(/^#+\s*/, '')
            .trim()
        : '');
    const headline =
      capability.length > ROSTER_SUMMARY_MAX_CHARS
        ? `${capability.slice(0, ROSTER_SUMMARY_MAX_CHARS - 1).trimEnd()}…`
        : capability;
    const tail = headline ? ` — ${headline}` : '';
    lines.push(`- ${roleId}${label}${tag}${tail}`);
  }
  return lines.join('\n');
}
