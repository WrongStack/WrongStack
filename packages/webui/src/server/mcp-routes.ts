// MCP WS-message routing — extracted from packages/webui/src/server/index.ts
// (issue #31, follow-on to PRs #94–#110, #118, #119). The handler logic was
// already in mcp-handlers.ts; this module is the chain-of-responsibility
// dispatcher that mirrors the shape of the other 12 sibling route handlers
// already wired through `handleMessage`.
//
// Why a thin dispatcher instead of importing handleMcpXxx directly into
// index.ts: every other sibling uses the handleXxxRoute(ws, msg, handlers)
// callback-injection pattern, which lets the test surface stub individual
// callbacks (dispatcher-routing.test.ts covers 13 of these now). Bypassing
// the pattern for MCP would mean the dispatcher-routing test for mcp.*
// would have to spin up a real MCPRegistry — high cost for low value.
//
// Why 10 callbacks (one per case) instead of a McpContext interface: each
// handleMcpXxx already takes the same (ws, msg, globalConfigPath,
// mcpRegistry) signature. Bundling those 4 params into a single
// McpContext object would be churn for no behavior change. The two-callback
// (prefs) vs ten-callback (mcp) asymmetry is fine — the contract is
// "one callback per owned message type", not "smallest possible surface".

import type { WebSocket } from 'ws';
import type { WSClientMessage } from './types.js';

export interface McpRouteHandlers {
  list: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  add: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  update: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  remove: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  enable: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  disable: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  sleep: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  wake: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  restart: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  discover: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
}

/**
 * Chain-of-responsibility dispatcher for the `mcp.*` WS message family.
 * Returns `true` if the message was handled by this layer (so the caller's
 * chain short-circuits), `false` if it should fall through to the next layer
 * or the residual switch.
 *
 * Owned prefixes (10 message types — full coverage of the MCP management
 * surface; the WebUI MCP panel only ever talks to the server through these):
 *   - mcp.list
 *   - mcp.add
 *   - mcp.update
 *   - mcp.remove
 *   - mcp.enable
 *   - mcp.disable
 *   - mcp.sleep
 *   - mcp.wake
 *   - mcp.restart
 *   - mcp.discover
 *
 * Regression-tested by packages/webui/tests/server/dispatcher-routing.test.ts.
 */
export async function handleMcpRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  handlers: McpRouteHandlers,
): Promise<boolean> {
  switch (msg.type) {
    case 'mcp.list':
      await handlers.list(ws, msg);
      return true;
    case 'mcp.add':
      await handlers.add(ws, msg);
      return true;
    case 'mcp.update':
      await handlers.update(ws, msg);
      return true;
    case 'mcp.remove':
      await handlers.remove(ws, msg);
      return true;
    case 'mcp.enable':
      await handlers.enable(ws, msg);
      return true;
    case 'mcp.disable':
      await handlers.disable(ws, msg);
      return true;
    case 'mcp.sleep':
      await handlers.sleep(ws, msg);
      return true;
    case 'mcp.wake':
      await handlers.wake(ws, msg);
      return true;
    case 'mcp.restart':
      await handlers.restart(ws, msg);
      return true;
    case 'mcp.discover':
      await handlers.discover(ws, msg);
      return true;
    default:
      return false;
  }
}
