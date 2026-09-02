/**
 * MCP management handlers for the WebUI server (both the standalone
 * standalone server and the CLI's embedded `--webui` server).
 *
 * These are thin WebSocket translators over the shared, surface-agnostic
 * management core in `@wrongstack/mcp` (`manage.ts`) — the SAME core the REPL
 * `/mcp` command writes against (same config.json, same MCPRegistry). All the
 * config IO, url/header persistence, and live registry start/stop logic lives
 * there; here we only map structured results to WS events the browser expects.
 */

import { allServers } from '@wrongstack/core/infrastructure';
import { DefaultSecretScrubber, isSecretField } from '@wrongstack/core/security';
import {
  addMcp,
  disableMcp,
  discoverMcp,
  enableMcp,
  listMcp,
  MCP_ENV_MASK,
  type MCPRegistry,
  type MCPServerOperationalHealth,
  type McpManageDeps,
  type McpServerInfo,
  type McpServerInput,
  removeMcp,
  restartMcp,
  updateMcp,
} from '@wrongstack/mcp';
import type { TrustBoundary } from '@wrongstack/core/security';
import type { WebSocket } from 'ws';
import { authorizeWebUIAction } from './privileged-actions.js';
import type { WSClientMessage } from './types.js';
import { validateMcpServerPayload } from './ws-payload-validation.js';
import { send } from './ws-utils.js';

/**
 * Run an MCP mutation that ends in a process spawn past the trust boundary.
 *
 * Security scan 2026-08-04, finding M1. `mcp.add`/`mcp.update` accept an
 * arbitrary `command` + `args` from the wire, persist them to the profile
 * config, and start the server — the only WS-reachable spawn path that never
 * consulted the boundary its siblings (`terminal.create`, `process.kill`,
 * `host.shutdown`, codebase-index control) all go through.
 *
 * Risk is `'elevated'`, not `'critical'`, for the reason spelled out at the
 * `host.shutdown` call site: the default compatibility policy denies
 * `'critical'` outright for `remote-client` actors, which would break MCP
 * management in the WebUI for everyone. **Be clear about what this buys.**
 * Under the default policy it does not block anything — it produces an audit
 * record for every spawn-capable config mutation and gives a deployment that
 * installs a stricter boundary a place to say no. That is defense in depth,
 * not a gate.
 */
async function authorizeMcpMutation(
  ws: WebSocket,
  operation: 'mcp.add' | 'mcp.update' | 'mcp.enable' | 'mcp.disable' | 'mcp.wake' | 'mcp.restart',
  serverName: string,
  trustBoundary: TrustBoundary | undefined,
): Promise<boolean> {
  if (!trustBoundary) return true;
  const authorization = await authorizeWebUIAction(trustBoundary, {
    capability: 'mcp.server.configure',
    subject: { kind: 'process', id: serverName },
    risk: 'elevated',
    metadata: { transport: 'websocket', operation },
  });
  if (!authorization.allowed) {
    send(ws, {
      type: 'mcp.operation_result',
      payload: { success: false, message: `${operation} denied: ${authorization.reason}` },
    });
  }
  return authorization.allowed;
}

/** Wire view of a server as the browser MCP panel consumes it. */
interface MCPServerView {
  name: string;
  transport: string;
  status: 'stopped' | 'connecting' | 'connected' | 'sleeping' | 'discovering' | 'error';
  enabled: boolean;
  description?: string;
  tools?: string[];
  error?: string;
  pid?: number;
  lazy?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  health?: MCPServerOperationalHealth;
}

/** Map a raw registry state to the UI status union. */
function mapStatus(raw: string): MCPServerView['status'] {
  switch (raw) {
    case 'connected':
      return 'connected';
    case 'connecting':
    case 'reconnecting':
      return 'connecting';
    case 'failed':
      return 'error';
    case 'dormant':
      // Lazy server registered from cache, process not spawned — show as sleeping.
      return 'sleeping';
    default:
      // idle / disconnected / stopped
      return 'stopped';
  }
}

const envScrubber = new DefaultSecretScrubber();

