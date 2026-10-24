/**
 * Shared MCP management service.
 * Contains the argument parser and the actual management logic shared between
 * the CLI subcommand handler (packages/cli/src/subcommands/handlers/mcp.ts)
 * and the slash-command wiring in index.ts.
 */

import type { Config, MCPServerConfig } from '@wrongstack/contracts/types';
import { resolveMcpServerConfig } from '@wrongstack/core/infrastructure';
import {
  color,
  expectDefined,
  readJsonObjectFile,
  removeJsonPath,
  setJsonPath,
  updateJsonObjectFile,
} from '@wrongstack/core/utils';
import type { MCPRegistry, MCPToolAnnotations } from '@wrongstack/mcp';
export interface McpParsedArgs {
  action: 'list' | 'add' | 'remove' | 'enable' | 'disable' | 'restart';
  name: string;
  enable?: boolean | undefined;
}

/** Parse "/mcp add github --enable" style args. Returns null on unknown/missing subcommand. */
export function parseMcpArgs(args: string): McpParsedArgs | null {
  const trimmed = args.trim();
  if (!trimmed || trimmed === 'list') return { action: 'list', name: '' };

  const parts = trimmed.split(/\s+/);
  const action = expectDefined(parts[0]);
  const name = parts[1] ?? '';
  const enable = parts.includes('--enable') || parts.includes('-e');

  switch (action) {
    case 'add':
      return name ? { action: 'add', name, enable } : null;
    case 'remove':
      return name ? { action: 'remove', name } : null;
    case 'enable':
      return name ? { action: 'enable', name } : null;
    case 'disable':
      return name ? { action: 'disable', name } : null;
    case 'restart':
      return name ? { action: 'restart', name } : null;
    default:
      return null;
  }
}

interface McpManagementDeps {
  config: Config;
  configPath: string;
  mcpRegistry: MCPRegistry;
  allServerPresets: Record<string, MCPServerConfig>;
}

export async function runMcpManagementCommand(
  parsed: McpParsedArgs,
  deps: McpManagementDeps,
): Promise<string> {
  const { config, configPath, mcpRegistry, allServerPresets } = deps;
  const diskConfig = await readJsonObjectFile(configPath);
  const configured = isMcpServerRecord(diskConfig.mcpServers)
    ? diskConfig.mcpServers
    : (config.mcpServers ?? {});

  switch (parsed.action) {
    case 'list':
      return renderList(configured, mcpRegistry, allServerPresets);

    case 'add':
      return runAdd(
        parsed.name,
        parsed.enable ?? false,
        configured,
        configPath,
        mcpRegistry,
        allServerPresets,
      );

    case 'remove':
      return runRemove(parsed.name, configured, configPath, mcpRegistry);

    case 'enable':
      return runEnable(parsed.name, configured, configPath, mcpRegistry);

    case 'disable':
      return runDisable(parsed.name, configured, configPath, mcpRegistry);

    case 'restart':
      return runRestart(parsed.name, mcpRegistry);
  }
}

