import type { ConfigStore } from '@wrongstack/core/types';
import { getProcessRegistry } from '@wrongstack/tools';
import type { WebSocket } from 'ws';
import { type PendingConfirm, resolveYoloEligiblePendingConfirms } from './pending-confirms.js';
import type { WSServerMessage } from './types.js';
import { validatePrefsUpdatePayload } from './ws-payload-validation.js';

export interface PrefsHandlerContext {
  meta: Record<string, unknown>;
  snapshot: () => Record<string, unknown>;
  persist: (payload: Record<string, unknown>) => Promise<void>;
  pendingConfirms: Map<string, PendingConfirm>;
  configStore?: ConfigStore | undefined;
  setYolo?: ((enabled: boolean) => void) | undefined;
  setAutonomy?: ((mode: string) => void) | undefined;
  applyConfigPrefs?: ((payload: Record<string, unknown>) => void) | undefined;
  setAutoCompact?: ((enabled: boolean) => void) | undefined;
  setLogLevel?: ((level: 'debug' | 'info' | 'warn' | 'error') => void) | undefined;
  /**
   * WrongProxy / WrongTrace: applies the toggle + URL to the runtime
   * config and kicks the periodic probe. Injected by the CLI's
   * `createPrefsSeeding` so the WS server stays package-agnostic — the
   * server doesn't pull `@wrongstack/cli`'s import graph or its
   * `setInterval`-owning probe module.
   */
  applyWrongProxyPrefs?: ((payload: Record<string, unknown>) => void) | undefined;
  send: (ws: WebSocket, message: WSServerMessage) => void;
  broadcast: (message: WSServerMessage) => void;
}

function sendResult(
  ctx: PrefsHandlerContext,
  ws: WebSocket,
  success: boolean,
  message: string,
): void {
  ctx.send(ws, { type: 'key.operation_result', payload: { success, message } });
}

function routingPatch(payload: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (Array.isArray(payload['fallbackModels'])) patch['fallbackModels'] = payload['fallbackModels'];
  if (
    payload['fallbackProfiles'] &&
    typeof payload['fallbackProfiles'] === 'object' &&
    !Array.isArray(payload['fallbackProfiles'])
  ) {
    patch['fallbackProfiles'] = payload['fallbackProfiles'];
  }
  if (Array.isArray(payload['favoriteModels'])) patch['favoriteModels'] = payload['favoriteModels'];
  if (typeof payload['favoriteModelsOnly'] === 'boolean') {
    patch['favoriteModelsOnly'] = payload['favoriteModelsOnly'];
  }
  if (Array.isArray(payload['modelAvailabilitySchedule'])) {
    patch['modelAvailabilitySchedule'] = payload['modelAvailabilitySchedule'];
  }
  if (
    payload['modelMatrix'] &&
    typeof payload['modelMatrix'] === 'object' &&
    !Array.isArray(payload['modelMatrix'])
  ) {
    patch['modelMatrix'] = payload['modelMatrix'];
  }
  if (typeof payload['fallbackAuto'] === 'boolean') patch['fallbackAuto'] = payload['fallbackAuto'];
  return patch;
}

export function handlePrefsGet(ctx: PrefsHandlerContext, ws: WebSocket): void {
  ctx.send(ws, { type: 'prefs.updated', payload: ctx.snapshot() });
}

export function handlePrefsUpdate(
  ctx: PrefsHandlerContext,
  ws: WebSocket,
  input: Record<string, unknown>,
): void {
  const parsed = validatePrefsUpdatePayload(input);
  if (!parsed.ok) {
    sendResult(ctx, ws, false, parsed.message);
    return;
  }
  const payload = parsed.value.prefs;
  for (const [key, value] of Object.entries(payload)) ctx.meta[key] = value;
  void ctx.persist(payload);

  // Mirror `autonomy.switch`: an `autonomy` payload arriving through
  // `prefs.update` must drive `setAutonomy` so the runtime mode flips
  // immediately, not just on restart. Without this, the validator
  // accepts `eternal` / `eternal-parallel`, `persistPrefsToConfig`
  // writes them through (after the fix above), but the live engine
  // never receives the change and the browser's "set autonomy to
  // eternal" click is silently a no-op until the next process boot.
  if (typeof payload['autonomy'] === 'string') {
    ctx.setAutonomy?.(payload['autonomy']);
  }

  if (typeof payload['yolo'] === 'boolean') {
    ctx.setYolo?.(payload['yolo']);
    if (payload['yolo']) resolveYoloEligiblePendingConfirms(ctx.pendingConfirms);
  }

  ctx.applyConfigPrefs?.(payload);
  const patch = routingPatch(payload);
  if (ctx.configStore && Object.keys(patch).length > 0) ctx.configStore.update(patch as never);

  if (typeof payload['contextAutoCompact'] === 'boolean') {
    ctx.setAutoCompact?.(payload['contextAutoCompact']);
  }
  if (
    typeof payload['breakerEnabled'] === 'boolean' ||
    typeof payload['breakerAutoKillResetMs'] === 'number'
  ) {
    getProcessRegistry().setBreakerConfig({
      ...(typeof payload['breakerEnabled'] === 'boolean'
        ? { enabled: payload['breakerEnabled'] }
        : {}),
      ...(typeof payload['breakerAutoKillResetMs'] === 'number'
        ? { autoKillResetMs: payload['breakerAutoKillResetMs'] }
        : {}),
    });
  }
  if (typeof payload['debugStream'] === 'boolean') {
    void import('@wrongstack/providers').then(({ setDebugStreamEnabled }) =>
      setDebugStreamEnabled(payload['debugStream'] as boolean),
    );
  }
  // WrongProxy / WrongTrace: drive the runtime probe through an
  // injected callback. The CLI provides `applyWrongProxyPrefs` via
  // `PrefsHandlerContext`; the WS server deliberately stays agnostic of
  // `@wrongstack/cli` so the server bundle doesn't drag the probe loop
  // (and its `setInterval`) into the import graph when the user has
  // never touched the toggle.
  if (
    typeof payload['wrongProxyEnabled'] === 'boolean' ||
    typeof payload['wrongProxyUrl'] === 'string'
  ) {
    ctx.applyWrongProxyPrefs?.(payload);
  }
  if (
    typeof payload['logLevel'] === 'string' &&
    ['debug', 'info', 'warn', 'error'].includes(payload['logLevel'])
  ) {
    ctx.setLogLevel?.(payload['logLevel'] as 'debug' | 'info' | 'warn' | 'error');
  }
  ctx.broadcast({ type: 'prefs.updated', payload: ctx.snapshot() });
}

export function handleAutonomySwitch(ctx: PrefsHandlerContext, ws: WebSocket, mode: string): void {
  ctx.meta['autonomy'] = mode;
  ctx.setAutonomy?.(mode);
  sendResult(ctx, ws, true, `Autonomy mode set to "${mode}"`);
  ctx.broadcast({ type: 'prefs.updated', payload: { autonomy: mode } });
  void ctx.persist({ autonomy: mode });
}
