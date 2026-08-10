/**
 * Catalog types for the WrongStack agent fleet.
 *
 * An `AgentDefinition` bundles the runtime `SubagentConfig` (id/name/role/
 * prompt/tools) with two things the bare config lacks:
 *   - a per-role `budget` tier (consumed by FLEET_ROSTER_BUDGETS), and
 *   - dispatcher `capability` metadata (keywords + summary + phase) used by
 *     the smart dispatcher to route a free-form task to the best agent.
 *
 * Phase files (`phase1-discovery.ts` … `phase9-meta.ts`) each export an
 * `AgentDefinition[]`; `index.ts` aggregates them into `AGENT_CATALOG`.
 * `fleet.ts` derives `FLEET_ROSTER` + `FLEET_ROSTER_BUDGETS` from the catalog.
 */
import type { SubagentConfig } from '../../types/multi-agent.js';
import { toolsForRuntimeCapabilities } from './capability-manifest.js';

/** Lifecycle phase grouping. Drives statusline labels + dispatcher tie-breaks. */
export type AgentPhase =
  | 'discovery'
  | 'planning'
  | 'build'
  | 'verify'
  | 'review'
  | 'domain'
  | 'knowledge'
  | 'delivery'
  | 'meta';

/** Per-role budget tier. Same shape as fleet.ts `FleetRosterBudget`. */
export interface AgentBudgetTier {
  timeoutMs?: number | undefined;
  maxIterations?: number | undefined;
  maxToolCalls?: number | undefined;
  maxTokens?: number | undefined;
  maxCostUsd?: number | undefined;
}

/** Dispatcher routing metadata. */
export interface AgentCapability {
  phase: AgentPhase;
  /**
   * One-line capability summary. Fed to the LLM dispatcher classifier as the
   * candidate's description, and shown to the user when explaining a routing
   * decision. Keep it concrete and distinct from sibling agents.
   */
  summary: string;
  /**
   * Lowercased signal words/phrases for the heuristic dispatcher. A task whose
   * description contains these scores toward this agent. Order doesn't matter;
   * prefer specific terms ("graphql", "wcag") over generic ones ("code").
   */
  keywords: string[];
  /**
   * Optional `RoleDispatcherSignal` attached to the role. Wave-1/2/3/4 roles
   * carry this to make the "why this role wins" rationale auditable; legacy
   * roles omit it and the dispatcher falls back to `summary` + `keywords`.
   */
  rationale?: RoleDispatcherSignal | undefined;
}

/**
 * Read-only view of a role's dispatcher rationale, surfaceable to operators.
 *
 * `rationale` explains what the role owns; `signals` are the dispatcher's
 * routing tokens (extended with role id, sibling keywords, etc. at scoring
 * time); `differentiatesFrom` is the human-readable contrast against the
 * closest sibling.
 */
export interface RoleDispatcherSignal {
  rationale: string;
  signals: readonly string[];
  /**
   * One-line description of how this role differs from its closest sibling
   * ("X finds defects; Y designs threats before code exists"). Used by tests
   * to assert distinct boundaries and by docs to explain routing.
   */
  differentiatesFrom: string;
}

/** A single catalog entry: runtime config + budget tier + routing metadata. */
export interface AgentDefinition {
  config: SubagentConfig;
  budget: AgentBudgetTier;
  capability: AgentCapability;
}

const HOUR = 60 * 60 * 1000;

/**
 * Budget tiers by workload weight. Deliberately generous — the project's
 * existing roster uses multi-hour ceilings to avoid spurious timeouts on
 * monorepo-scale work, and the auto-extend handshake raises them further when
 * a subagent is still making progress.
 */
export const LIGHT_BUDGET: AgentBudgetTier = {
  timeoutMs: 3 * HOUR,
  maxIterations: 3000,
  maxToolCalls: 8000,
};
export const MEDIUM_BUDGET: AgentBudgetTier = {
  timeoutMs: 5 * HOUR,
  maxIterations: 5000,
  maxToolCalls: 14000,
};
export const HEAVY_BUDGET: AgentBudgetTier = {
  timeoutMs: 10 * HOUR,
  maxIterations: 8000,
  maxToolCalls: 20000,
};

/**
 * Tool allowlist presets. Agents pass the smallest set that covers their job —
 * a planning agent should not hold `write`/`bash`, a reviewer should be
 * read-only. Spread + extend per-agent where a role needs one extra tool.
 */
export const TOOLS = {
  /** Pure read/inspect — safe for analysis and review agents. */
  read: ['read', 'grep', 'glob', 'search', 'tree', 'mailbox'],
  /** Read + structured inspection (logs, diffs, json, dependency audit). */
  inspect: ['read', 'grep', 'glob', 'search', 'tree', 'json', 'diff', 'logs', 'audit', 'mailbox'],
  /** Read + edit (no shell). For agents that write code/docs but don't run it. */
  write: ['read', 'grep', 'glob', 'search', 'tree', 'write', 'edit', 'replace', 'patch', 'mailbox'],
  /** Full build loop: edit + run (lint/format/typecheck/test/bash). */
  build: [
    'read',
    'grep',
    'glob',
    'search',
    'tree',
    'write',
    'edit',
    'replace',
    'patch',
    'bash',
    'exec',
    'lint',
    'format',
    'typecheck',
    'test',
    'mailbox',
  ],
  /**
   * Version control.
   *
   * `mailbox` is in every preset on purpose: a subagent that hits a wall must
   * be able to say so. This was the one preset without it, which left the `git`
   * and `release` roles able to fail but not to ask — the two roles whose work
   * most often needs a decision from the leader (force-push, tag collision,
   * dirty tree) and least often has a safe default.
   */
  vcs: ['read', 'grep', 'glob', 'git', 'diff', 'mailbox'],
  /** Dependency management + CVE audit. */
  deps: ['read', 'grep', 'glob', 'install', 'outdated', 'audit', 'json', 'mailbox'],
  /** Documentation authoring. */
  docs: ['read', 'grep', 'glob', 'search', 'tree', 'write', 'edit', 'document', 'mailbox'],
  /** Web research. */
  research: ['read', 'grep', 'glob', 'search', 'fetch', 'mailbox'],
} as const satisfies Record<string, readonly string[]>;

/** Canonical optional tool packs used by specialist roster roles. */
export const SPECIALIST_TOOLS = {
  browser: toolsForRuntimeCapabilities(['browser.interact']),
  memory: toolsForRuntimeCapabilities(['memory.manage']),
  mcp: toolsForRuntimeCapabilities(['mcp.dynamic']),
} as const satisfies Record<string, readonly string[]>;
