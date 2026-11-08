import {
  normalizeSubagentModelPlan,
  seedSessionSubagentPolicy,
  setSessionSubagentModelPlan,
  setSessionSubagentPolicy,
  subagentPolicyModeFrom,
} from '@wrongstack/coordination';
import type { Context } from '@wrongstack/core/agent';
import { type DestructiveKind, resolveYoloConfirmKinds } from '@wrongstack/core/security';
import type { WebSocket } from 'ws';
import { createAutonomyRouteHandlers } from './autonomy-routes.js';
import { patchConfig } from './boot.js';
import { handleConfigDoctor } from './config-doctor.js';
import { computeConfigPrefUpdates } from './config-pref-updates.js';
import { prefSnapshot as prefSnapshotImpl } from './pref-helpers.js';
import type { PrefsHandlerContext } from './prefs-handlers.js';
import { createPrefsRouteHandlers } from './prefs-routes.js';
import { profileIdentity } from './profile-identity.js';
import { applyWrongProxyPrefs as applyWrongProxyPrefsRuntime } from './proxy-runtime.js';
import type { WebuiCallbacks, WebuiDeps, WebuiMutableState } from './route-contracts.js';
import type { createSystemPromptRouteAdapter } from './system-prompt-route-adapter.js';
import { broadcast, send } from './ws-utils.js';

/**
 * Prefs + autonomy routes for `buildRoutes`: the session-aware prefs handler
 * context (meta, snapshot, subagent policy, YOLO, config prefs, WrongProxy,
 * auto-compaction, log level) and the config-doctor handler.
 */
export function createPrefsAndAutonomyRoutes(
  state: WebuiMutableState,
  deps: WebuiDeps,
  cb: WebuiCallbacks,
  sessionContext: (sessionId?: string) => Context,
  systemPromptAdapter: ReturnType<typeof createSystemPromptRouteAdapter>,
) {
  const prefsContext: PrefsHandlerContext = {
    ...(typeof deps.profileConfigPath === 'string' && deps.profileConfigPath.trim()
      ? { profileIdentity: profileIdentity(deps.profileConfigPath) }
      : {}),
    meta: deps.context.meta,
    // Session-scoped prefs (autonomy, yolo, context strategy, prompt variant,
    // reasoning) land on the calling tab's own context meta.
    metaFor: (sessionId?: string) => sessionContext(sessionId).meta,
    // Session-aware: the scoped keys live on that tab's own context meta.
    snapshot: (sessionId?: string) => {
      const target = sessionContext(sessionId);
      seedSessionSubagentPolicy(target);
      return sessionId ? prefSnapshotImpl(target.meta) : cb.prefSnapshot();
    },
    setSubagentsAllowed: (allowed, sessionId, companions) =>
      setSessionSubagentPolicy(
        sessionContext(sessionId),
        subagentPolicyModeFrom(allowed, companions),
      ),
    setSubagentModelPlan: (plan, sessionId) =>
      setSessionSubagentModelPlan(sessionContext(sessionId), normalizeSubagentModelPlan(plan)),
    persist: cb.persistPrefsToConfig,
    // Eternal autonomy: the driver runs the loop for the tab that switched,
    // and refuses a switch it cannot honour before anything is saved.
    ...(deps.eternal
      ? {
          checkAutonomy: (mode: string, sessionId?: string) =>
            deps.eternal?.check(sessionId ?? state.getSession().id, mode) ??
            Promise.resolve(undefined),
          setAutonomy: (mode: string, sessionId?: string) =>
            deps.eternal?.setMode(sessionId ?? state.getSession().id, mode),
        }
      : {}),
    pendingConfirms: deps.pendingConfirms,
    configStore: deps.configStore,
    systemPrompt: systemPromptAdapter,
    setYolo: (enabled) =>
      (deps.permissionPolicy as { setYolo?: (value: boolean) => void }).setYolo?.(enabled),
    setYoloConfirm: (preference) =>
      (
        deps.permissionPolicy as {
          setYoloConfirmKinds?: (kinds: Iterable<DestructiveKind>) => void;
        }
      ).setYoloConfirmKinds?.(resolveYoloConfirmKinds(preference)),
    applyConfigPrefs: (payload) => {
      const config = state.getConfig();
      const updates = computeConfigPrefUpdates(config, payload);
      // No-op payloads must not churn the config identity — subscribers and
      // equality checks downstream key on the object reference.
      if (Object.keys(updates).length === 0) return;
      state.setConfig(patchConfig(config, updates));
    },
    // WrongProxy / WrongTrace: reflect the standalone toggle/URL into the
    // shared `ProxyConfig` singleton immediately and await the re-probe so
    // `active` is fresh before a subsequent model.switch reads it. In the
    // CLI-hosted path this same key is the CLI's `applyWrongProxyPrefs`; when
    // running as its own process there is no CLI to inject it, so route it to
    // the server-local runtime module.
    applyWrongProxyPrefs: (payload) => applyWrongProxyPrefsRuntime(payload),
    setAutoCompact: (enabled) => {
      // Keep the middleware INSTALLED and let it decide per conversation.
      // Adding and removing it on the shared pipeline was a process-wide
      // switch driven by a per-tab preference: turning auto-compaction off in
      // one tab stopped it for the three running beside it, and turning it
      // back on re-armed it for all of them.
      if (!deps.autoCompactor) return;
      if (!deps.pipelines.contextWindow.list().includes('AutoCompaction')) {
        deps.pipelines.contextWindow.use({
          name: 'AutoCompaction',
          handler: deps.autoCompactor.handler(),
        });
      }
      deps.autoCompactor.setEnabled(enabled);
    },
    setLogLevel: (level) => {
      (deps.logger as { level: string }).level = level;
    },
    send,
    broadcast: (message) => broadcast(state.getClients(), message),
  };
  const doctorConfigHandler = (ws: WebSocket, apply: boolean) =>
    handleConfigDoctor(ws, apply, {
      profileConfigPath: deps.profileConfigPath,
      vault: deps.vault,
      updateConfig: cb.updateGlobalConfig,
      applyRuntimeConfig: (next) => {
        state.setConfig(next);
        deps.configStore.update(next);
      },
    });
  const prefsRoutes = createPrefsRouteHandlers(prefsContext, doctorConfigHandler);
  const autonomyRoutes = createAutonomyRouteHandlers(prefsContext);
  return { prefsRoutes, autonomyRoutes };
}
