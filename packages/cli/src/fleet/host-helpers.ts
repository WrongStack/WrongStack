import * as path from 'node:path';
import { type FleetWorktreePolicy, makeSubagentResultTool } from '@wrongstack/core/coordination';
import {
  ToolCapabilities,
  WIDE_SUBAGENT_CAPABILITIES,
  clampSubagentCapabilities,
} from '@wrongstack/core/security';
import type { Config, SubagentConfig, TaskSpec, Tool } from '@wrongstack/core/types';
import { makePreferSideConflictResolver } from '@wrongstack/sdd';

type AgentAvailability = NonNullable<SubagentConfig['availability']>;

export function isInsideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isAgentAvailable(
  schedule: AgentAvailability,
  at = new Date(),
): { allowed: boolean; localTime: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Sun';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  const current = hour * 60 + minute;
  const parseTime = (value: string) => {
    const [hours = '0', minutes = '0'] = value.split(':');
    return Number(hours) * 60 + Number(minutes);
  };
  const start = parseTime(schedule.start);
  const end = parseTime(schedule.end);
  const inWindow =
    start <= end
      ? schedule.days.includes(day) && current >= start && current < end
      : (schedule.days.includes(day) && current >= start) ||
        (schedule.days.includes((day + 6) % 7) && current < end);
  return {
    allowed: inWindow,
    localTime: `${weekday} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${schedule.timezone}`,
  };
}

export function buildShadowAgentTaskDescription(reason: string): string {
  return `Shadow Agent one-shot fleet monitor. Reason: ${reason}.

Run exactly one quiet pass:
- Call fleet with action: "status" and action: "health".
- Inspect mail_inbox only for explicit hoop/shadow control messages.
- Do not broadcast startup, heartbeat, shutdown, or healthy status messages.
- Use mail_send only for high/critical anomalies or explicit control replies.
- Terminate agents only when explicitly commanded.
- If the fleet is healthy and no command needs a reply, keep the final answer to "shadow: quiet".

The host will stop this Shadow Agent after this pass. Do not schedule follow-up work.`;
}

export function touchLruKey(order: string[], key: string): void {
  const existingIdx = order.indexOf(key);
  if (existingIdx !== -1) order.splice(existingIdx, 1);
  order.push(key);
}

export function setBoundedLruEntry<T>(
  map: Map<string, T>,
  order: string[],
  key: string,
  value: T,
  maxEntries: number,
): void {
  const existingIdx = order.indexOf(key);
  if (existingIdx !== -1) order.splice(existingIdx, 1);
  while (order.length >= maxEntries) {
    const oldest = order.shift();
    if (oldest) map.delete(oldest);
  }
  map.set(key, value);
  order.push(key);
}

export const DEFAULT_SUBAGENT_HIDDEN_TOOLS = new Set([
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
]);

/**
 * Tools a subagent can never receive — not even through an explicit
 * `tools: [...]` allowlist.
 *
 * This is stricter than {@link DEFAULT_SUBAGENT_HIDDEN_TOOLS}, which only hides
 * orchestration controls from the unrestricted default slice and still hands
 * them over when a spawn asks for them by name. `nextsteps` records the
 * leader's after-task suggestions: the runtime folds a recorded block into a
 * LEADER turn only (`next-steps-slot.ts`), and `WIDE_SUBAGENT_CAPABILITIES`
 * does not carry `session.nextsteps`. Granting it would produce either a
 * permission rejection or a silent no-op, so asking for it by name is a
 * mistake to correct rather than an intent to honor.
 */
export const NEVER_SUBAGENT_TOOLS = new Set(['nextsteps']);

export function selectSubagentTools(
  allTools: readonly Tool[],
  directorToolsByName: ReadonlyMap<string, Tool>,
  allow?: readonly string[] | undefined,
): Tool[] {
  if (!allow || allow.length === 0) {
    const visible = new Map(
      allTools
        .filter(
          (tool) =>
            !DEFAULT_SUBAGENT_HIDDEN_TOOLS.has(tool.name) && !NEVER_SUBAGENT_TOOLS.has(tool.name),
        )
        .map((tool) => [tool.name, tool] as const),
    );
    visible.set('submit_result', makeSubagentResultTool());
    return Array.from(visible.values());
  }
  const allowSet = new Set(allow);
  const result = new Map<string, Tool>();
  for (const tool of allTools) {
    if (allowSet.has(tool.name) && !NEVER_SUBAGENT_TOOLS.has(tool.name))
      result.set(tool.name, tool);
  }
  for (const name of allowSet) {
    if (NEVER_SUBAGENT_TOOLS.has(name)) continue;
    const directorTool = directorToolsByName.get(name);
    if (directorTool && !result.has(name)) result.set(name, directorTool);
  }
  const missing = [...allowSet].filter(
    (name) => !NEVER_SUBAGENT_TOOLS.has(name) && !result.has(name),
  );
  if (missing.length > 0) {
    throw new Error(`Subagent tool contract is not registered: ${missing.sort().join(', ')}`);
  }
  result.set('submit_result', makeSubagentResultTool());
  return Array.from(result.values());
}

