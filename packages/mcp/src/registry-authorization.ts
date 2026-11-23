import type { MCPServerConfig } from '@wrongstack/contracts/types';
import { canonicalMcpResource } from './authorization-discovery.js';
import type {
  MCPAuthorizationLoginHandle,
  MCPAuthorizationLoginInput,
  MCPAuthorizationManager,
  MCPAuthorizationStartResult,
  MCPAuthorizationStatus,
} from './authorization-manager.js';
import { expandMcpEnvPlaceholders } from './config-env.js';
import type { ServerSlot } from './registry-slots.js';

/** Caller-supplied part of `MCPRegistry.beginAuthorization()`; the registry adds server + resource. */
export interface MCPRegistryAuthorizationBeginInput {
  clientId?: string | undefined;
  redirectUri: string;
  scopes?: readonly string[] | undefined;
  challengeHeader?: string | null | undefined;
  signal?: AbortSignal | undefined;
}

export function requireAuthorizationManager(
  manager: MCPAuthorizationManager | undefined,
): MCPAuthorizationManager {
  if (!manager) {
    throw new Error('MCP authorization management is not configured for this host');
  }
  return manager;
}

export function requireHttpServerConfig(
  servers: Map<string, ServerSlot>,
  disabledServers: Map<string, MCPServerConfig>,
  name: string,
  onUnsetVariable: 'throw' | 'raw' = 'throw',
): MCPServerConfig {
  const cfg = servers.get(name)?.cfg ?? disabledServers.get(name);
  if (!cfg) throw new Error(`MCP server "${name}" not registered`);
  if (cfg.transport === 'stdio' || !cfg.url) {
    throw new Error(`MCP server "${name}" does not use an HTTP transport`);
  }
  // Authorize the resource the transport dials: its `${VAR}` placeholders
  // expand per connect (config-env.ts), so the raw URL names no real server.
  // Status and logout fall back to the raw URL when a variable is unset: a
  // user must still be able to see and drop a stored grant.
  try {
    const { url } = expandMcpEnvPlaceholders({
      name: cfg.name,
      transport: cfg.transport,
      url: cfg.url,
    });
    return { ...cfg, url };
  } catch (error) {
    if (onUnsetVariable === 'raw') return cfg;
    throw error;
  }
}

/**
 * The resource as configured (placeholders unexpanded), for status output. A
 * status query needs no login, so an expanded `${VAR}` — an API key in the
 * query — must not surface through it.
 */
export function configuredAuthorizationResource(
  servers: Map<string, ServerSlot>,
  disabledServers: Map<string, MCPServerConfig>,
  name: string,
  fallback: string,
): string {
  const raw = servers.get(name)?.cfg.url ?? disabledServers.get(name)?.url;
  if (!raw) return fallback;
  try {
    return canonicalMcpResource(raw);
  } catch {
    return raw;
  }
}

export async function loginRegistryAuthorization(
  manager: MCPAuthorizationManager | undefined,
  cfg: MCPServerConfig,
  name: string,
  input: Omit<MCPAuthorizationLoginInput, 'serverName' | 'resource'>,
): Promise<MCPAuthorizationLoginHandle> {
  return requireAuthorizationManager(manager).beginLogin({
    serverName: name,
    resource: cfg.url!,
    ...input,
  });
}

export async function beginRegistryAuthorization(
  manager: MCPAuthorizationManager | undefined,
  cfg: MCPServerConfig,
  name: string,
  input: MCPRegistryAuthorizationBeginInput,
): Promise<MCPAuthorizationStartResult> {
  return requireAuthorizationManager(manager).begin({
    serverName: name,
    resource: cfg.url!,
    ...input,
  });
}

export async function completeRegistryAuthorization(
  manager: MCPAuthorizationManager | undefined,
  cfg: MCPServerConfig,
  name: string,
  callbackUrl: string,
  signal?: AbortSignal | undefined,
): Promise<MCPAuthorizationStatus> {
  return requireAuthorizationManager(manager).complete({
    serverName: name,
    resource: cfg.url!,
    callbackUrl,
    signal,
  });
}
