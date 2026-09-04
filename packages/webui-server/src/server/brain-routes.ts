import type { WebSocket } from 'ws';
import {
  type BrainHandlerContext,
  handleBrainAsk,
  handleBrainConfigGet,
  handleBrainConfigSet,
  handleBrainRisk,
  handleBrainStatus,
} from './brain-handlers.js';
import type { WSClientMessage } from './types.js';
import {
  validateBrainAskPayload,
  validateBrainConfigSetPayload,
  validateBrainRiskPayload,
} from './ws-payload-validation.js';
import { messageSessionId, sendResult } from './ws-utils.js';

export interface BrainRouteHandlers {
  status: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  risk: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  ask: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  configGet: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  configSet: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
}

/**
 * Build the brain route table for a host.
 *
 * Both hosts — the standalone server (`routes.ts`) and the CLI-embedded router
 * (`embedded-message-router.ts`) — used to hand-roll this table with inline
 * casts (`(msg.payload as { level?: string })?.level ?? ''`). Two consequences:
 *
 *   - the three `validateBrain*Payload` functions were written, exported and
 *     unit-tested but never called by anything, so the suite was guaranteeing
 *     code no request could reach;
 *   - the payload arrived at the handler unchecked, and a malformed frame was
 *     reported through whatever message the handler's own guard happened to
 *     produce ("Unknown risk level \"\"") instead of naming the bad field.
 *
 * One factory, shared by both hosts, mirroring `createAutonomyRouteHandlers`.
 * The handlers keep their internal guards — they are exported and callable
 * directly — but they are defence in depth now rather than the only check.
 * See docs/audit/webui-full-review-2026-09-03.md B-08.
 */
export function createBrainRouteHandlers(ctx: BrainHandlerContext): BrainRouteHandlers {
  return {
    status: (ws, msg) => handleBrainStatus(ctx, ws, messageSessionId(msg)),
    risk: (ws, msg) => {
      const parsed = validateBrainRiskPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      handleBrainRisk(ctx, ws, parsed.value.level, messageSessionId(msg));
    },
    ask: (ws, msg) => {
      const parsed = validateBrainAskPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      return handleBrainAsk(ctx, ws, parsed.value.question, messageSessionId(msg));
    },
    configGet: (ws) => handleBrainConfigGet(ctx, ws),
    configSet: (ws, msg) => {
      const parsed = validateBrainConfigSetPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      return handleBrainConfigSet(ctx, ws, { patch: parsed.value.patch }, messageSessionId(msg));
    },
  };
}

export async function handleBrainRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  handlers: BrainRouteHandlers,
): Promise<boolean> {
  switch (msg.type) {
    case 'brain.status':
      await handlers.status(ws, msg);
      return true;
    case 'brain.risk':
      await handlers.risk(ws, msg);
      return true;
    case 'brain.ask':
      await handlers.ask(ws, msg);
      return true;
    case 'brain.config.get':
      await handlers.configGet(ws, msg);
      return true;
    case 'brain.config.set':
      await handlers.configSet(ws, msg);
      return true;
    default:
      return false;
  }
}
