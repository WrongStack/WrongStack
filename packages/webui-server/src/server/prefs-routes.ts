// Prefs WS-message routing — extracted from packages/webui/src/server/index.ts
// (issue #31, follow-on to PRs #94–#110). The standalone server owns a richer
// pref surface than the CLI's embedded ws-handlers/prefs.ts (which only knows
// about YOLO/autonomy), so this module is a thin dispatch layer — the actual
// logic stays in the index.ts closures (getPrefs/updatePrefs) that close over
// the live boot context (config, context.meta, permissionPolicy, pipelines,
// autoCompactor, logger). Mirrors the shape of the 11 sibling route handlers
// already wired through `handleMessage`.
//
// Why callback injection (not the CLI's context-object style): the standalone
// server has ~10 closure-captured dependencies the prefs handler reads (config
// for feature-flag mutation, pipelines for AutoCompaction add/remove, logger
// for runtime level, etc.) — bundling them into a PrefsContext interface
// would duplicate state already living on index.ts. Two callbacks (one per
// message type) keeps the contract minimal and avoids drift if any new
// closure dependency is added.

import type { WebSocket } from 'ws';
import { correlatedReply } from './correlated-reply.js';
import {
  handlePrefsGet,
  handlePrefsUpdate,
  handleSystemPromptGet,
  handleSystemPromptPresets,
  type PrefsHandlerContext,
} from './prefs-handlers.js';
import type { WSClientMessage } from './types.js';
import { handleUserInstructions } from './user-instructions-handlers.js';
import { errMessage, messageSessionId, send } from './ws-utils.js';

