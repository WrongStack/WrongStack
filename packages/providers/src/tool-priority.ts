/**
 * Priority-based tool filtering for providers with tool-count limits.
 *
 * Some providers impose a hard limit on the number of tool definitions
 * accepted in a single request (configured per provider via the `maxTools`
 * compatibility quirk). When the registered tool count
 * exceeds this limit, {@link filterToolsByMaxCount} drops the lowest-priority
 * tools so the provider never receives more tools than it can handle.
 *
 * Priority is determined entirely by tool name — the most stable identifier
 * across sessions, configs, and plugin sets. Tools are grouped into tiers
 * that mirror the existing token-saving tier system (TIER1/2/3 in
 * `@wrongstack/tools/builtin`), with diagnostic/status tools assigned the
 * lowest priority since the model rarely needs to invoke them directly.
 */
import type { Tool } from '@wrongstack/core/types';

// ─── Priority tiers (lower number = higher priority) ──────────────────────

/** P0 — core file/shell operations the model needs every turn. */
const CRITICAL_TOOLS = new Set(['read', 'write', 'edit', 'bash', 'exec', 'grep', 'glob']);

/** P1 — indexed discovery, version control, and essential utilities. */
const ESSENTIAL_TOOLS = new Set([
  'diff',
  'patch',
  'json',
  'search',
  'fetch',
  'git',
  'codebase-stats',
  'codebase-search',
  'codebase-index',
]);

/** P2 — code quality, planning, and task management. */
const STANDARD_TOOLS = new Set([
  'test',
  'lint',
  'typecheck',
  'format',
  'todo',
  // Opt-in and leader-only: a user who turned it on wants it, so it must not
  // be pruned ahead of the task-management tools it belongs with.
  'nextsteps',
  'plan',
  'task',
  'kanban',
  'replace',
  'tree',
  'context_manager',
  'dead-code-scan',
]);

/** P3 — specialized but productive tools. */
const USEFUL_TOOLS = new Set([
  'design',
  'install',
  'audit',
  'outdated',
  'language',
  'language_info',
  'language_package',
  'e2e_plan',
  'llm',
  'council',
  'scaffold',
  'document',
  'logs',
]);

/** P4 — coordination and fleet tools (leader-only, but important when active). */
const COORDINATION_TOOLS = new Set([
  'delegate',
  'spawn_subagent',
  'assign_task',
  'kanban_queue',
  'await_tasks',
  'ask_subagent',
  'ask_result',
  'roll_up',
  'quality_gate',
  'terminate_subagent',
  'terminate_all',
  'work_complete',
  'collab_debug',
  'fleet_emit',
  'fleet',
  'fleet_status',
  'submit_result',
  'mail_send',
  'mail_inbox',
  'mailbox',
]);

/** P5 — meta-navigation tools that help discover others. */
const META_TOOLS = new Set([
  'tool_search',
  'tool_use',
  'batch_tool_use',
  'tool_help',
  'set_working_dir',
  'plugin_manager',
]);

/**
 * P6 — diagnostic/status tools. These are the lowest priority because they
 * report internal state the model almost never needs to invoke during normal
 * development; they exist primarily for `/` slash-command consumption and
 * human inspection.
 */
const LOW_PRIORITY_SUFFIXES = ['_status', '_test'] as const;

/**
 * Score a single tool for filtering priority.
 *
 * @returns A number 0–6 where 0 is the highest priority (never dropped first)
 *          and 6 is the lowest (dropped first).
 */
export function scoreTool(tool: Tool): number {
  const name = tool.name;

  if (CRITICAL_TOOLS.has(name)) return 0;
  if (ESSENTIAL_TOOLS.has(name)) return 1;
  if (STANDARD_TOOLS.has(name)) return 2;
  if (COORDINATION_TOOLS.has(name)) return 4;
  if (META_TOOLS.has(name)) return 5;

  // Browser tools are useful but situational — 16 slots is a lot to spend
  // when the session doesn't involve web testing.
  if (name.startsWith('browser_')) return 3;

  if (USEFUL_TOOLS.has(name)) return 3;

  // Governance / diagnostic status tools get the lowest priority.
  for (const suffix of LOW_PRIORITY_SUFFIXES) {
    if (name.endsWith(suffix)) return 6;
  }

  return 4; // Unknown tools: medium-low priority
}

/**
 * Filter a tool list to at most `maxTools` entries, keeping the
 * highest-priority tools and preserving their original registration order.
 *
 * When `tools.length <= maxTools`, the input is returned unchanged (as a
 * shallow copy) — no allocation, no scoring.
 *
 * @param tools    The full registered tool list (from `ToolRegistry.list()`).
 * @param maxTools The provider-imposed limit. Must be a positive integer.
 * @returns A new array containing at most `maxTools` tools, in their original
 *          relative order.
 */
export function filterToolsByMaxCount(tools: readonly Tool[], maxTools: number): Tool[] {
  if (tools.length <= maxTools) return [...tools];

  // Decorate with score + original index for stable sort.
  const scored = tools.map((tool, index) => ({
    tool,
    score: scoreTool(tool),
    index,
  }));

  // Sort by priority ascending; ties broken by original registration order.
  scored.sort((a, b) => a.score - b.score || a.index - b.index);

  // Keep the top `maxTools`, then restore original order so the provider
  // sees tools in the same sequence every request (cache-friendly).
  const kept = scored.slice(0, maxTools);
  kept.sort((a, b) => a.index - b.index);

  return kept.map((s) => s.tool);
}
