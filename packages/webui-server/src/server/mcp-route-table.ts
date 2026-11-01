import {
  handleMcpAdd,
  handleMcpAuthLogin,
  handleMcpAuthLogout,
  handleMcpAuthStatus,
  handleMcpDisable,
  handleMcpDiscover,
  handleMcpEnable,
  handleMcpList,
  handleMcpPromptGet,
  handleMcpPrompts,
  handleMcpRemove,
  handleMcpResourceRead,
  handleMcpResources,
  handleMcpRestart,
  handleMcpSleep,
  handleMcpUpdate,
  handleMcpWake,
} from './mcp-handlers.js';
import type { McpRouteHandlers } from './mcp-routes.js';
import { createMcpTaskHandlers, resolveMcpTaskContext } from './mcp-task-handlers.js';
import { createMcpToolHandlers } from './mcp-tool-handlers.js';
import type { WebuiDeps } from './route-contracts.js';

// ---- MCP route (handleMcpRoute) ----
// Issue #31 follow-on (after #118 PR 0 baseline, #119 prefs extraction).
// Each callback delegates to the matching handleMcpXxx in mcp-handlers.ts
// — that module already owns the WS-message logic, this is just the
// chain-of-responsibility wiring. The 10 cases were pure delegations
// inside the residual switch before this PR; now they're an explicit
// sibling in the chain.
export function createMcpRouteTable(
  deps: WebuiDeps,
  isRunActive: (sessionId: string) => boolean,
): McpRouteHandlers {
  return {
    ...createMcpTaskHandlers({
      registry: deps.mcpRegistry,
      context: (id) => resolveMcpTaskContext(deps.context, deps.peekAgent, id),
      trustBoundary: deps.trustBoundary,
    }),
    ...createMcpToolHandlers({
      registry: deps.mcpRegistry,
      context: (id) => resolveMcpTaskContext(deps.context, deps.peekAgent, id),
      agent: (id) => deps.peekAgent?.(id),
      isRunActive,
      trustBoundary: deps.trustBoundary,
    }),
    list: (ws, msg) => handleMcpList(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
    // add/update are the spawn-capable pair — they take a `command`/`args`
    // from the wire and start it. They go past the trust boundary (M1).
    add: (ws, msg) =>
      handleMcpAdd(ws, msg, deps.profileConfigPath, deps.mcpRegistry, deps.trustBoundary),
    update: (ws, msg) =>
      handleMcpUpdate(ws, msg, deps.profileConfigPath, deps.mcpRegistry, deps.trustBoundary),
    remove: (ws, msg) =>
      handleMcpRemove(ws, msg, deps.profileConfigPath, deps.mcpRegistry, deps.trustBoundary),
    enable: (ws, msg) =>
      handleMcpEnable(ws, msg, deps.profileConfigPath, deps.mcpRegistry, deps.trustBoundary),
    disable: (ws, msg) =>
      handleMcpDisable(ws, msg, deps.profileConfigPath, deps.mcpRegistry, deps.trustBoundary),
    sleep: (ws, msg) => handleMcpSleep(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
    wake: (ws, msg) =>
      handleMcpWake(ws, msg, deps.profileConfigPath, deps.mcpRegistry, deps.trustBoundary),
    restart: (ws, msg) =>
      handleMcpRestart(ws, msg, deps.profileConfigPath, deps.mcpRegistry, deps.trustBoundary),
    discover: (ws, msg) =>
      handleMcpDiscover(ws, msg, deps.profileConfigPath, deps.mcpRegistry, deps.trustBoundary),
    resources: (ws, msg) => handleMcpResources(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
    prompts: (ws, msg) => handleMcpPrompts(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
    resourceRead: (ws, msg) =>
      handleMcpResourceRead(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
    promptGet: (ws, msg) => handleMcpPromptGet(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
    authStatus: (ws, msg) => handleMcpAuthStatus(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
    // Binds a loopback port on this host and can mint a credential — same
    // boundary the spawn-capable mutations go through.
    authLogin: (ws, msg) =>
      handleMcpAuthLogin(ws, msg, deps.profileConfigPath, deps.mcpRegistry, deps.trustBoundary),
    authLogout: (ws, msg) =>
      handleMcpAuthLogout(ws, msg, deps.profileConfigPath, deps.mcpRegistry, deps.trustBoundary),
  };
}
