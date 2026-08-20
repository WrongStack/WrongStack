/**
 * Pre-built subagent role configurations for the WrongStack fleet.
 * These can be passed to `MultiAgentHost.spawn()` or used as templates
 * for the director's roster.
 */
import type { SubagentConfig } from '../types/multi-agent.js';
import { agentPrompt } from './agents/agent-prompts.js';
import {
  ALL_AGENT_DEFINITIONS,
  ROLE_SKILL_SETS,
  SHADOW_AGENT_SKILLS,
  TOOLS,
} from './agents/index.js';

function defineAgent(
  id: string,
  name: string,
  promptRole: string = id,
  provider?: string,
): SubagentConfig {
  return {
    id,
    name,
    role: id,
    prompt: agentPrompt(promptRole),
    ...(provider === undefined ? {} : { provider }),
  };
}

/**
 * Audit Log Agent — analyzes session logs, event streams, and traces.
 * Use for: post-mortems, trend analysis, operational insights.
 */
export const AUDIT_LOG_AGENT = defineAgent('audit-log', 'Audit Log');

/**
 * Bug Hunter Agent — systematic bug and code smell detection.
 * Use for: pre-refactoring health checks, code review, regression prevention.
 */
export const BUG_HUNTER_AGENT = defineAgent('bug-hunter', 'Bug Hunter');

/**
 * Refactor Planner Agent — structured refactoring planning.
 * Use for: large rewrites, technical debt reduction, architecture improvements.
 */
export const REFACTOR_PLANNER_AGENT = defineAgent('refactor-planner', 'Refactor Planner');

/**
 * Security Scanner Agent — vulnerability and secret detection.
 * Use for: CI checks, pre-release audits, dependency vulnerability scanning.
 */
export const SECURITY_SCANNER_AGENT = defineAgent('security-scanner', 'Security Scanner');

/**
 * Shadow Agent — one-shot fleet monitoring and intervention.
 * Use for: quiet anomaly checks and on-demand intervention.
 */
const SHADOW_AGENT: SubagentConfig = {
  ...defineAgent('shadow-agent', 'Shadow'),
  skillNames: [...SHADOW_AGENT_SKILLS],
};

/**
 * Explore Companion — state-triggered background codebase explorer.
 * Runs behind a leader agent: triggered by the in-progress state of the
 * work (unread-file edits, zero-hit searches, todo flips, explicit asks),
 * scans the codebase read-only, and feeds findings back via mailbox
 * `result`/`btw` + `submit_result`. See
 * docs/architecture/explore-companion-subagent.md.
 *
 * Operational role — deliberately NOT in ALL_AGENT_DEFINITIONS (like
 * `shadow-agent`), so the free-form dispatcher never routes to it and the
 * 75-definition catalog count stays intact. Probes are assigned, never
 * awaited; idle reaping comes from the FLEET_ROSTER_BUDGETS entry.
 */
export const EXPLORE_COMPANION_AGENT: SubagentConfig = {
  ...defineAgent('explore-companion', 'Explore Companion'),
  tools: [...TOOLS.read, ...TOOLS.index],
  // Read-only, triple-enforced: allowlist has no write/bash, and the
  // disabled list blocks the escape hatches explicitly.
  disabledTools: [
    'write',
    'edit',
    'replace',
    'patch',
    'bash',
    'exec',
    'delegate',
    'spawn_subagent',
    'assign_task',
  ],
  skillNames: [...ROLE_SKILL_SETS['explore-companion']],
  spawnBudgetExempt: true,
  // Findings travel via mailbox + submit_result, not the leader's stream.
  textStream: 'silent',
  toolStream: 'silent',
};

/**
 * Chaos Monkey ("Kaos Maymunu") — one-shot mutation-testing saboteur.
 * Use for: proving whether tests actually pin down the code they cover.
 *
 * Operational role — deliberately NOT in ALL_AGENT_DEFINITIONS (like
 * `shadow-agent` and `explore-companion`), so the free-form dispatcher
 * never routes to it and the phase-catalog count stays intact. The
 * `mutation_test` director tool computes the deterministic mutation plan
 * and hands this agent an exact apply/run/restore checklist; the agent
 * never invents mutants.
 */