/**
 * Replace secret-bearing MCP env values with {@link MCP_ENV_MASK}.
 *
 * WS-036: `mcp.list` echoed this map verbatim to the browser, and MCP server
 * env is exactly where server credentials live — `GITHUB_TOKEN`, `*_API_KEY`,
 * and so on. Two independent signals decide, because either alone misses real
 * cases:
 *
 *   - the KEY looks secret (`isSecretField`, the project's own answer), which
 *     catches `FOO_TOKEN=<anything>`;
 *   - the VALUE looks like a credential to the scrubber, which catches a
 *     secret hiding behind an innocuous name like `GH_PAT=ghp_…`.
 *
 * Non-secret env (`NODE_ENV`, a path) still shows through, so editing a server
 * in the UI stays workable. Sending the mask back means "leave that value
 * alone" — `buildConfig` restores it from the stored config.
 */
function maskServerEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    // A hand-edited config.json can hold a truthy non-string env value
    // (`"PORT": 8080`); `scrub()` calls `text.includes(...)` and would throw a
    // TypeError, breaking `mcp.list` for that whole config. Only strings can be
    // credentials, so guard the value signal — a secret-named KEY still masks a
    // non-string value through the first signal.
    const secret =
      isSecretField(key) || (typeof value === 'string' && envScrubber.scrub(value) !== value);
    out[key] = secret ? MCP_ENV_MASK : value;
  }
  return out;
}

/** Project the shared {@link McpServerInfo} into the browser wire shape. */
export function toView(
  info: McpServerInfo,
  health?: MCPServerOperationalHealth | undefined,
): MCPServerView {
  const view: MCPServerView = {
    name: info.name,
    transport: info.transport,
    // A dormant lazy server is "asleep", not stopped — preserve that even when
    // it's enabled in config.
    status:
      info.status === 'dormant'
        ? 'sleeping'
        : info.enabled === false
          ? 'stopped'
          : mapStatus(info.status),
    enabled: info.enabled,
    tools: info.tools,
  };
  if (info.description !== undefined) view.description = info.description;
  if (info.lazy !== undefined) view.lazy = info.lazy;
  if (info.command !== undefined) view.command = info.command;
  if (info.args !== undefined) view.args = info.args;
  if (info.env !== undefined) view.env = maskServerEnv(info.env);
  if (info.url !== undefined) view.url = info.url;
  if (health !== undefined) view.health = health;
  return view;
}

/**
 * Build the shared management deps. Returns null (and sends a failure result)
 * when the live registry isn't wired — both WebUI servers now pass one, so this
 * is a defensive guard rather than the normal path.
 */
function deps(
  ws: WebSocket,
  globalConfigPath: string | undefined,
  registry: MCPRegistry | undefined,
): McpManageDeps | null {
  if (!registry || !globalConfigPath) {
    send(ws, {
      type: 'mcp.operation_result',
      payload: { success: false, message: 'MCP registry is not available in this session.' },
    });
    return null;
  }
  return { configPath: globalConfigPath, registry, presets: allServers() };
}

function name(msg: WSClientMessage): string {
  return (msg.payload as { name?: string } | undefined)?.name ?? '';
}

/** mcp.list — configured servers merged with live registry status + tools. */
export async function handleMcpList(
  ws: WebSocket,
  _msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
): Promise<void> {
  if (!mcpRegistry || !globalConfigPath) {
    send(ws, { type: 'mcp.list', payload: { servers: [] } });
    return;
  }
  const servers = await listMcp({
    configPath: globalConfigPath,
    registry: mcpRegistry,
    presets: allServers(),
  });
  const health = new Map(
    (typeof mcpRegistry.operationalHealth === 'function'
      ? mcpRegistry.operationalHealth()
      : []
    ).map((item) => [item.name, item]),
  );
  send(ws, {
    type: 'mcp.list',
    payload: { servers: servers.map((server) => toView(server, health.get(server.name))) },
  });
}