function renderList(
  configured: Record<string, MCPServerConfig>,
  mcpRegistry: MCPRegistry,
  all: Record<string, MCPServerConfig>,
): string {
  const lines: string[] = [];
  const liveStatus = mcpRegistry.list();
  const liveMap = new Map(liveStatus.map((s) => [s.name, s]));
  const healthMap = new Map(
    (typeof mcpRegistry.operationalHealth === 'function'
      ? mcpRegistry.operationalHealth()
      : []
    ).map((health) => [health.name, health]),
  );
  const configuredNames = new Set(Object.keys(configured));

  let hintBadgesShown = false;
  if (configuredNames.size > 0) {
    lines.push(color.bold('Configured servers:'));
    for (const [name, cfg] of Object.entries(configured)) {
      const live = liveMap.get(name);
      const health = healthMap.get(name);
      const toolCount = live ? color.dim(` (${live.toolCount} tools)`) : '';
      const enabled =
        cfg.enabled === false ? `${color.dim('disabled')}  ` : `${color.green('● enabled')}  `;
      const stateStr = live ? stateBadge(live.state) : color.dim('○ not running');
      const operations = health
        ? color.dim(
            ` [${health.healthState}; failures ${health.failures.transport}/${health.failures.protocol}/${health.failures.tool}; call p95 ${health.callLatency.p95Ms ?? '-'}ms]`,
          )
        : '';
      // Plan 28: mcpServers.*.sandboxTrust bypasses the enforced sandbox tier
      // for this server — always visible in listings (security-relevant state).
      const trustBadge = cfg.sandboxTrust === true ? `${color.yellow('[sandbox-trusted]')}  ` : '';
      lines.push(
        `  ${color.bold(name)}  ${enabled}${stateStr}${toolCount}${trustBadge}${operations}`,
      );
      if (cfg.description) lines.push(`    ${color.dim(cfg.description)}`);
      // Tool inventory with server-claimed annotation badges. `describeTools`
      // is a cache read (never wakes the server) and returns undefined for a
      // server that is not connected — render no tool lines then.
      const tools =
        live && typeof mcpRegistry.describeTools === 'function'
          ? mcpRegistry.describeTools(name)
          : undefined;
      for (const tool of tools ?? []) {
        const badges = toolHintBadges(tool.annotations);
        if (badges.length > 0) hintBadgesShown = true;
        lines.push(
          `    ${tool.name}${badges.length > 0 ? ` ${color.dim(badges.map((b) => `[${b}]`).join(' '))}` : ''}`,
        );
      }
    }
    if (hintBadgesShown) {
      lines.push(
        color.dim('    Tool hints are claimed by the server, not enforced by WrongStack.'),
      );
    }
    lines.push('');
  }

  const unconfigured = Object.entries(all).filter(([n]) => !configuredNames.has(n));
  lines.push(color.bold('Available presets (run `/mcp add <name> --enable` to enable):'));
  if (unconfigured.length === 0) {
    lines.push(`  ${color.dim('All presets are already configured.')}`);
  } else {
    for (const [name, cfg] of unconfigured) {
      const warn = cfg.permission === 'deny' ? color.red(' ⚠') : '';
      lines.push(`  ${color.bold(name)}  ${cfg.description ?? cfg.transport}${warn}`);
    }
  }
  lines.push('');
  lines.push(color.dim('  /mcp add <name> [--enable]   /mcp remove <name>'));
  lines.push(color.dim('  /mcp enable <name>            /mcp disable <name>'));
  lines.push(color.dim('  /mcp restart <name>           (runtime restart)'));

  return lines.join('\n');
}

async function runAdd(
  name: string,
  enable: boolean,
  configured: Record<string, MCPServerConfig>,
  configPath: string,
  mcpRegistry: MCPRegistry,
  all: Record<string, MCPServerConfig>,
): Promise<string> {
  const preset = all[name];
  if (!preset) {
    const known = Object.keys(all).join(', ');
    return `Unknown server "${name}". Available: ${known}`;
  }

  const existing = configured[name];
  const nextCfg = existing
    ? { ...preset, ...existing, enabled: enable }
    : { ...preset, enabled: enable };

  await updateJsonObjectFile(configPath, (full) => {
    const current = isMcpServerRecord(full.mcpServers) ? full.mcpServers : {};
    setJsonPath(full, ['mcpServers', name], { ...current[name], ...nextCfg });
  });

  if (!enable) {
    if (typeof mcpRegistry.markDisabled === 'function') mcpRegistry.markDisabled(nextCfg);
    const verb = existing ? 'Updated' : 'Added (disabled — /mcp enable to start)';
    return `${color.green(verb)} "${name}" (${nextCfg.transport}). Config written to ${configPath}.`;
  }

  try {
    if (mcpRegistry.list().some((server) => server.name === name)) {
      // Pass the merged config — a bare restart keeps the slot's old one.
      await mcpRegistry.restart(name, { ...nextCfg, name });
    } else {
      await mcpRegistry.start(nextCfg);
    }
    const verb = existing ? 'Updated and started' : 'Enabled and started';
    return `${color.green(verb)} "${name}" (${nextCfg.transport}). Config written to ${configPath}.`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `${color.yellow('Enabled')} "${name}" in config, but failed to start: ${message}`;
  }
}

async function runRemove(
  name: string,
  configured: Record<string, MCPServerConfig>,
  configPath: string,
  mcpRegistry: MCPRegistry,
): Promise<string> {
  if (!configured[name]) return `Server "${name}" is not in config.`;
  try {
    await mcpRegistry.stop(name);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'mcp.stop_failed_on_remove',
        server: name,
        message: err instanceof Error ? err.message : String(err),
        note: 'config entry removed but server may still be running',
        timestamp: new Date().toISOString(),
      }),
    );
  }
  if (typeof mcpRegistry.forget === 'function') mcpRegistry.forget(name);
  await updateJsonObjectFile(configPath, (full) => {
    const current = isMcpServerRecord(full.mcpServers) ? full.mcpServers : configured;
    setJsonPath(full, ['mcpServers'], { ...current });
    removeJsonPath(full, ['mcpServers', name]);
  });
  return `${color.yellow('Removed')} "${name}" from config.`;
}