export const CHAOS_MONKEY_AGENT: SubagentConfig = {
  ...defineAgent('chaos-monkey', 'Chaos Monkey'),
  tools: [...TOOLS.build],
  skillNames: ['testing', 'typescript-strict'],
  spawnBudgetExempt: true,
  // Run in the live checkout: mutation targets are usually freshly
  // written and uncommitted — a worktree spawned from HEAD would not
  // contain them and every mutant would drift. The mutation_test tool
  // honors this value as its default; callers can still override per
  // call via its `chaosWorktree` input when targets are committed and
  // isolation is wanted.
  worktree: 'off',
  // Report travels via submit_result + final text, not the leader's stream.
  textStream: 'silent',
  toolStream: 'silent',
};

/**
 * Critic Agent — evaluates code quality, architecture decisions, and
 * refactoring plans against project conventions and engineering standards.
 * Use for: real-time evaluation of bug reports, refactor plans, and
 * architectural proposals during collaborative debugging sessions.
 */
const CRITIC_AGENT = defineAgent('critic', 'Critic');

/** Generic template used directly or cloned into project-specific roles. */
export const GENERIC_AGENT = defineAgent('generic', 'Generic Project Agent');

/**
 * All agents in a map for easy lookup by role. The 75-role phase catalog
 * (`ALL_AGENT_DEFINITIONS`) already includes `critic` and the historical
 * audit/review specialists. Adding standalone `generic`, `shadow-agent`,
 * `explore-companion`, and `chaos-monkey` roles produces 79 unique built-in
 * role ids.
 */
/**
 * Carry the catalog's curated one-line capability onto the roster config.
 *
 * The catalog has written a precise summary for every agent — "Schema design,
 * query optimization, and safe reversible migrations for SQL databases." — but
 * it lived only on the definition, so the roster the leader is shown had to
 * fall back to the first 80 characters of the role prompt. Every one of those
 * begins "You are the X agent. Your job is…", which spends a third of the line
 * on boilerplate and then truncates exactly where the distinguishing part
 * starts. A leader choosing between 77 look-alike lines picks the handful whose
 * *id* it can guess, which is what the usage data shows.
 *
 * The field already exists on `SubagentConfig` for project-created roles, so
 * this simply makes built-ins carry the same shape. The definition object is
 * never mutated — the catalog stays the single source.
 */
function withDispatchMetadata(definition: (typeof ALL_AGENT_DEFINITIONS)[number]): SubagentConfig {
  const summary = definition.capability?.summary?.trim();
  if (!summary) return definition.config;
  return {
    ...definition.config,
    dispatch: { summary, keywords: [...(definition.capability.keywords ?? [])] },
  };
}

export const FLEET_ROSTER: Record<string, SubagentConfig> = {
  'audit-log': AUDIT_LOG_AGENT,
  'bug-hunter': BUG_HUNTER_AGENT,
  'refactor-planner': REFACTOR_PLANNER_AGENT,
  'security-scanner': SECURITY_SCANNER_AGENT,
  critic: CRITIC_AGENT,
  generic: GENERIC_AGENT,
  'shadow-agent': SHADOW_AGENT,
  'explore-companion': EXPLORE_COMPANION_AGENT,
  'chaos-monkey': CHAOS_MONKEY_AGENT,
  ...Object.fromEntries(
    ALL_AGENT_DEFINITIONS.map((d) => [d.config.role as string, withDispatchMetadata(d)] as const),
  ),
};

