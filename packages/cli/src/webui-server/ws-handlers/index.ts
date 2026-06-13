import type { ModelsRegistry } from '@wrongstack/core';
import type { WebSocket } from 'ws';
import type { ProviderConfigStore } from '../provider-config.js';

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
 * The messaging surface every ws-handler group needs. Each group's
 * context extends this with its own dependencies, so the per-group
 * contexts stay focused instead of one shared god-object growing a
 * field for every concern in the file.
 */
export interface WsCommon {
  /** Send one message to a single socket (no-op if the socket isn't OPEN). */
  send: (ws: WebSocket, msg: WsServerMessage) => void;
  /** Broadcast a message to every connected socket. */
  broadcast: (msg: WsServerMessage) => void;
  /** console.log adapter, so handlers don't reach for the global directly. */
  log: (msg: string) => void;
}

/**
 * Context for the provider / model / API-key handlers.
 */
export interface WsHandlerContext extends WsCommon {
  /** Provider-config store (load/save the saved-providers map), bound to the global config path. */
  providerStore: ProviderConfigStore;
  /** Models registry backing the provider/model catalog (optional). */
  modelsRegistry: ModelsRegistry | undefined;
}

export {
  type BrainHandlerContext,
  handleBrainAsk,
  handleBrainRisk,
  handleBrainStatus,
} from './brain.js';
export {
  handleDiagGet,
  handleSkillsList,
  handleStatsGet,
  handleToolsList,
  type IntrospectionContext,
} from './introspection.js';
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
export {
  handlePlanGet,
  handlePlanItemUpdate,
  handlePlanTemplateUse,
  handleTasksGet,
  handleTaskUpdate,
  handleTodosClear,
  handleTodosGet,
  handleTodosRemove,
  handleTodoUpdate,
  type WorklistContext,
} from './worklist.js';
