/**
 * Session context route handlers: clear, debug, compact, repair, and context editor.
 */

import { DEFAULT_CONTEXT_WINDOW_MODE_ID } from '@wrongstack/core/types';
import { repairToolUseAdjacency } from '@wrongstack/core/utils';
import {
  applyContextEditorProposal,
  buildContextEditorSnapshot,
  validateContextEditorProposal,
} from './context-editor.js';
import type { SessionHandlerShared } from './session-handler-helpers.js';
import { isRecordPayload } from './session-handler-helpers.js';
import { estimateContextBreakdown } from './token-estimator.js';
import type { SessionRouteHandlers } from './session-routes.js';
import { errMessage, withRequestId } from './ws-utils.js';

export function createSessionContextHandlers(
  shared: SessionHandlerShared,
): Pick<
  SessionRouteHandlers,
  | 'clearContext'
  | 'debugContext'
  | 'compactContext'
  | 'repairContext'
  | 'openContextEditor'
  | 'validateContextEditor'
  | 'applyContextEditor'
> {
  const {
    ctx,
    sendTo,
    broadcastToAll,
    result,
    resetContextAccounting,
    sessionPayload,
    requestedSessionId,
    contextForMessage,
    sendContextUnavailable,
    actingSessionId,
    ensureCurrentSession,
    currentSessionId,
  } = shared;

  return {
    clearContext: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.clear')) return;
      const target = contextForMessage(msg);
      if (!target) {
        sendContextUnavailable(ws, msg, 'context.clear');
        return;
      }
      target.state.replaceMessages([]);
      target.state.replaceTodos([]);
      // This session's own counter. Falling back to the shared one is only
      // safe for the root context — doing it for a session agent would zero
      // the numbers of the three tabs beside it.
      const counter =
        target.tokenCounter ?? (target === ctx.context ? ctx.tokenCounter : undefined);
      counter?.reset?.();
      // The meta keys `resetContextAccounting` clears live on the root context.
      if (target === ctx.context) resetContextAccounting();
      target.clearMemoryEvidence?.();
      target.readFiles.clear();
      target.fileMtimes.clear();
      result(ws, true, 'Context cleared');
      // The reset must describe AND name the session that was CLEARED. Built
      // without a sessionId override the payload describes the FOREGROUND
      // session (its model/provider/maxContext), and restamping only the id
      // still hydrated the cleared lane with the other tab's metadata —
      // `session.start` is the status bar's source of truth. The targeted
      // build is the same form `rewind` uses.
      broadcastToAll({
        type: 'session.start',
        payload: await ctx.sessionStartPayload({
          reset: true,
          sessionId: actingSessionId(msg),
        }),
      });
    },
    debugContext: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.debug')) return;
      // A named session is read from ITS OWN agent — resolved WITHOUT
      // creating one, always through `peekAgent`. `getAgent` is deliberately
      // NOT a fallback here: it CREATES on read, and on a full registry that
      // materialisation can evict a live tab's agent to make room — then
      // answer the breakdown with a phantom empty context. A host without
      // `peekAgent` gets the same explicit "not live" error a peekAgent miss
      // produces, which is what the peekAgent contract above already
      // mandates. The shared root context belongs to whichever session the
      // runtime currently points at; with four tabs on one socket that is
      // routinely a DIFFERENT tab, and serving it stamped with the
      // requester's id is exactly how one tab's breakdown modal rendered
      // another tab's tokens. `ctx.context` stays the answer only for the
      // runtime's own current session and for pre-session requests that name
      // no session at all.
      const requested = requestedSessionId(msg);
      const agent = requested ? ctx.peekAgent?.(requested) : undefined;
      const target =
        agent && agent.ctx.session?.id === requested
          ? agent.ctx
          : !requested || requested === currentSessionId()
            ? ctx.context
            : undefined;
      if (!target) {
        // Route through the shared refusal helper — it stamps the
        // ASKING tab's id (not the runtime's current one) and omits
        // `requestedSessionId`, which the webui client treats as a
        // session-swap guard marker and would swallow before delivery.
        sendContextUnavailable(ws, msg, 'context.debug');
        return;
      }
      const breakdown = estimateContextBreakdown({
        systemPrompt: target.systemPrompt,
        tools: ctx.listTools?.() ?? ctx.toolRegistry?.list() ?? [],
        messages: target.messages,
      });
      sendTo(ws, {
        type: 'context.debug',
        payload: withRequestId(msg.payload, {
          ...breakdown,
          mode: target.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID,
          policy: target.meta['contextWindowPolicy'],
          sessionId: actingSessionId(msg),
        }),
      });
    },
    compactContext: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.compact')) return;
      const aggressive = !!(msg as { payload?: { aggressive?: boolean | undefined } }).payload
        ?.aggressive;
      try {
        const compactor = ctx.getCompactor?.() ?? ctx.compactor;
        if (!compactor) {
          result(ws, false, 'Compactor not available');
          return;
        }
        const target = contextForMessage(msg);
        if (!target) {
          sendContextUnavailable(ws, msg, 'context.compact');
          return;
        }
        const counter = target.tokenCounter ?? ctx.tokenCounter;
        const beforeUsage = counter.total();
        const report = await compactor.compact(target, { aggressive });
        const afterUsage = counter.total();
        const before =
          typeof report.before === 'number'
            ? report.before
            : beforeUsage.input + beforeUsage.output;
        const after =
          typeof report.after === 'number' ? report.after : afterUsage.input + afterUsage.output;
        sendTo(ws, {
          type: 'context.compacted',
          payload: sessionPayload({
            before,
            after,
            saved: Math.max(0, before - after),
            reductions: report.reductions ?? [],
            repaired: report.repaired ?? false,
          }),
        });
        result(
          ws,
          true,
          `Compacted: ${before} → ${after} tokens (saved ~${Math.max(0, before - after)})`,
        );
      } catch (err) {
        result(ws, false, errMessage(err));
      }
    },
    repairContext: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.repair')) return;
      const target = contextForMessage(msg);
      if (!target) {
        sendContextUnavailable(ws, msg, 'context.repair');
        return;
      }
      const beforeMessages = target.messages.length;
      const repaired = repairToolUseAdjacency(target.messages);
      if (repaired.report.changed) {
        target.state.replaceMessages(repaired.messages);
      }
      const payload = {
        sessionId: actingSessionId(msg),
        removedToolUses: repaired.report.removedToolUses,
        removedToolResults: repaired.report.removedToolResults,
        removedMessages: repaired.report.removedMessages,
        beforeMessages,
        afterMessages: target.messages.length,
      };
      broadcastToAll({ type: 'context.repaired', payload });
      const removed =
        payload.removedToolUses.length +
        payload.removedToolResults.length +
        payload.removedMessages;
      result(
        ws,
        true,
        removed > 0
          ? `Context repaired: removed ${removed} orphan protocol item(s)`
          : 'Context repair found no orphan protocol blocks',
      );
    },
    openContextEditor: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.editor.open')) return;
      const target = contextForMessage(msg);
      if (!target) {
        sendContextUnavailable(ws, msg, 'context.editor.open');
        return;
      }
      const snapshot = buildContextEditorSnapshot(
        target,
        ctx.listTools?.() ?? ctx.toolRegistry?.list(),
      );
      sendTo(ws, {
        type: 'context.editor.snapshot',
        payload: { ...snapshot, sessionId: actingSessionId(msg) },
      });
    },
    validateContextEditor: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.editor.validate')) return;
      const payload = isRecordPayload(msg.payload) ? msg.payload : {};
      const target = contextForMessage(msg);
      if (!target) {
        sendContextUnavailable(ws, msg, 'context.editor.validate');
        return;
      }
      const validation = validateContextEditorProposal({
        ctx: target,
        tools: ctx.listTools?.() ?? ctx.toolRegistry?.list(),
        baseRevision: typeof payload['baseRevision'] === 'string' ? payload['baseRevision'] : '',
        messages: payload['messages'],
        removals: payload['removals'],
        allowRepair: payload['allowRepair'] === true,
        runActive: ctx.isRunActive?.(requestedSessionId(msg) ?? currentSessionId()) === true,
      });
      sendTo(ws, {
        type: 'context.editor.validation',
        // Stamped with the ASKING session: `sessionPayload` alone would stamp
        // the runtime's current (root) session, so a background tab's edit
        // results were tagged for — and dropped by — the wrong lane.
        payload: sessionPayload({ ...validation, sessionId: actingSessionId(msg) }),
      });
    },
    applyContextEditor: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.editor.apply')) return;
      const payload = isRecordPayload(msg.payload) ? msg.payload : {};
      const target = contextForMessage(msg);
      if (!target) {
        sendContextUnavailable(ws, msg, 'context.editor.apply');
        return;
      }
      const applied = await applyContextEditorProposal({
        ctx: target,
        tools: ctx.listTools?.() ?? ctx.toolRegistry?.list(),
        baseRevision: typeof payload['baseRevision'] === 'string' ? payload['baseRevision'] : '',
        messages: payload['messages'],
        removals: payload['removals'],
        allowRepair: payload['allowRepair'] === true,
        runActive: ctx.isRunActive?.(requestedSessionId(msg) ?? currentSessionId()) === true,
      });
      if ('ok' in applied) {
        sendTo(ws, {
          type: 'context.editor.validation',
          // Same asking-session stamp as the validate path (see above).
          payload: sessionPayload({ ...applied, sessionId: actingSessionId(msg) }),
        });
        return;
      }
      broadcastToAll({
        type: 'context.editor.applied',
        payload: sessionPayload({ ...applied, sessionId: actingSessionId(msg) }),
      });
      result(
        ws,
        true,
        `Context editor applied: ${applied.before.messages} → ${applied.after.messages} messages`,
      );
    },
  };
}
