import type { SystemInstructionVariant } from '@wrongstack/core/agent';
import type { ConfigStore } from '@wrongstack/core/types';
import { getProcessRegistry } from '@wrongstack/tools';
import type { WebSocket } from 'ws';
import { type PendingConfirm, resolveYoloEligiblePendingConfirms } from './pending-confirms.js';
import {
  buildSystemPromptInfo,
  type SystemPromptSurface,
  unavailableSystemPromptInfo,
} from './system-prompt-handlers.js';
import type { WSServerMessage } from './types.js';
import { validatePrefsUpdatePayload } from './ws-payload-validation.js';

/**
 * Preferences that belong to ONE session rather than to the process.
 *
 * Every WebUI tab runs its own session with its own agent context, so these
 * have to land on the calling tab's meta bag: flipping yolo in tab 3 must not
 * hand tab 1's run blanket tool approval, and a context strategy chosen for a
 * long refactor tab must not re-shape a quick question in the tab beside it.
 *
 * Everything NOT listed here (locale, ports, HQ, telegram, feature flags,
 * breaker, proxy, log level…) is genuinely process-wide and keeps its single
 * global home.
 */
export const SESSION_SCOPED_PREF_KEYS: ReadonlySet<string> = new Set([
  'autonomy',
  'autonomyDelayMs',
  'autoProceedMaxIterations',
  'yolo',
  'maxIterations',
  'contextStrategy',
  'contextMode',
  'contextAutoCompact',
  'tokenSavingTier',
  'systemPromptVariant',
  'reasoningMode',
  'reasoningEffort',
  'reasoningPreserve',
  'nextPrediction',
  'nextStepsTool',
]);