export interface PrefsRouteHandlers {
  /** Respond to the WS client with one session's pref snapshot. */
  getPrefs: (ws: WebSocket, sessionId?: string) => Promise<void>;
  /**
   * Merge the supplied pref payload into context.meta, persist the durable
   * keys to config.json, apply any runtime effects (YOLO toggle, feature-flag
   * mutation, fallback chain update, AutoCompaction pipeline add/remove,
   * logger.level), then broadcast the full current snapshot to all clients.
   */
  updatePrefs: (ws: WebSocket, payload: Record<string, unknown>) => Promise<void>;
  /**
   * Reply with the identity-prompt variant catalogue: label, hint and an
   * upper-bound token estimate per variant, plus which one is live and whether
   * the user has ever chosen. Setting a variant goes through `prefs.update`
   * with `systemPromptVariant`, so this side stays read-only.
   */
  /** `sessionId` names the tab asking: the live variant is per session. */
  getSystemPrompt: (ws: WebSocket, sessionId?: string | undefined) => Promise<void>;
  manageSystemPromptPresets: (
    ws: WebSocket,
    action: string,
    payload: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<void>;
  /** Preview/apply canonical defaults in the active profile config. */
  doctorConfig?: ((ws: WebSocket, apply: boolean) => Promise<void>) | undefined;
  /**
   * Config store backing the user-scope AGENTS.md editor's include toggle
   * (`systemPrompt.includeGlobalAgents`). Optional: hosts without one serve
   * the default (include = true) and ignore toggle writes.
   */
  userInstructionsConfigStore?: PrefsHandlerContext['configStore'];
  /** Canonical durable prefs path for the same toggle (Chimera finding 1). */
  userInstructionsApplyPrefs?: PrefsHandlerContext['applyConfigPrefs'];
}

export function createPrefsRouteHandlers(
  ctx: PrefsHandlerContext,
  doctorConfig?: PrefsRouteHandlers['doctorConfig'],
): PrefsRouteHandlers {
  return {
    getPrefs: async (ws, sessionId) => handlePrefsGet(ctx, ws, sessionId),
    userInstructionsConfigStore: ctx.configStore,
    userInstructionsApplyPrefs: ctx.applyConfigPrefs,
    updatePrefs: async (ws, payload) => {
      // `sessionId` is routing context, not a preference — pull it out before
      // validation (which rejects unknown keys) and hand it to the handler so
      // session-scoped prefs land on the calling tab.
      const { sessionId, ...prefs } = payload as Record<string, unknown> & {
        sessionId?: unknown;
      };
      return handlePrefsUpdate(
        ctx,
        ws,
        prefs,
        typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined,
      );
    },
    getSystemPrompt: async (ws, sessionId) => handleSystemPromptGet(ctx, ws, sessionId),
    manageSystemPromptPresets: async (ws, action, payload, sessionId) =>
      handleSystemPromptPresets(ctx, ws, action, payload, sessionId),
    ...(doctorConfig !== undefined ? { doctorConfig } : {}),
  };
}

/**
 * Chain-of-responsibility dispatcher for the `prefs.*` WS message family.
 * Returns `true` if the message was handled by this layer (so the caller's
 * chain short-circuits), `false` if it should fall through to the next layer
 * or the residual switch.
 *
 * Owned prefixes:
 *   - `prefs.get`
 *   - `prefs.update`
 *   - `system_prompt.get`
 *   - `system_prompt.presets.*`
 *   - `user_instructions.get` / `user_instructions.save`
 *   - `config.doctor`
 *
 * Regression-tested by packages/webui/tests/server/dispatcher-routing.test.ts.
 */
export async function handlePrefsRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  handlers: PrefsRouteHandlers,
): Promise<boolean> {
  switch (msg.type) {
    case 'prefs.get': {
      // A tab asks for ITS prefs; the session-scoped half of the answer is
      // meaningless without knowing which tab asked.
      await handlers.getPrefs(
        correlatedReply(ws, msg.payload, ['prefs.updated']).socket,
        messageSessionId(msg),
      );
      return true;
    }
    case 'prefs.update': {
      const { requestId: _requestId, ...payload } = (msg.payload ?? {}) as Record<string, unknown>;
      const reply = correlatedReply(ws, msg.payload, ['key.operation_result']);
      try {
        await handlers.updatePrefs(reply.socket, payload);
        if (reply.requestId && !reply.replied)
          send(reply.socket, {
            type: 'key.operation_result',
            payload: { success: true, message: 'WrongStack settings saved.' },
          });
      } catch (error) {
        send(reply.socket, {
          type: 'key.operation_result',
          payload: {
            success: false,
            message: errMessage(error),
          },
        });
      }
      return true;
    }
    case 'system_prompt.get': {
      // Same reason as `prefs.get`: the catalogue is shared but `current` is
      // this tab's own variant.
      await handlers.getSystemPrompt(ws, messageSessionId(msg));
      return true;
    }
    case 'system_prompt.presets.get':
    case 'system_prompt.presets.create':
    case 'system_prompt.presets.save':
    case 'system_prompt.presets.activate':
    case 'system_prompt.presets.delete':
    case 'system_prompt.presets.validate':
    case 'system_prompt.presets.preview': {
      await handlers.manageSystemPromptPresets(
        ws,
        msg.type.slice('system_prompt.presets.'.length),
        (msg.payload ?? {}) as Record<string, unknown>,
        messageSessionId(msg),
      );
      return true;
    }
    case 'user_instructions.get':
    case 'user_instructions.save': {
      await handleUserInstructions(
        ws,
        msg.type === 'user_instructions.get' ? 'get' : 'save',
        (msg.payload ?? {}) as Record<string, unknown>,
        send,
        handlers.userInstructionsConfigStore,
        handlers.userInstructionsApplyPrefs,
      );
      return true;
    }
    case 'config.doctor': {
      // The result carries the request's id, or a client waiting on it (the
      // desktop's Config Doctor) never matches it and reports no answer.
      const reply = correlatedReply(ws, msg.payload, ['config.doctor.result']).socket;
      if (!handlers.doctorConfig) {
        send(reply, {
          type: 'config.doctor.result',
          payload: {
            success: false,
            applied: false,
            changed: false,
            changes: [],
            configPath: '',
            backupPath: undefined,
            error: 'config doctor unavailable on this server',
          },
        });
        return true;
      }
      await handlers.doctorConfig(
        reply,
        (msg.payload as { apply?: unknown } | undefined)?.apply === true,
      );
      return true;
    }
    default:
      return false;
  }
}