export function resolveSubagentCapabilities(
  subCfg: SubagentConfig,
  toolsForAllow: (allow: readonly string[]) => readonly Tool[],
): readonly string[] | undefined {
  // Both branches below are fed by `subCfg`, which on the director/kanban
  // dispatch path is MODEL OUTPUT: `allowedCapabilities` is un-enum'd on those
  // tool schemas, and `tools` is a free-form string array. Untrusted input may
  // narrow a grant, never widen one — so every path out of this function is
  // clamped to the same ceiling the two sibling parsers already use
  // (`project-agent-identity.ts` and `kanban-task-inputs.ts`). Without this,
  // prompt injection could name a capability directly, or name a tool and
  // inherit its capabilities transitively (`plugin_manager` → `config.mutate`
  // → `npx -y <pkg>`), and the widened grant PERSISTS onto the Kanban board to
  // be replayed on a later user-initiated dispatch.
  if (subCfg.allowedCapabilities) {
    // COORDINATION_RESULT_SUBMIT is inside WIDE_SUBAGENT_CAPABILITIES, so the
    // clamp preserves it — a subagent can always report its result back.
    return clampSubagentCapabilities([
      ...subCfg.allowedCapabilities,
      ToolCapabilities.COORDINATION_RESULT_SUBMIT,
    ]).granted;
  }
  const allow = subCfg.tools;
  // Absent and empty are NOT the same request, and conflating them inverted the
  // default in the worst direction: on the director/kanban path `subCfg` is
  // model output, so an injected turn emitting `tools: []` — which reads as
  // "grant nothing" to every human — received WIDE_SUBAGENT_CAPABILITIES,
  // including `shell.arbitrary` and `package.install`.
  //
  // Absent still means "no constraint expressed" and keeps the wide default.
  // An explicit empty list now grants the floor: the subagent can report its
  // result back (otherwise the dispatch silently hangs) and nothing else.
  if (allow && allow.length === 0) {
    return clampSubagentCapabilities([ToolCapabilities.COORDINATION_RESULT_SUBMIT]).granted;
  }
  if (!allow) return WIDE_SUBAGENT_CAPABILITIES;
  const caps = new Set<string>(WIDE_SUBAGENT_CAPABILITIES);
  for (const tool of toolsForAllow([...allow])) {
    for (const capability of tool.capabilities ?? []) caps.add(capability);
  }
  return clampSubagentCapabilities([...caps]).granted;
}

export function resolveFleetWorktreePolicy(config: Config): FleetWorktreePolicy {
  const env = process.env['WRONGSTACK_FLEET_WORKTREES']?.trim().toLowerCase();
  if (env === '0' || env === 'false' || env === 'off') {
    return { ...(config.fleet?.worktrees ?? {}), enabled: false, mode: 'off' };
  }
  if (env === 'required') {
    return { ...(config.fleet?.worktrees ?? {}), enabled: true, mode: 'required' };
  }
  if (env === 'auto' || env === '1' || env === 'true' || env === 'on') {
    return { ...(config.fleet?.worktrees ?? {}), enabled: true, mode: 'auto' };
  }
  const configured = config.fleet?.worktrees ?? {};
  return {
    ...configured,
    enabled: configured.enabled ?? true,
    mode: configured.mode ?? 'auto',
  };
}

export function makeFleetWorktreeConflictResolver() {
  const mode = process.env['WRONGSTACK_FLEET_CONFLICT_RESOLVER']?.trim().toLowerCase();
  if (mode !== 'prefer-incoming' && mode !== 'prefer-base') return undefined;
  const resolver = makePreferSideConflictResolver(mode === 'prefer-incoming' ? 'incoming' : 'base');
  return (info: { task: TaskSpec; conflictFiles: string[]; cwd: string }) =>
    resolver({
      task: info.task as never,
      conflictFiles: info.conflictFiles,
      cwd: info.cwd,
    });
}
