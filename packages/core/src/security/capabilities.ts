/**
 * Well-known tool capabilities used for authorization decisions.
 *
 * These are the preferred values for `Tool.capabilities`.
 * New capabilities should be added here with clear documentation.
 *
 * Philosophy (2026-06+):
 * - Prefer capabilities over exact tool name matching.
 * - Subagent guards and future policies should primarily key off capabilities.
 * - Name-based denylists are legacy and will be phased down.
 */
export const ToolCapabilities = {
  /** Can execute arbitrary commands in the user's shell (the `bash` tool). */
  SHELL_ARBITRARY: 'shell.arbitrary',

  /**
   * Can execute the `exec` tool's allowlisted commands.
   *
   * "Restricted" describes the command NAME check, not the resulting power.
   * Treat this as equivalent to {@link SHELL_ARBITRARY} when deciding what to
   * grant: the allowlist includes general-purpose interpreters (`node`,
   * `python`, `perl`, `ruby`) and, on Windows, the platform shells (`cmd`,
   * `powershell`, `pwsh`) — deliberately, since without them `exec` cannot run
   * `dir`/`type`/any cmdlet. `node -e …` or `cmd /c …` therefore reaches
   * arbitrary execution, and per-argument denylisting cannot close that while
   * the shells remain (blocking `node -e` still leaves `cmd /c node -e`).
   *
   * What actually bounds this is downstream, not the name check: the permission
   * policy reconstructs the full command line and runs it through the
   * destructive classifier, so destructive calls still require confirmation.
   *
   * Granting `shell.restricted` while withholding `shell.arbitrary` therefore
   * buys no meaningful reduction in blast radius. Documented rather than
   * silently implied, because the two read as a narrow/wide pair (WS-083).
   */
  SHELL_RESTRICTED: 'shell.restricted',

  /** Can run a restricted project formatter/linter-style command. */
  SHELL_EXEC: 'shell.exec',

  /** Can read files inside the project (and possibly outside via symlinks if not guarded). */
  FS_READ: 'fs.read',

  /** Can write / modify / delete files inside the project. */
  FS_WRITE: 'fs.write',

  /** Can write files outside the current project root (very high risk). */
  FS_WRITE_OUTSIDE_PROJECT: 'fs.write.outside-project',

  /** Can perform outbound network requests. */
  NET_OUTBOUND: 'net.outbound',

  /** Can mutate in-memory session todos only. */
  SESSION_TODO: 'session.todo',

  /**
   * Can post an ephemeral same-session note to the leader or a peer
   * (`session_note` / `session.note`). In-process only — not the durable
   * cross-session mailbox (`coordination.mail`).
   */
  SESSION_NOTE: 'session.note',

  /** Can park after-task `<nextsteps>` suggestions for the current turn. */
  SESSION_NEXTSTEPS: 'session.nextsteps',

  /** Can mutate in-memory session mode only. */
  SESSION_MODE: 'session.mode',

  /** Can inspect registered tool metadata. */
  TOOL_META: 'tool.meta',

  /** Can invoke arbitrary registered tools through a meta-tool. */
  TOOL_MUTATE_ANY: 'tool.mutate.any',

  /** Can read persistent memory. */
  MEMORY_READ: 'memory.read',

  /** Can write persistent memory. */
  MEMORY_WRITE: 'memory.write',

  /** Can delete persistent memory. */
  MEMORY_DELETE: 'memory.delete',

  /** Proxies tools from external MCP servers (unknown capability). */
  MCP_PROXY: 'mcp.proxy',

  /** Can spawn or manage subagents / multi-agent tasks. */
  SUBAGENT_SPAWN: 'subagent.spawn',

  /** Can inspect fleet/subagent coordination state without mutating it. */
  COORDINATION_FLEET_READ: 'coordination.fleet.read',

  /** Can publish attributed, schema-checked events onto the fleet bus. */
  COORDINATION_FLEET_EMIT: 'coordination.fleet.emit',

  /** Can submit a task-local structured result to the parent Director. */
  COORDINATION_RESULT_SUBMIT: 'coordination.result.submit',

  /** Can read or write inter-agent mailbox messages. */
  COORDINATION_MAIL: 'coordination.mail',

  /** Can schedule, inspect, or cancel in-session cron jobs. */
  COORDINATION_CRON: 'coordination.cron',

  /** Can mutate global or session configuration / trust state. */
  CONFIG_MUTATE: 'config.mutate',

  /** Can install packages or run package managers with side effects. */
  PACKAGE_INSTALL: 'package.install',
} as const;

export type ToolCapability = (typeof ToolCapabilities)[keyof typeof ToolCapabilities];

/**
 * Set of capabilities that are considered dangerous for subagents by default.
 * Subagents should not receive these capabilities unless the leader explicitly
 * allows the specific tool at spawn time.
 */
export const DANGEROUS_FOR_SUBAGENTS: readonly ToolCapability[] = [
  ToolCapabilities.SHELL_ARBITRARY,
  ToolCapabilities.SHELL_RESTRICTED,
  ToolCapabilities.SHELL_EXEC,
  ToolCapabilities.FS_WRITE,
  ToolCapabilities.FS_WRITE_OUTSIDE_PROJECT,
  ToolCapabilities.TOOL_MUTATE_ANY,
  ToolCapabilities.MEMORY_WRITE,
  ToolCapabilities.MEMORY_DELETE,
  ToolCapabilities.MCP_PROXY,
  ToolCapabilities.SUBAGENT_SPAWN,
  ToolCapabilities.CONFIG_MUTATE,
  ToolCapabilities.PACKAGE_INSTALL,
];