async function runEnable(
  name: string,
  configured: Record<string, MCPServerConfig>,
  configPath: string,
  mcpRegistry: MCPRegistry,
): Promise<string> {
  const cfg = configured[name];
  if (!cfg) return `Server "${name}" is not in config. Run \`/mcp add ${name} --enable\` first.`;
  const resolved = resolveMcpServerConfig(name, cfg);
  if (!resolved) return `Server "${name}" has no transport and matches no preset.`;
  const startCfg = { ...resolved, enabled: true };
  const registered = mcpRegistry.list().some((server) => server.name === name);
  if (cfg.enabled !== false) {
    // Already enabled — just ensure it's running (with the config on disk).
    if (registered) await mcpRegistry.restart(name, startCfg);
    else await mcpRegistry.start(startCfg);
    return `${color.green('●')} "${name}" is already enabled and running.`;
  }
  await updateJsonObjectFile(configPath, (full) => {
    const current = isMcpServerRecord(full.mcpServers) ? full.mcpServers : {};
    setJsonPath(full, ['mcpServers', name], { ...cfg, ...current[name], enabled: true });
  });
  if (registered) await mcpRegistry.restart(name, startCfg);
  else await mcpRegistry.start(startCfg);
  return `${color.green('Enabled')} "${name}" and started.`;
}

async function runDisable(
  name: string,
  configured: Record<string, MCPServerConfig>,
  configPath: string,
  mcpRegistry: MCPRegistry,
): Promise<string> {
  const cfg = configured[name];
  if (!cfg) return `Server "${name}" is not in config.`;
  try {
    await mcpRegistry.stop(name);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'mcp.stop_failed_on_disable',
        server: name,
        message: err instanceof Error ? err.message : String(err),
        note: 'config marked disabled but server may still be running',
        timestamp: new Date().toISOString(),
      }),
    );
  }
  await updateJsonObjectFile(configPath, (full) => {
    const current = isMcpServerRecord(full.mcpServers) ? full.mcpServers : {};
    setJsonPath(full, ['mcpServers', name], { ...cfg, ...current[name], enabled: false });
  });
  if (typeof mcpRegistry.markDisabled === 'function') {
    mcpRegistry.markDisabled({ ...cfg, name, enabled: false });
  }
  return `${color.yellow('Disabled')} "${name}" and stopped.`;
}

async function runRestart(name: string, mcpRegistry: MCPRegistry): Promise<string> {
  const live = mcpRegistry.list();
  if (!live.find((s) => s.name === name)) {
    return `Server "${name}" is not currently running. Add it with \`/mcp add ${name} --enable\`.`;
  }
  try {
    await mcpRegistry.restart(name);
    return `${color.green('✓')} Restarted "${name}".`;
  } catch (err) {
    return `${color.red('✗')} Failed to restart "${name}": ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Plain-text badges for a server-claimed `MCPToolAnnotations` block. An absent
 * hint renders no badge: the spec defaults (readOnly=false, destructive=true,
 * openWorld=true) are not claims the server actually made, and the whole block
 * is the server's untrusted self-report — annotations never gate execution.
 */
function toolHintBadges(annotations: MCPToolAnnotations | undefined): string[] {
  if (!annotations) return [];
  const badges: string[] = [];
  if (annotations.readOnlyHint === true) badges.push('read-only');
  if (annotations.readOnlyHint === false && annotations.destructiveHint === true) {
    badges.push('destructive');
  }
  if (annotations.openWorldHint === true) badges.push('open-world');
  return badges;
}

function stateBadge(state: string): string {
  switch (state) {
    case 'connected':
      return color.green('● connected');
    case 'connecting':
      return color.cyan('◐ connecting');
    case 'reconnecting':
      return color.cyan('◑ reconnecting');
    case 'disconnected':
      return color.dim('○ disconnected');
    case 'failed':
      return color.red('✗ failed');
    case 'dormant':
      return color.dim('◌ dormant (spawns on first call)');
    default:
      return color.dim(state);
  }
}

function isMcpServerRecord(value: unknown): value is Record<string, MCPServerConfig> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
