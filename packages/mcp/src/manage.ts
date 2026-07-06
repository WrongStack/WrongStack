/**
 * Shared, surface-agnostic MCP server management.
 *
 * One source of truth for add / update / remove / enable / disable / restart /
 * discover / list. Every surface delegates here so the REPL (`/mcp`), the TUI,
 * and BOTH WebUI servers behave identically and never drift:
 *
 *   - REPL / TUI : packages/cli/src/slash-commands/mcp-utils.ts (colored strings)
 *   - WebUI      : packages/webui/src/server/mcp-handlers.ts    (WS events)
 *
 * The functions are pure with respect to rendering — they mutate the config
 * file on disk and the live {@link MCPRegistry}, then return structured results.
 * Callers translate those results into whatever their surface needs.
 *
 * MCP records live in two places:
 *   - persistent : `~/.wrongstack/config.json` → `mcpServers`
 *   - live state : the in-process {@link MCPRegistry}
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { MCPServerConfig, Permission } from '@wrongstack/core';
import type { MCPRegistry } from './registry.js';

/** Transport values accepted from UI surfaces (UI also offers a bare "http"). */
type TransportInput = 'stdio' | 'sse' | 'streamable-http' | 'http';

/** Loosely-typed server input as it arrives from a UI or command surface. */
export interface McpServerInput {
  name: string;
  transport?: TransportInput | string | undefined;
  description?: string | undefined;
  enabled?: boolean | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  url?: string | undefined;
  headers?: Record<string, string> | undefined;
  allowedTools?: string[] | undefined;
  permission?: Permission | undefined;
  /** Lazy connect — spawn the process only on first tool call (see config). */
  lazy?: boolean | undefined;
}

/** Projected view of one server, merging disk config with live registry state. */
export interface McpServerInfo {
  name: string;
  transport: MCPServerConfig['transport'];
  description?: string | undefined;
  enabled: boolean;
  /** Raw registry state ('connected' | 'connecting' | … | 'failed'), or 'stopped' when not running. */
  status: string;
  /** Real tool names discovered from the live server (empty when not connected). */
  tools: string[];
  url?: string | undefined;
  command?: string | undefined;
  /** Lazy-connect opt-in (spawn on first tool call). */
  lazy?: boolean | undefined;
}

export interface McpOpResult {
  ok: boolean;
  message: string;
  /** The affected server's projected view, when applicable. */
  server?: McpServerInfo | undefined;
  /** Raw registry state after a start/restart attempt. */
  state?: string | undefined;
  /** Real tool names after a start/restart attempt. */
  tools?: string[] | undefined;
  /** Set when a config change persisted but the registry start/stop failed. */
  registryError?: string | undefined;
}

export interface McpManageDeps {
  /** Absolute path to the global config.json that owns `mcpServers`. */
  configPath: string;
  /** Live registry for runtime start/stop/restart. */
  registry: MCPRegistry;
  /** Built-in presets (from core `allServers()`), used by name-only `add`. */
  presets?: Record<string, MCPServerConfig> | undefined;
}

// ── config IO (atomic) ──────────────────────────────────────────────────────

