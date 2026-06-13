import type { ModelsRegistry } from '@wrongstack/core';
import type { WebSocket } from 'ws';

/**
 * PR 5 of Issue #30 (webui-server 8-PR refactor): ws-handlers/.
 *
 * The WebSocket message handlers used to live as closures inside
 * `runWebUI`, capturing `opts`, `send`, `broadcast`, etc. directly.
 * To move them into their own topic files we replace every closure
 * capture with a field on `WsHandlerContext`, built once in
 * `runWebUI` and threaded explicitly into each handler — no hidden
 * captures.
 */

/**
 * Server→client message shape. Mirrors `WSServerMessage` in
 * webui-server.ts; duplicated here (rather than imported) so the
 * ws-handlers modules never import back from webui-server.ts and
 * create a cycle.
 */
export interface WsServerMessage {
  type: string;
  payload: unknown;
}

/**
 * Shared state threaded explicitly into every ws-handler group.
 *
 * Only the dependencies the extracted handlers actually use live
 * here. As more handler groups move out of webui-server.ts (sessions,
 * mailbox, …) this context grows the fields they need.
 */
export interface WsHandlerContext {
  /** Path to the global config (~/.wrongstack/config.json) — provider keys live here. */
  globalConfigPath: string | undefined;
  /** Models registry backing the provider/model catalog (optional). */
  modelsRegistry: ModelsRegistry | undefined;
  /** Send one message to a single socket (no-op if the socket isn't OPEN). */
  send: (ws: WebSocket, msg: WsServerMessage) => void;
  /** Broadcast a message to every connected socket. */
  broadcast: (msg: WsServerMessage) => void;
  /** console.log adapter, so handlers don't reach for the global directly. */
  log: (msg: string) => void;
}

export {
  handleKeyDelete,
  handleKeySetActive,
  handleKeyUpsert,
  handleProviderAdd,
  handleProviderModels,
  handleProviderRemove,
  handleProvidersList,
  handleProvidersSaved,
} from './providers.js';
