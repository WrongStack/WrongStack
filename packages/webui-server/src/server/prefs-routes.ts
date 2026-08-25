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
import {
  handlePrefsGet,
  handlePrefsUpdate,
  handleSystemPromptGet,
  type PrefsHandlerContext,
} from './prefs-handlers.js';
import type { WSClientMessage } from './types.js';
import { send } from './ws-utils.js';

export interface PrefsRouteHandlers {
  /** Respond to the WS client with the current pref snapshot. */
  getPrefs: (ws: WebSocket) => Promise<void>;
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
  getSystemPrompt: (ws: WebSocket) => Promise<void>;
  /** Preview/apply canonical defaults in the active profile config. */
  doctorConfig?: ((ws: WebSocket, apply: boolean) => Promise<void>) | undefined;
}

export function createPrefsRouteHandlers(
  ctx: PrefsHandlerContext,
  doctorConfig?: PrefsRouteHandlers['doctorConfig'],
): PrefsRouteHandlers {
  return {
    getPrefs: async (ws) => handlePrefsGet(ctx, ws),
    updatePrefs: async (ws, payload) => handlePrefsUpdate(ctx, ws, payload),
    getSystemPrompt: async (ws) => handleSystemPromptGet(ctx, ws),
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
      await handlers.getPrefs(ws);
      return true;
    }
    case 'prefs.update': {
      await handlers.updatePrefs(ws, (msg.payload ?? {}) as Record<string, unknown>);
      return true;
    }
    case 'system_prompt.get': {
      await handlers.getSystemPrompt(ws);
      return true;
    }
    case 'config.doctor': {
      if (!handlers.doctorConfig) {
        send(ws, {
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
        ws,
        (msg.payload as { apply?: unknown } | undefined)?.apply === true,
      );
      return true;
    }
    default:
      return false;
  }
}