async function readConfig(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeConfig(path: string, cfg: Record<string, unknown>): Promise<void> {
  const raw = JSON.stringify(cfg, null, 2);
  // Unique temp name (pid + random) so two concurrent writers (e.g. WebUI and
  // REPL editing MCP config at once) don't clobber a shared `${path}.tmp` and
  // corrupt the config. Clean up the temp file if the rename fails.
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, raw, 'utf8');
  try {
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

function isMcpServerRecord(value: unknown): value is Record<string, MCPServerConfig> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readServers(configPath: string): Promise<{
  full: Record<string, unknown>;
  servers: Record<string, MCPServerConfig>;
}> {
  const full = await readConfig(configPath);
  const servers = isMcpServerRecord(full.mcpServers) ? { ...full.mcpServers } : {};
  return { full, servers };
}

async function persist(
  configPath: string,
  full: Record<string, unknown>,
  servers: Record<string, MCPServerConfig>,
): Promise<void> {
  full.mcpServers = servers;
  await writeConfig(configPath, full);
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Normalise UI transport values; UI offers a bare "http" → streamable-http. */
function normalizeTransport(t: string | undefined): MCPServerConfig['transport'] {
  if (t === 'sse') return 'sse';
  if (t === 'http' || t === 'streamable-http') return 'streamable-http';
  return 'stdio';
}

/**
 * Build a clean MCPServerConfig from loose input, omitting undefined keys so
 * `exactOptionalPropertyTypes` stays satisfied and we never write `null`-ish
 * holes into config.json. `base` lets `update` merge onto an existing entry.
 */
function buildConfig(input: McpServerInput, base?: MCPServerConfig | undefined): MCPServerConfig {
  const cfg: MCPServerConfig = {
    name: input.name,
    transport: input.transport
      ? normalizeTransport(String(input.transport))
      : (base?.transport ?? 'stdio'),
  };
  const description = input.description ?? base?.description;
  if (description !== undefined) cfg.description = description;
  const command = input.command ?? base?.command;
  if (command !== undefined) cfg.command = command;
  const args = input.args ?? base?.args;
  if (args !== undefined) cfg.args = args;
  const env = input.env ?? base?.env;
  if (env !== undefined) cfg.env = env;
  const url = input.url ?? base?.url;
  if (url !== undefined) cfg.url = url;
  const headers = input.headers ?? base?.headers;
  if (headers !== undefined) cfg.headers = headers;
  const allowedTools = input.allowedTools ?? base?.allowedTools;
  if (allowedTools !== undefined) cfg.allowedTools = allowedTools;
  const permission = input.permission ?? base?.permission;
  if (permission !== undefined) cfg.permission = permission;
  const enabled = input.enabled ?? base?.enabled;
  if (enabled !== undefined) cfg.enabled = enabled;
  const lazy = input.lazy ?? base?.lazy;
  if (lazy !== undefined) cfg.lazy = lazy;
  return cfg;
}

/** Project a config entry + live registry state into a wire-friendly view. */
function projectServer(name: string, cfg: MCPServerConfig, registry: MCPRegistry): McpServerInfo {
  const live = registry.list().find((s) => s.name === name);
  const info: McpServerInfo = {
    name,
    transport: cfg.transport,
    enabled: cfg.enabled !== false,
    status: live ? live.state : 'stopped',
    tools: live?.tools ?? [],
  };
  if (cfg.description !== undefined) info.description = cfg.description;
  if (cfg.url !== undefined) info.url = cfg.url;
  if (cfg.command !== undefined) info.command = cfg.command;
  if (cfg.lazy !== undefined) info.lazy = cfg.lazy;
  return info;
}

function liveState(name: string, registry: MCPRegistry): { state: string; tools: string[] } {
  const live = registry.list().find((s) => s.name === name);
  return { state: live?.state ?? 'stopped', tools: live?.tools ?? [] };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── operations ────────────────────────────────────────────────────────────────

/** List all configured servers, merged with live registry status + tool names. */
export async function listMcp(deps: McpManageDeps): Promise<McpServerInfo[]> {
  const { servers } = await readServers(deps.configPath);
  return Object.entries(servers).map(([name, cfg]) =>
    projectServer(name, { ...cfg, name }, deps.registry),
  );
}

/**
 * Add a new server. `input` may be a fully-specified config, or just a `name`
 * matching a known preset (`deps.presets`). Fails if the server already exists.
 * When enabled, the server is started immediately via the registry.
 */
export async function addMcp(input: McpServerInput, deps: McpManageDeps): Promise<McpOpResult> {
  if (!input.name) return { ok: false, message: 'Server name is required' };

  const { full, servers } = await readServers(deps.configPath);
  if (servers[input.name]) {
    return { ok: false, message: `Server "${input.name}" already exists` };
  }

  // Name-only add resolves a preset; an explicit transport/command means the
  // caller supplied the full config and the preset (if any) is just a base.
  const preset = deps.presets?.[input.name];
  const hasExplicitConfig = !!(input.transport || input.command || input.url);
  const cfg = hasExplicitConfig
    ? buildConfig(input, preset)
    : preset
      ? buildConfig({ ...input, name: input.name }, preset)
      : buildConfig(input);

  if (!hasExplicitConfig && !preset) {
    const known = Object.keys(deps.presets ?? {}).join(', ');
    return {
      ok: false,
      message: known
        ? `Unknown server "${input.name}". Available presets: ${known}`
        : `No configuration provided for "${input.name}"`,
    };
  }

  cfg.enabled = input.enabled ?? false;
  servers[input.name] = cfg;
  await persist(deps.configPath, full, servers);

  if (cfg.enabled) {
    return startServer(input.name, cfg, deps, `Server "${input.name}" added`);
  }
  return {
    ok: true,
    message: `Server "${input.name}" added (disabled)`,
    server: projectServer(input.name, cfg, deps.registry),
  };
}

/** Update an existing server's config, then re-apply it to the live registry. */
export async function updateMcp(input: McpServerInput, deps: McpManageDeps): Promise<McpOpResult> {
  if (!input.name) return { ok: false, message: 'Server name is required' };

  const { full, servers } = await readServers(deps.configPath);
  const existing = servers[input.name];
  if (!existing) return { ok: false, message: `Server "${input.name}" not found` };

  const cfg = buildConfig(input, { ...existing, name: input.name });
  servers[input.name] = cfg;
  await persist(deps.configPath, full, servers);

  // Re-apply to the registry so edits take effect without a manual restart.
  if (cfg.enabled !== false) {
    return startServer(input.name, cfg, deps, `Server "${input.name}" updated`, { restart: true });
  }
  await safeStop(input.name, deps);
  return {
    ok: true,
    message: `Server "${input.name}" updated`,
    server: projectServer(input.name, cfg, deps.registry),
  };
}

/** Remove a server from config and stop it if running. */
export async function removeMcp(name: string, deps: McpManageDeps): Promise<McpOpResult> {
  if (!name) return { ok: false, message: 'Server name is required' };
  const { full, servers } = await readServers(deps.configPath);
  if (!servers[name]) return { ok: false, message: `Server "${name}" not found` };

  await safeStop(name, deps);
  delete servers[name];
  await persist(deps.configPath, full, servers);
  return { ok: true, message: `Server "${name}" removed` };
}

/** Enable a server in config and start it. */
export async function enableMcp(name: string, deps: McpManageDeps): Promise<McpOpResult> {
  if (!name) return { ok: false, message: 'Server name is required' };
  const { full, servers } = await readServers(deps.configPath);
  const cfg = servers[name];
  if (!cfg) {
    return { ok: false, message: `Server "${name}" is not in config. Add it first.` };
  }
  cfg.enabled = true;
  servers[name] = cfg;
  await persist(deps.configPath, full, servers);
  return startServer(name, cfg, deps, `Server "${name}" enabled`, { restart: true });
}

/** Disable a server in config and stop it. */
export async function disableMcp(name: string, deps: McpManageDeps): Promise<McpOpResult> {
  if (!name) return { ok: false, message: 'Server name is required' };
  const { full, servers } = await readServers(deps.configPath);
  const cfg = servers[name];
  if (!cfg) return { ok: false, message: `Server "${name}" is not in config.` };

  await safeStop(name, deps);
  cfg.enabled = false;
  servers[name] = cfg;
  await persist(deps.configPath, full, servers);
  return {
    ok: true,
    message: `Server "${name}" disabled`,
    server: projectServer(name, cfg, deps.registry),
  };
}

/** Restart a running server (or start it from config if registered but stopped). */
export async function restartMcp(name: string, deps: McpManageDeps): Promise<McpOpResult> {
  if (!name) return { ok: false, message: 'Server name is required' };
  const registered = deps.registry.list().some((s) => s.name === name);
  if (registered) {
    try {
      await deps.registry.restart(name);
      const { state, tools } = liveState(name, deps.registry);
      return { ok: true, message: `Server "${name}" restarted`, state, tools };
    } catch (err) {
      return { ok: false, message: `Failed to restart "${name}": ${errMessage(err)}` };
    }
  }
  // Not in the registry yet — start it from config if it exists and is enabled.
  const { servers } = await readServers(deps.configPath);
  const cfg = servers[name];
  if (!cfg) return { ok: false, message: `Server "${name}" is not in config.` };
  return startServer(name, { ...cfg, name }, deps, `Server "${name}" started`, { restart: true });
}

/**
 * Discover a server's tools. Tools are discovered on connect, so this ensures
 * the server is running and returns its live tool list.
 */
export async function discoverMcp(name: string, deps: McpManageDeps): Promise<McpOpResult> {
  if (!name) return { ok: false, message: 'Server name is required' };
  const result = await restartMcp(name, deps);
  if (!result.ok) return result;
  const { state, tools } = liveState(name, deps.registry);
  return {
    ok: true,
    message: `Discovered ${tools.length} tool${tools.length === 1 ? '' : 's'} from "${name}"`,
    state,
    tools,
  };
}

// ── registry helpers ──────────────────────────────────────────────────────────

/**
 * Start (or restart) a server in the registry. Config has already been
 * persisted by the caller; a registry failure is reported but not fatal — the
 * config change stands so the user can retry/restart.
 */
async function startServer(
  name: string,
  cfg: MCPServerConfig,
  deps: McpManageDeps,
  okMessage: string,
  opts?: { restart?: boolean },
): Promise<McpOpResult> {
  try {
    const alreadyRegistered = deps.registry.list().some((s) => s.name === name);
    if (alreadyRegistered && opts?.restart) {
      await deps.registry.restart(name);
    } else if (alreadyRegistered) {
      await deps.registry.restart(name);
    } else {
      await deps.registry.start({ ...cfg, enabled: true });
    }
    const { state, tools } = liveState(name, deps.registry);
    return {
      ok: true,
      message: okMessage,
      server: projectServer(name, cfg, deps.registry),
      state,
      tools,
    };
  } catch (err) {
    const message = errMessage(err);
    return {
      ok: true, // config persisted — surface a soft warning, not a hard failure
      message: `${okMessage} in config, but failed to start: ${message}`,
      server: projectServer(name, cfg, deps.registry),
      registryError: message,
    };
  }
}

/** Stop a server, swallowing "not running" errors. */
async function safeStop(name: string, deps: McpManageDeps): Promise<void> {
  try {
    await deps.registry.stop(name);
  } catch {
    // Server may not be running — ignore.
  }
}