export interface PrefsHandlerContext {
  meta: Record<string, unknown>;
  /**
   * Meta bag of a specific session, for the session-scoped keys above.
   * Falls back to the process-wide `meta` when the host has not wired
   * per-session contexts (the embedded single-session runtimes).
   */
  metaFor?: ((sessionId?: string) => Record<string, unknown>) | undefined;
  /**
   * Read the pref snapshot for ONE session. The session-scoped keys live on
   * that session's meta, so a snapshot taken without an id describes whichever
   * session the runtime is on — which is a different tab from the asking one
   * as often as not once four are open.
   */
  snapshot: (sessionId?: string) => Record<string, unknown>;
  persist: (payload: Record<string, unknown>) => Promise<void>;
  pendingConfirms: Map<string, PendingConfirm>;
  configStore?: ConfigStore | undefined;
  /**
   * Flip the host's process-wide YOLO fallback.
   *
   * `sessionId` names the tab that asked. A host whose "apply" path also
   * writes a context meta must NOT write the leader's when a tab is named —
   * the leader context is the boot tab's runtime, so that write would turn
   * YOLO on for a conversation the user was not in.
   */
  setYolo?: ((enabled: boolean, sessionId?: string | undefined) => void) | undefined;
  setAutonomy?: ((mode: string) => void) | undefined;
  applyConfigPrefs?: ((payload: Record<string, unknown>) => void) | undefined;
  setAutoCompact?: ((enabled: boolean) => void) | undefined;
  setLogLevel?: ((level: 'debug' | 'info' | 'warn' | 'error') => void) | undefined;
  /**
   * WrongProxy / WrongTrace: applies the toggle + URL to the runtime
   * config and kicks the periodic probe. Injected by the CLI's
   * `createPrefsSeeding` so the WS server stays package-agnostic — the
   * server doesn't pull `@wrongstack/cli`'s import graph or its
   * `setInterval`-owning probe module. May return a promise so the
   * standalone server's re-probe can be awaited before the next
   * prefs-dependent request (e.g. an immediate model.switch).
   */
  applyWrongProxyPrefs?: ((payload: Record<string, unknown>) => void | Promise<void>) | undefined;
  /**
   * Identity-prompt picker. Optional so a host that has not wired it still
   * compiles; `system_prompt.get` then answers with an explicit "unavailable"
   * payload rather than leaving the browser's request unanswered.
   */
  systemPrompt?: SystemPromptSurface | undefined;
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

export function handlePrefsGet(ctx: PrefsHandlerContext, ws: WebSocket, sessionId?: string): void {
  // Stamped so the browser can file the answer under the tab that asked
  // instead of over whatever it is currently showing.
  ctx.send(ws, {
    type: 'prefs.updated',
    payload: { ...ctx.snapshot(sessionId), ...(sessionId ? { sessionId } : {}) },
  });
}

/** Answer `system_prompt.get` with the variant catalogue and token estimates. */
export async function handleSystemPromptGet(
  ctx: PrefsHandlerContext,
  ws: WebSocket,
  sessionId?: string,
): Promise<void> {
  const payload = ctx.systemPrompt
    ? await buildSystemPromptInfo(ctx.systemPrompt, sessionVariant(ctx, sessionId))
    : unavailableSystemPromptInfo();
  ctx.send(ws, {
    type: 'system_prompt.info',
    payload: sessionId ? { ...payload, sessionId } : payload,
  });
}

/** The identity variant this tab is actually running, if it has its own. */
function sessionVariant(ctx: PrefsHandlerContext, sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  const value = ctx.metaFor?.(sessionId)?.['systemPromptVariant'];
  return typeof value === 'string' ? value : undefined;
}

export async function handlePrefsUpdate(
  ctx: PrefsHandlerContext,
  ws: WebSocket,
  input: Record<string, unknown>,
  sessionId?: string,
): Promise<void> {
  const parsed = validatePrefsUpdatePayload(input);
  if (!parsed.ok) {
    sendResult(ctx, ws, false, parsed.message);
    return;
  }
  const payload = parsed.value.prefs;
  // Session-scoped keys land on the CALLING tab's context; the rest stay
  // process-wide. Both still go to `persist`, which keeps the config file as
  // the default a newly opened tab starts from.
  const sessionMeta = ctx.metaFor?.(sessionId) ?? ctx.meta;
  for (const [key, value] of Object.entries(payload)) {
    if (SESSION_SCOPED_PREF_KEYS.has(key)) sessionMeta[key] = value;
    else ctx.meta[key] = value;
  }
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
    ctx.setYolo?.(payload['yolo'], sessionId);
    if (payload['yolo']) resolveYoloEligiblePendingConfirms(ctx.pendingConfirms, sessionId);
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
    // Await the injected callback so the re-probe settles `active` before
    // the next prefs-dependent request (e.g. an immediate model.switch)
    // reads the singleton. The CLI's sync `applyWrongProxyPrefs` resolves
    // immediately; the standalone runtime's is async.
    await ctx.applyWrongProxyPrefs?.(payload);
  }
  if (
    typeof payload['logLevel'] === 'string' &&
    ['debug', 'info', 'warn', 'error'].includes(payload['logLevel'])
  ) {
    ctx.setLogLevel?.(payload['logLevel'] as 'debug' | 'info' | 'warn' | 'error');
  }
  // The identity variant is the one pref that changes the *prompt itself*, so
  // persisting it is not enough: without a rebuild the new variant would only
  // take effect on the next boot, and the picker would report a variant the
  // running session is not actually using.
  const nextVariant = payload['systemPromptVariant'];
  if (typeof nextVariant === 'string' && ctx.systemPrompt) {
    try {
      await ctx.systemPrompt.applyVariant?.(nextVariant as SystemInstructionVariant, sessionId);
    } catch (err) {
      sendResult(
        ctx,
        ws,
        false,
        `System prompt saved, but the live prompt could not be rebuilt: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // The catalogue is broadcast (it is the same everywhere), but `current`
    // belongs to the tab that changed it — an untagged one told every other
    // picker it had switched too.
    ctx.broadcast({
      type: 'system_prompt.info',
      payload: {
        ...(await buildSystemPromptInfo(ctx.systemPrompt, sessionVariant(ctx, sessionId))),
        ...(sessionId ? { sessionId } : {}),
      },
    });
  }

  // Split the echo: session-scoped keys are addressed at the tab that set
  // them, project-wide keys go to everyone. Broadcasting one untagged snapshot
  // wrote one tab's autonomy over every other tab's picker.
  const snapshot = ctx.snapshot(sessionId);
  const scoped: Record<string, unknown> = {};
  const shared: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (SESSION_SCOPED_PREF_KEYS.has(key)) scoped[key] = value;
    else shared[key] = value;
  }
  if (Object.keys(shared).length > 0) {
    ctx.broadcast({ type: 'prefs.updated', payload: shared });
  }
  if (Object.keys(scoped).length > 0) {
    ctx.broadcast({
      type: 'prefs.updated',
      payload: sessionId ? { ...scoped, sessionId } : scoped,
    });
  }
}

export function handleAutonomySwitch(
  ctx: PrefsHandlerContext,
  ws: WebSocket,
  mode: string,
  sessionId?: string,
): void {
  // Autonomy is per-tab: a tab left running on `eternal` must not drag the
  // tab the user is typing in along with it.
  (ctx.metaFor?.(sessionId) ?? ctx.meta)['autonomy'] = mode;
  ctx.setAutonomy?.(mode);
  sendResult(ctx, ws, true, `Autonomy mode set to "${mode}"`);
  ctx.broadcast({
    type: 'prefs.updated',
    payload: { autonomy: mode, ...(sessionId ? { sessionId } : {}) },
  });
  void ctx.persist({ autonomy: mode });
}