/** mcp.add — persist a new server (incl. url/headers) and start it if enabled. */
export async function handleMcpAdd(
  ws: WebSocket,
  msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
  trustBoundary?: TrustBoundary,
): Promise<void> {
  const d = deps(ws, globalConfigPath, mcpRegistry);
  if (!d) return;
  const validated = validateMcpServerPayload(msg.payload, 'mcp.add');
  if (!validated.ok) {
    send(ws, {
      type: 'mcp.operation_result',
      payload: { success: false, message: validated.message },
    });
    return;
  }
  if (!(await authorizeMcpMutation(ws, 'mcp.add', name(msg), trustBoundary))) return;
  const result = await addMcp(validated.value as unknown as McpServerInput, d);
  if (result.ok && result.server) {
    send(ws, { type: 'mcp.server.added', payload: { server: toView(result.server) } });
    if (result.registryError) {
      send(ws, {
        type: 'mcp.server.error',
        payload: { name: result.server.name, error: result.registryError },
      });
    } else if (result.server.enabled) {
      send(ws, { type: 'mcp.server.connected', payload: { name: result.server.name } });
    }
  }
  send(ws, {
    type: 'mcp.operation_result',
    payload: { success: result.ok, message: result.message },
  });
}

/** mcp.update — re-persist config (incl. url/headers) and re-apply to registry. */
export async function handleMcpUpdate(
  ws: WebSocket,
  msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
  trustBoundary?: TrustBoundary,
): Promise<void> {
  const d = deps(ws, globalConfigPath, mcpRegistry);
  if (!d) return;
  const validated = validateMcpServerPayload(msg.payload, 'mcp.update');
  if (!validated.ok) {
    send(ws, {
      type: 'mcp.operation_result',
      payload: { success: false, message: validated.message },
    });
    return;
  }
  if (!(await authorizeMcpMutation(ws, 'mcp.update', name(msg), trustBoundary))) return;
  const result = await updateMcp(validated.value as unknown as McpServerInput, d);
  if (result.ok && result.server) {
    send(ws, { type: 'mcp.server.updated', payload: { server: toView(result.server) } });
  }
  send(ws, {
    type: 'mcp.operation_result',
    payload: { success: result.ok, message: result.message },
  });
}

/** mcp.remove — stop the server and delete it from config. */
export async function handleMcpRemove(
  ws: WebSocket,
  msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
): Promise<void> {
  const d = deps(ws, globalConfigPath, mcpRegistry);
  if (!d) return;
  const result = await removeMcp(name(msg), d);
  if (result.ok) {
    send(ws, { type: 'mcp.server.removed', payload: { name: name(msg) } });
  }
  send(ws, {
    type: 'mcp.operation_result',
    payload: { success: result.ok, message: result.message },
  });
}

/** mcp.enable — flip enabled:true in config and start the server. */
export async function handleMcpEnable(
  ws: WebSocket,
  msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
  trustBoundary?: TrustBoundary,
): Promise<void> {
  const d = deps(ws, globalConfigPath, mcpRegistry);
  if (!d) return;
  // H-2 (security report VF-04): enable is spawn-capable — it starts the
  // configured server process — and unlike add/update it never crossed the
  // trust boundary. Same authorization as the spawn-capable pair.
  if (!(await authorizeMcpMutation(ws, 'mcp.enable', name(msg), trustBoundary))) return;
  const result = await enableMcp(name(msg), d);
  if (result.ok && result.server) {
    send(ws, { type: 'mcp.server.updated', payload: { server: toView(result.server) } });
    if (result.registryError) {
      send(ws, {
        type: 'mcp.server.error',
        payload: { name: name(msg), error: result.registryError },
      });
    } else {
      send(ws, { type: 'mcp.server.connected', payload: { name: name(msg) } });
    }
  }
  send(ws, {
    type: 'mcp.operation_result',
    payload: { success: result.ok, message: result.message },
  });
}

