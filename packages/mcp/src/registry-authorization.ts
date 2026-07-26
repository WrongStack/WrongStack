import type { MCPServerConfig } from '@wrongstack/core/types';
import type {
  MCPAuthorizationManager,
  MCPAuthorizationStartResult,
  MCPAuthorizationStatus,
} from './authorization-manager.js';
import type { ServerSlot } from './registry-slots.js';

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
): MCPServerConfig {
  const cfg = servers.get(name)?.cfg ?? disabledServers.get(name);
  if (!cfg) throw new Error(`MCP server "${name}" not registered`);
  if (cfg.transport === 'stdio' || !cfg.url) {
    throw new Error(`MCP server "${name}" does not use an HTTP transport`);
  }
  return cfg;
}

export async function beginRegistryAuthorization(
  manager: MCPAuthorizationManager | undefined,
  cfg: MCPServerConfig,
  name: string,
  input: {
    clientId: string;
    redirectUri: string;
    scopes?: readonly string[] | undefined;
    challengeHeader?: string | null | undefined;
    signal?: AbortSignal | undefined;
  },
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