// ---------------------------------------------------------------------------
// Default per-role budgets — tuned for token cost efficiency.
//
// Reduced from x10 to ~x5 to prevent runaway costs while keeping enough
// headroom for productive multi-step tasks. A subagent that needs more
// can explicitly set `timeoutMs`/`maxIterations`/`maxToolCalls` via the
// delegate tool or the per-task `budget` field in spawn.
//
// Shrinking defaults means each subagent consumes fewer iterations and
// tool calls before budget renegotiation kicks in, and a runaway agent
// hits its ceiling sooner.
// ---------------------------------------------------------------------------
export interface FleetRosterBudget {
  timeoutMs?: number | undefined;
  /** Idle reap window (ms). Resets on activity — see `applyRosterBudget`. */
  idleTimeoutMs?: number | undefined;
  maxIterations?: number | undefined;
  maxToolCalls?: number | undefined;
  maxTokens?: number | undefined;
  maxCostUsd?: number | undefined;
}

/**
 * Default idle window for delegated subagents: reap after 10 min with
 * NO activity (no iteration / tool call / streamed progress). An actively-
 * working agent resets this clock continuously, so it runs until its task
 * naturally ends. Power users can still impose a hard `timeoutMs` per delegate.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export const FLEET_ROSTER_BUDGETS: Record<string, FleetRosterBudget> = {
  'audit-log': { timeoutMs: 3 * 60 * 60 * 1000, maxIterations: 2500, maxToolCalls: 7500 },
  'bug-hunter': { timeoutMs: 5 * 60 * 60 * 1000, maxIterations: 4000, maxToolCalls: 10000 },
  'refactor-planner': { timeoutMs: 4 * 60 * 60 * 1000, maxIterations: 3000, maxToolCalls: 9000 },
  'security-scanner': { timeoutMs: 5 * 60 * 60 * 1000, maxIterations: 4000, maxToolCalls: 10000 },
  critic: { timeoutMs: 3 * 60 * 60 * 1000, maxIterations: 2000, maxToolCalls: 6000 },
  generic: { idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS, maxIterations: 2500, maxToolCalls: 7500 },
  'shadow-agent': {
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    maxIterations: 1000,
    maxToolCalls: 2500,
    // Monitoring passes routinely include a large system prompt plus fleet
    // context. 30k was below observed single-pass usage and therefore triggered
    // a post-response negotiation every run; 96k leaves headroom while the cost
    // and tool/iteration caps still bound runaway work.
    maxTokens: 96_000,
    maxCostUsd: 0.5,
  },
  'explore-companion': {
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    maxIterations: 3000,
    maxToolCalls: 8000,
    maxTokens: 96_000,
    maxCostUsd: 0.5,
  },
  'chaos-monkey': {
    // A mutation pass is many short apply/run/restore cycles — per-mutant
    // work is tiny, but a large plan (25 mutants/file × N files) needs
    // headroom. Idle-based reaping covers a stalled pass.
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    maxIterations: 2000,
    maxToolCalls: 6000,
    maxTokens: 96_000,
    maxCostUsd: 0.5,
  },
  ...Object.fromEntries(
    ALL_AGENT_DEFINITIONS.map((d) => [d.config.role as string, d.budget] as const),
  ),
};

/**
 * Apply roster budget to a config (only when the config has no explicit
 * budget fields set). This is called by the coordinator before dispatch.
 */
// Generic default budget applied when no role matches and no explicit budget
// fields are set. Used for `name` / free-form delegates. There is no default
// wall-clock timeout — a delegated agent runs until its task naturally ends
// (`end_turn`) or it stalls past the idle window. Iteration / tool-call ceilings
// remain as a runaway backstop.
const GENERIC_SUBAGENT_BUDGET: FleetRosterBudget = {
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  maxIterations: 2500,
  maxToolCalls: 7500,
};

