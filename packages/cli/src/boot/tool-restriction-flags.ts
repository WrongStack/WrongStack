/**
 * `--only-tools <names>` and `--disallowed-tools <names>`: a launch-time tool
 * restriction applied to the tool registry (see `ToolRegistry.setSessionRestriction`).
 *
 * `--only-tools` rather than Claude Code's `--tools`: `--tools` is already a
 * boolean of `wstack models add` and the CSV of `wstack mcp serve`, so a value
 * form here would swallow the prompt in `wstack --tools read "task"`.
 *
 * Names are comma- or space-separated; a trailing `*` matches a prefix
 * (`mcp__github__*`). Claude Code's scoped rules (`Bash(git *)`) are refused
 * instead of ignored: dropping a deny rule silently would leave the operator
 * believing a command is blocked when it is not.
 */

export interface ToolRestriction {
  only?: string[] | undefined;
  deny: string[];
  /** Set by `--restricted` only (see restricted-mode.ts). */
  denyCapabilities?: readonly string[] | undefined;
  requireDeclaredCapabilities?: boolean | undefined;
}

function parseToolList(flag: string, value: string | boolean | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`--${flag} needs a comma-separated list of tool names`);
  }
  const names = value
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error(`--${flag} needs a comma-separated list of tool names`);
  }
  const scoped = names.find((name) => name.includes('('));
  if (scoped) {
    throw new Error(
      `--${flag}: scoped rules like "${scoped}" are not supported; list whole tool names (exec policy lives in config tools.exec)`,
    );
  }
  return names;
}

/**
 * `--allowed-tools <names>`: pre-approve tools (no permission prompt) for this
 * process. Same list syntax and the same refusal of scoped rules — a scoped
 * allow like `Bash(git *)` widened to all of `bash` would approve far more
 * than the operator asked for.
 */
export function resolveLaunchAllowedTools(
  flags: Readonly<Record<string, string | boolean>>,
): string[] | undefined {
  return parseToolList('allowed-tools', flags['allowed-tools']);
}

/** `undefined` when neither flag is set. Throws on an unusable value. */
export function resolveToolRestriction(
  flags: Readonly<Record<string, string | boolean>>,
): ToolRestriction | undefined {
  const only = parseToolList('only-tools', flags['only-tools']);
  const deny = parseToolList('disallowed-tools', flags['disallowed-tools']);
  if (only === undefined && deny === undefined) return undefined;
  return { ...(only ? { only } : {}), deny: deny ?? [] };
}

/**
 * Names in the restriction that match no registered tool — most likely typos.
 * Globs and MCP-style names (`server__tool`) are skipped: MCP servers
 * register after boot, so their absence here proves nothing.
 */
export function unknownRestrictedToolNames(
  restriction: ToolRestriction,
  isRegistered: (name: string) => boolean,
): string[] {
  return [...(restriction.only ?? []), ...restriction.deny].filter(
    (name) => !name.endsWith('*') && !name.includes('__') && !isRegistered(name),
  );
}
