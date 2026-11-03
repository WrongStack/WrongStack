// The catalog moved to @wrongstack/project-surfaces, shared with the desktop app. This path
// keeps the WebUI imports and the core-preset sync test working.
import type { OfficialServer } from '@wrongstack/project-surfaces/lib/official-mcp-servers';
import type { MCPServerConfig } from './contracts.js';

export {
  OFFICIAL_SERVERS,
  type OfficialServer,
} from '@wrongstack/project-surfaces/lib/official-mcp-servers';

/**
 * Convert an OfficialServer entry into an MCPServerConfig (omits display-only fields).
 */
export function toServerConfig(server: OfficialServer, enabled = false): MCPServerConfig {
  return {
    name: server.name,
    description: server.description,
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
    env: server.env,
    bearerTokenEnv: server.bearerTokenEnv,
    allowedTools: server.allowedTools,
    enabled,
  };
}
