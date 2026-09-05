/**
 * Session context mode route handlers: list, switch, create, update, delete context modes.
 */

import type { Context } from '@wrongstack/core/agent';
import {
  CONTEXT_WINDOW_MODE_PINNED_META_KEY,
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  getContextWindowMode,
  resolveContextWindowPolicy,
} from '@wrongstack/core/types';
import {
  collectDisplayedSessionIds,
  readSessionWindowTokens,
  type SessionHandlerShared,
} from './session-handler-helpers.js';
import type { SessionRouteHandlers } from './session-routes.js';
import {
  validateContextModeCreatePayload,
  validateContextModeDeletePayload,
  validateContextModeSwitchPayload,
  validateContextModeUpdatePayload,
} from './ws-payload-validation.js';

export function createSessionModeHandlers(
  shared: SessionHandlerShared,
): Pick<
  SessionRouteHandlers,
  | 'listContextModes'
  | 'switchContextMode'
  | 'createContextMode'
  | 'updateContextMode'
  | 'deleteContextMode'
> {
  const {
    ctx,
    sendTo,
    broadcastToAll,
    result,
    modeStore,
    contextForMessage,
    sendContextUnavailable,
    actingSessionId,
    ensureCurrentSession,
    peekForRead,
  } = shared;

  return {
    listContextModes: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.modes.list')) return;
      const target = contextForMessage(msg);
      if (!target) {
        sendContextUnavailable(ws, msg, 'context.modes.list');
        return;
      }
      const active = String(target.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID);
      const store = await modeStore();
      const allModes = store.list().map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        isActive: m.id === active,
        thresholds: m.thresholds,
        preserveK: m.preserveK,
        eliseThreshold: m.eliseThreshold,
        custom: (m as { custom?: boolean }).custom === true,
      }));
      sendTo(ws, {
        type: 'context.modes.list',
        payload: { activeId: active, modes: allModes, sessionId: actingSessionId(msg) },
      });
    },
    switchContextMode: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.mode.switch')) return;
      const parsed = validateContextModeSwitchPayload(msg.payload);
      if (!parsed.ok) {
        result(ws, false, parsed.message);
        return;
      }
      const { id } = parsed.value;
      const target = contextForMessage(msg);
      if (!target) {
        sendContextUnavailable(ws, msg, 'context.mode.switch');
        return;
      }
      let policy = getContextWindowMode(id) ?? null;
      if (!policy) {
        const customModes = (await modeStore())
          .list()
          .filter((m) => (m as { custom?: boolean }).custom === true);
        const custom = customModes.find((m) => m.id === id);
        if (!custom) {
          result(ws, false, `Unknown context mode "${id}"`);
          return;
        }
        policy = custom as never;
      }
      if (!policy) return;
      target.meta['contextWindowMode'] = policy.id;
      target.meta['contextMode'] = policy.id;
      target.meta['contextWindowPolicy'] = policy;
      // The user picked this policy for the session — later window changes
      // (model switch) must not overwrite it.
      target.meta[CONTEXT_WINDOW_MODE_PINNED_META_KEY] = true;
      result(ws, true, `Context mode switched to ${policy.id}`);
      broadcastToAll({
        type: 'context.mode.changed',
        payload: {
          id: policy.id,
          name: policy.name,
          policy,
          sessionId: actingSessionId(msg),
        },
      });
    },
    createContextMode: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.mode.create')) return;
      const parsed = validateContextModeCreatePayload(msg.payload);
      if (!parsed.ok) {
        result(ws, false, parsed.message);
        return;
      }
      const payload = parsed.value;
      const store = await modeStore();
      const operation = store.create({
        id: payload.id,
        name: payload.name,
        description: payload.description,
        thresholds: payload.thresholds,
        preserveK: payload.preserveK,
        eliseThreshold: payload.eliseThreshold,
        custom: true,
        aggressiveOn: 'soft',
        targetLoad: 0.65,
      });
      if (operation.ok) await store.save().catch(() => undefined);
      result(ws, operation.ok, operation.error ?? `Mode "${payload.id}" created`);
    },
    updateContextMode: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.mode.update')) return;
      const parsed = validateContextModeUpdatePayload(msg.payload);
      if (!parsed.ok) {
        result(ws, false, parsed.message);
        return;
      }
      const payload = parsed.value;
      const store = await modeStore();
      const operation = store.update(payload.id, {
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.thresholds
          ? {
              thresholds: {
                warn: payload.thresholds.warn ?? 0.6,
                soft: payload.thresholds.soft ?? 0.75,
                hard: payload.thresholds.hard ?? 0.9,
              },
            }
          : {}),
        ...(payload.preserveK !== undefined ? { preserveK: payload.preserveK } : {}),
        ...(payload.eliseThreshold !== undefined ? { eliseThreshold: payload.eliseThreshold } : {}),
      });
      if (operation.ok) await store.save().catch(() => undefined);
      result(ws, operation.ok, operation.error ?? `Mode "${payload.id}" updated`);
    },
    deleteContextMode: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.mode.delete')) return;
      const parsed = validateContextModeDeletePayload(msg.payload);
      if (!parsed.ok) {
        result(ws, false, parsed.message);
        return;
      }
      const { id } = parsed.value;
      // A deleted mode has to be replaced everywhere it is in use, not just on
      // the tab that pressed delete — the mode store is project-wide, so a tab
      // left pointing at a mode that no longer exists resolves to nothing.
      const requestContext = contextForMessage(msg);
      if (!requestContext) {
        sendContextUnavailable(ws, msg, 'context.mode.delete');
        return;
      }
      const affected = new Set<Context>([ctx.context, requestContext]);
      for (const sessionId of collectDisplayedSessionIds(ctx)) {
        // Peek first: a displayed-but-not-live id is skipped, not materialised.
        const agentCtx = peekForRead(sessionId)?.ctx;
        if (agentCtx) affected.add(agentCtx);
      }
      for (const target of affected) {
        if (String(target.meta['contextWindowMode'] ?? '') !== id) continue;
        const policy = resolveContextWindowPolicy(
          {},
          DEFAULT_CONTEXT_WINDOW_MODE_ID,
          readSessionWindowTokens(target),
        );
        target.meta['contextWindowMode'] = policy.id;
        target.meta['contextWindowPolicy'] = policy;
        delete target.meta[CONTEXT_WINDOW_MODE_PINNED_META_KEY];
      }
      const store = await modeStore();
      const operation = store.remove(id);
      if (operation.ok) await store.save().catch(() => undefined);
      result(ws, operation.ok, operation.error ?? `Mode "${id}" deleted`);
    },
  };
}