export function applyRosterBudget(cfg: SubagentConfig): SubagentConfig {
  // First try role-specific budget; fall back to generic for name-only delegates.
  const roleBudget = cfg.role ? FLEET_ROSTER_BUDGETS[cfg.role] : undefined;
  const defaultBudget = roleBudget ?? (cfg.name ? GENERIC_SUBAGENT_BUDGET : undefined);
  if (!defaultBudget) return cfg;
  return {
    ...cfg,
    // Wall-clock cap is opt-in only: forward an explicit `cfg.timeoutMs`, but
    // do NOT impose the roster's historical multi-hour wall-clock default — it
    // killed agents that were still actively working. Reaping is idle-based.
    timeoutMs: cfg.timeoutMs,
    // Idle window is the default reaper. Resets on activity, so a long-but-
    // productive run is never killed; only a genuine stall is reaped.
    idleTimeoutMs: cfg.idleTimeoutMs ?? defaultBudget.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    maxIterations: cfg.maxIterations ?? defaultBudget.maxIterations,
    maxToolCalls: cfg.maxToolCalls ?? defaultBudget.maxToolCalls,
    maxTokens: cfg.maxTokens ?? defaultBudget.maxTokens,
    maxCostUsd: cfg.maxCostUsd ?? defaultBudget.maxCostUsd,
  };
}

/** Quick-access list for spawning all at once. */
export const ALL_FLEET_AGENTS = Object.values(FLEET_ROSTER);

// ---------------------------------------------------------------------------
// ACP external agents — WrongStack spawns these as subagents via ACP protocol.
// Each agent runs its own loop; WrongStack sends tasks as ACP messages and
// receives results. These don't go through makeAgentSubagentRunner — they
// are handled by makeACPSubagentRunner in the CLI multi-agent layer.
// ---------------------------------------------------------------------------

/**
 * Cline — ACP-compatible coding agent by @asonix.
 * Spawned as: `npx @agentify/cline`
 */
const CLINE_AGENT = defineAgent('cline', 'Cline', 'acp-cline', 'acp');

/**
 * Gemini CLI — Google's ACP-compatible command-line agent.
 * Spawned as: `gemini` (when gemini CLI is installed and in PATH)
 */
const GEMINI_CLI_AGENT = defineAgent('gemini-cli', 'Gemini CLI', 'acp-gemini-cli', 'acp');

/**
 * GitHub Copilot (public preview) — ACP-compatible Copilot CLI agent.
 * Spawned as: `gh copilot` (when gh CLI with copilot extension is installed)
 */
const COPILOT_AGENT = defineAgent('copilot', 'GitHub Copilot', 'acp-copilot', 'acp');

/**
 * OpenHands — AI coding agent by all-in.ai, ACP-compatible.
 * Spawned as: `openhands` (when installed)
 */
const OPENHANDS_AGENT = defineAgent('openhands', 'OpenHands', 'acp-openhands', 'acp');

/**
 * Goose — IDE agent by ExoRL, ACP-compatible.
 * Spawned as: `goose` (when goose CLI is installed)
 */
const GOOSE_AGENT = defineAgent('goose', 'Goose', 'acp-goose', 'acp');

/** All ACP external agents. */
export const ACP_AGENTS: SubagentConfig[] = [
  CLINE_AGENT,
  GEMINI_CLI_AGENT,
  COPILOT_AGENT,
  OPENHANDS_AGENT,
  GOOSE_AGENT,
];

// ACP agents share the same generous budgets as the built-in fleet agents.
// External ACP agents may need more time than typical in-process subagents
// since they run their own loops and may do tool-call round-trips.
const ACP_AGENT_BUDGET: FleetRosterBudget = {
  timeoutMs: 10 * 60 * 60 * 1000,
  maxIterations: 8000,
  maxToolCalls: 20000,
};
for (const agent of ACP_AGENTS) {
  FLEET_ROSTER_BUDGETS[agent.role as string] = { ...ACP_AGENT_BUDGET };
}

/** Extended roster including ACP agents. */
export const FLEET_ROSTER_WITHACP: Record<string, SubagentConfig> = {
  ...FLEET_ROSTER,
  ...Object.fromEntries(ACP_AGENTS.map((a) => [a.role as string, a])),
};
