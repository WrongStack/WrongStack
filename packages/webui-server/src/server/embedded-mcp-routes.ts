import type { EmbeddedMessageRouterDeps } from './embedded-message-router-types.js';
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

export function createEmbeddedMcpRoutes(deps: EmbeddedMessageRouterDeps) {
  const { opts } = deps;

  const mcp: McpRouteHandlers = {
    ...createMcpTaskHandlers({
      registry: opts.mcpRegistry,
      context: (id) => resolveMcpTaskContext(opts.agent.ctx, deps.sessionCtx.peekAgent, id),
      trustBoundary: deps.trustBoundary,
    }),
    ...createMcpToolHandlers({
      registry: opts.mcpRegistry,
      context: (id) => resolveMcpTaskContext(opts.agent.ctx, deps.sessionCtx.peekAgent, id),
      agent: (id) => deps.sessionCtx.peekAgent?.(id),
      isRunActive: (id) => deps.conversationCtx.abortControllers.has(id),
      trustBoundary: deps.trustBoundary,
    }),
    list: (ws, msg) => handleMcpList(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
    // add/update are the spawn-capable pair — they take a `command`/`args`
    // from the wire and start it. They go past the trust boundary (M1).
    add: (ws, msg) =>
      handleMcpAdd(ws, msg, opts.profileConfigPath, opts.mcpRegistry, deps.trustBoundary),
    update: (ws, msg) =>
      handleMcpUpdate(ws, msg, opts.profileConfigPath, opts.mcpRegistry, deps.trustBoundary),
    remove: (ws, msg) =>
      handleMcpRemove(ws, msg, opts.profileConfigPath, opts.mcpRegistry, deps.trustBoundary),
    enable: (ws, msg) =>
      handleMcpEnable(ws, msg, opts.profileConfigPath, opts.mcpRegistry, deps.trustBoundary),
    disable: (ws, msg) =>
      handleMcpDisable(ws, msg, opts.profileConfigPath, opts.mcpRegistry, deps.trustBoundary),
    sleep: (ws, msg) => handleMcpSleep(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
    wake: (ws, msg) =>
      handleMcpWake(ws, msg, opts.profileConfigPath, opts.mcpRegistry, deps.trustBoundary),
    restart: (ws, msg) =>
      handleMcpRestart(ws, msg, opts.profileConfigPath, opts.mcpRegistry, deps.trustBoundary),
    discover: (ws, msg) =>
      handleMcpDiscover(ws, msg, opts.profileConfigPath, opts.mcpRegistry, deps.trustBoundary),
    resources: (ws, msg) => handleMcpResources(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
    prompts: (ws, msg) => handleMcpPrompts(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
    resourceRead: (ws, msg) =>
      handleMcpResourceRead(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
    promptGet: (ws, msg) => handleMcpPromptGet(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
    authStatus: (ws, msg) => handleMcpAuthStatus(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
    // Binds a loopback port on this host and can mint a credential — same
    // boundary the spawn-capable mutations go through.
    authLogin: (ws, msg) =>
      handleMcpAuthLogin(ws, msg, opts.profileConfigPath, opts.mcpRegistry, deps.trustBoundary),
    authLogout: (ws, msg) =>
      handleMcpAuthLogout(ws, msg, opts.profileConfigPath, opts.mcpRegistry, deps.trustBoundary),
  };
  return mcp;
}