/** mcp.disable — stop the server and flip enabled:false in config. */
export async function handleMcpDisable(
  ws: WebSocket,
  msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
  trustBoundary?: TrustBoundary,
): Promise<void> {
  const d = deps(ws, globalConfigPath, mcpRegistry);
  if (!d) return;
  // H-2: disable mutates persisted config from a bare name frame; route it
  // through the same authorizer as its siblings (audit record under the
  // default policy, enforceable where a stricter boundary is installed).
  if (!(await authorizeMcpMutation(ws, 'mcp.disable', name(msg), trustBoundary))) return;
  const result = await disableMcp(name(msg), d);
  if (result.ok) {
    send(ws, { type: 'mcp.server.sleeping', payload: { name: name(msg) } });
    if (result.server) {
      send(ws, { type: 'mcp.server.updated', payload: { server: toView(result.server) } });
    }
  }
  send(ws, {
    type: 'mcp.operation_result',
    payload: { success: result.ok, message: result.message },
  });
}

/** mcp.sleep — stop a running server (config stays enabled). */
export async function handleMcpSleep(
  ws: WebSocket,
  msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
): Promise<void> {
  const d = deps(ws, globalConfigPath, mcpRegistry);
  if (!d) return;
  // Sleep == disable the live process but keep config enabled — use the
  // registry directly so the persisted `enabled` flag is untouched.
  try {
    await d.registry.stop(name(msg));
    send(ws, { type: 'mcp.server.sleeping', payload: { name: name(msg) } });
    send(ws, {
      type: 'mcp.operation_result',
      payload: { success: true, message: `Server "${name(msg)}" stopped` },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    send(ws, { type: 'mcp.server.error', payload: { name: name(msg), error } });
    send(ws, {
      type: 'mcp.operation_result',
      payload: { success: false, message: `Failed to stop "${name(msg)}": ${error}` },
    });
  }
}

/** mcp.wake — restart a sleeping/stopped server from config. */
export async function handleMcpWake(
  ws: WebSocket,
  msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
  trustBoundary?: TrustBoundary,
): Promise<void> {
  const d = deps(ws, globalConfigPath, mcpRegistry);
  if (!d) return;
  // Chimera review follow-up to H-2: wake reaches restartMcp() → startServer()
  // → registry.start(), i.e. it spawns the configured server process, exactly
  // like enable — a strict boundary that denies mcp.enable must not be
  // bypassable through mcp.wake.
  if (!(await authorizeMcpMutation(ws, 'mcp.wake', name(msg), trustBoundary))) return;
  send(ws, { type: 'mcp.server.waking', payload: { name: name(msg) } });
  const result = await restartMcp(name(msg), d);
  if (result.ok && !result.registryError) {
    send(ws, { type: 'mcp.server.connected', payload: { name: name(msg) } });
  } else if (result.registryError) {
    send(ws, {
      type: 'mcp.server.error',
      payload: { name: name(msg), error: result.registryError },
    });
  }
  send(ws, {
    type: 'mcp.operation_result',
    payload: { success: result.ok, message: result.message },
  });
}

/** mcp.restart — stop + start a server. */
export async function handleMcpRestart(
  ws: WebSocket,
  msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
  trustBoundary?: TrustBoundary,
): Promise<void> {
  const d = deps(ws, globalConfigPath, mcpRegistry);
  if (!d) return;
  // Same spawn-capable class as wake/enable — see handleMcpWake.
  if (!(await authorizeMcpMutation(ws, 'mcp.restart', name(msg), trustBoundary))) return;
  const result = await restartMcp(name(msg), d);
  if (result.ok && !result.registryError) {
    send(ws, { type: 'mcp.server.connected', payload: { name: name(msg) } });
  } else if (result.registryError) {
    send(ws, {
      type: 'mcp.server.error',
      payload: { name: name(msg), error: result.registryError },
    });
  }
  send(ws, {
    type: 'mcp.operation_result',
    payload: { success: result.ok, message: result.message },
  });
}

/** mcp.discover — ensure the server is running and report its live tools. */
export async function handleMcpDiscover(
  ws: WebSocket,
  msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
): Promise<void> {
  const d = deps(ws, globalConfigPath, mcpRegistry);
  if (!d) return;
  const result = await discoverMcp(name(msg), d);
  if (result.ok) {
    send(ws, {
      type: 'mcp.server.discovered',
      payload: { name: name(msg), tools: result.tools ?? [] },
    });
  }
  send(ws, {
    type: 'mcp.operation_result',
    payload: { success: result.ok, message: result.message },
  });
}

/** mcp.resources — list cached resources/templates, refreshing only when explicitly requested. */
export async function handleMcpResources(
  ws: WebSocket,
  msg: WSClientMessage,
  _globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
): Promise<void> {
  if (!mcpRegistry) return sendContentError(ws, 'resources', '', 'MCP registry is not available.');
  const payload = payloadRecord(msg);
  let serverName = '';
  try {
    serverName = requiredPayloadString(payload, 'name');
    const refresh = payload['refresh'] === true;
    const [resources, resourceTemplates] = await Promise.all([
      mcpRegistry.listResources(serverName, { refresh }),
      mcpRegistry.listResourceTemplates(serverName, { refresh }),
    ]);
    send(ws, {
      type: 'mcp.resources',
      payload: { name: serverName, resources, resourceTemplates },
    });
  } catch (err) {
    sendContentError(ws, 'resources', serverName, errorMessage(err));
  }
}

/** mcp.prompts — list cached prompts, refreshing only when explicitly requested. */
export async function handleMcpPrompts(
  ws: WebSocket,
  msg: WSClientMessage,
  _globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
): Promise<void> {
  if (!mcpRegistry) return sendContentError(ws, 'prompts', '', 'MCP registry is not available.');
  const payload = payloadRecord(msg);
  let serverName = '';
  try {
    serverName = requiredPayloadString(payload, 'name');
    const prompts = await mcpRegistry.listPrompts(serverName, {
      refresh: payload['refresh'] === true,
    });
    send(ws, { type: 'mcp.prompts', payload: { name: serverName, prompts } });
  } catch (err) {
    sendContentError(ws, 'prompts', serverName, errorMessage(err));
  }
}

/** mcp.resource.read — explicit user selection; returns an untrusted provenance envelope. */
export async function handleMcpResourceRead(
  ws: WebSocket,
  msg: WSClientMessage,
  _globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
): Promise<void> {
  if (!mcpRegistry)
    return sendContentError(ws, 'resource.read', '', 'MCP registry is not available.');
  const payload = payloadRecord(msg);
  let serverName = '';
  try {
    serverName = requiredPayloadString(payload, 'name');
    const insertion = await mcpRegistry.selectResourceForInsertion(
      serverName,
      requiredPayloadString(payload, 'uri'),
    );
    send(ws, { type: 'mcp.content.selected', payload: insertion });
  } catch (err) {
    sendContentError(ws, 'resource.read', serverName, errorMessage(err));
  }
}

/** mcp.prompt.get — explicit user selection; prompt argument values stay out of provenance. */
export async function handleMcpPromptGet(
  ws: WebSocket,
  msg: WSClientMessage,
  _globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
): Promise<void> {
  if (!mcpRegistry) return sendContentError(ws, 'prompt.get', '', 'MCP registry is not available.');
  const payload = payloadRecord(msg);
  let serverName = '';
  try {
    serverName = requiredPayloadString(payload, 'name');
    const insertion = await mcpRegistry.selectPromptForInsertion(
      serverName,
      requiredPayloadString(payload, 'prompt'),
      promptArguments(payload['arguments']),
    );
    send(ws, { type: 'mcp.content.selected', payload: insertion });
  } catch (err) {
    sendContentError(ws, 'prompt.get', serverName, errorMessage(err));
  }
}

function payloadRecord(msg: WSClientMessage): Record<string, unknown> {
  return msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload)
    ? (msg.payload as Record<string, unknown>)
    : {};
}

function requiredPayloadString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`MCP payload field "${field}" must be a non-empty string`);
  }
  return value;
}

function promptArguments(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MCP prompt arguments must be an object');
  }
  const args: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') throw new Error(`MCP prompt argument "${key}" must be a string`);
    args[key] = item;
  }
  return args;
}

function sendContentError(ws: WebSocket, action: string, name: string, error: string): void {
  send(ws, { type: 'mcp.content.error', payload: { action, name, error } });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