/**
 * Wide capability allowlist for subagents that the user has authorized to act
 * with full developer power (the CLI fleet host applies this to any subagent
 * that isn't given an explicit, narrower grant). It covers everything needed to
 * do real work end-to-end — read, write/edit inside the project, outbound
 * network, all shell/build/install capabilities, session todos, tool metadata, and read-only
 * memory lookup — so a delegated coding or build agent runs the same toolchain
 * the leader would, without per-tool confirmation it cannot answer.
 *
 * Deliberately EXCLUDED (require an explicit per-spawn `allowedCapabilities`
 * grant, because they escape the task's blast radius rather than perform it):
 *   - `fs.write.outside-project` — writing outside the repo (e.g. ~/.ssh).
 *   - `tool.mutate.any` — arbitrary meta-tool dispatch.
 *   - `memory.write` / `memory.delete` — persistent memory mutation.
 *   - `mcp.proxy` — third-party MCP tools (also hard-blocked by name).
 *   - `subagent.spawn` — recursive delegation (the baseline prompt forbids it).
 *   - `config.mutate` — rewriting trust/config is privilege escalation, not work.
 */
export const WIDE_SUBAGENT_CAPABILITIES: readonly ToolCapability[] = [
  ToolCapabilities.FS_READ,
  ToolCapabilities.FS_WRITE,
  ToolCapabilities.NET_OUTBOUND,
  ToolCapabilities.SESSION_TODO,
  ToolCapabilities.SESSION_NOTE,
  ToolCapabilities.TOOL_META,
  ToolCapabilities.MEMORY_READ,
  ToolCapabilities.SHELL_ARBITRARY,
  ToolCapabilities.SHELL_RESTRICTED,
  ToolCapabilities.SHELL_EXEC,
  ToolCapabilities.PACKAGE_INSTALL,
  // Read-only fleet visibility (fleet_status) — peer awareness has no blast
  // radius and every fleet worker should coordinate around its peers.
  ToolCapabilities.COORDINATION_FLEET_READ,
  ToolCapabilities.COORDINATION_RESULT_SUBMIT,
];

/**
 * Clamp a requested capability grant to a ceiling.
 *
 * The per-spawn `allowedCapabilities` grant documented above is an escape hatch
 * for a TRUSTED caller — the user, or in-process code the user invoked. It was
 * also reachable from two untrusted sources, which could therefore hand a
 * subagent the capabilities the list above deliberately withholds:
 *
 *   1. `<projectRoot>/.wrongstack/agents/<role>/config.json`, a repo-committed
 *      file that `applyProjectAgentConfig` merged in. Note this sits beside
 *      `.wrongstack/config.json`, which IS strip-listed by in-project-policy —
 *      the denylist guarded one file while the dangerous one lay next to it.
 *   2. Model output, via the un-enum'd `allowedCapabilities` array on the
 *      kanban/director tool schemas.
 *
 * Untrusted input may NARROW a grant; it may never widen one. Returns the
 * intersection, preserving `ceiling` order for stable output.
 *
 * @returns the clamped list plus the capabilities that were dropped, so callers
 *   can surface the reduction instead of silently disagreeing with the config.
 */
export function clampSubagentCapabilities(
  requested: readonly string[],
  ceiling: readonly ToolCapability[] = WIDE_SUBAGENT_CAPABILITIES,
): { granted: string[]; dropped: string[] } {
  const ceilingSet = new Set<string>(ceiling);
  const requestedSet = new Set(requested);
  return {
    granted: ceiling.filter((capability) => requestedSet.has(capability)),
    dropped: [...requestedSet].filter((capability) => !ceilingSet.has(capability)),
  };
}

/**
 * Check if a tool (or its capabilities array) includes any dangerous capability
 * for subagent execution.
 */
export function hasDangerousCapabilityForSubagents(
  toolOrCaps: { capabilities?: readonly string[] | undefined } | readonly string[] | undefined,
): boolean {
  if (!toolOrCaps) return false;
  const input = toolOrCaps as never as { capabilities?: readonly string[] | undefined };
  const caps: readonly string[] = Array.isArray(toolOrCaps)
    ? toolOrCaps
    : (input.capabilities ?? []);
  return caps.some((c) => DANGEROUS_FOR_SUBAGENTS.includes(c as ToolCapability));
}

/**
 * Check if a tool declares a specific capability (or any of the provided ones).
 */
export function hasCapability(
  toolOrCaps: { capabilities?: readonly string[] | undefined } | readonly string[] | undefined,
  capability: ToolCapability | ToolCapability[],
): boolean {
  if (!toolOrCaps) return false;
  const input = toolOrCaps as never as { capabilities?: readonly string[] | undefined };
  const caps: readonly string[] = Array.isArray(toolOrCaps)
    ? toolOrCaps
    : (input.capabilities ?? []);
  const toCheck = Array.isArray(capability) ? capability : [capability];
  return toCheck.some((c) => caps.includes(c));
}

/**
 * Returns the intersection of a tool's capabilities with the dangerous set.
 * Useful for logging and audit trails.
 */
export function getDangerousCapabilities(
  toolOrCaps: { capabilities?: readonly string[] | undefined } | readonly string[] | undefined,
): ToolCapability[] {
  if (!toolOrCaps) return [];
  const input = toolOrCaps as never as { capabilities?: readonly string[] | undefined };
  const caps: readonly string[] = Array.isArray(toolOrCaps)
    ? toolOrCaps
    : (input.capabilities ?? []);
  return caps.filter((c): c is ToolCapability =>
    DANGEROUS_FOR_SUBAGENTS.includes(c as ToolCapability),
  );
}
