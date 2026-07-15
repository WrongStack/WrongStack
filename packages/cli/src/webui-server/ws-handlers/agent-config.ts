import {
  type Agent,
  type Config,
  type EnhanceFailureKind,
  enhanceUserPrompt,
  gatedEnhancerReasoning,
  type ModelsRegistry,
  type ModeStore,
  nextEnhanceTimeout,
  type Provider,
  recentTextTurns,
  resolveEnhanceFallbackRef,
  ToolValidationError,
} from '@wrongstack/core';
import { toErrorMessage } from '@wrongstack/core/utils';
import { makeProviderFromConfig } from '@wrongstack/providers';
import type { WebSocket } from 'ws';
import { loadSavedProviders } from '../provider-config.js';
import type { WsCommon } from './index.js';

/**
 * PR 5e of Issue #30: agent-configuration WebSocket handlers —
 * `modes.list` / `mode.switch` (agent mode) and `model.switch` /
 * `model.refine` (provider+model). The first three re-broadcast a fresh
 * `session.start` so every browser tab reflects the change.
 *
 * The session.start payload is built by `runWebUI`'s closure
 * (`buildSessionStartPayload`, which reads a large amount of run state);
 * it's threaded in here as the `buildSessionStart` callback rather than
 * reconstructed. The other former captures (`opts.modeStore`,
 * `opts.agent`, `opts.globalConfigPath`) are `AgentConfigContext` fields.
 */

export interface AgentConfigContext extends WsCommon {
  /** The running agent — mode/model/provider live on its ctx. */
  agent: Agent;
  /** Mode store backing modes.list / mode.switch (optional). */
  modeStore: ModeStore | undefined;
  /** Global config path — model.switch reads saved provider configs from it. */
  globalConfigPath: string | undefined;
  /** Build the session.start payload (runWebUI's closure), broadcast on a config change. */
  buildSessionStart: (overrides?: Record<string, unknown>) => Promise<unknown>;
  /**
   * Models registry, used to look up the active model's reasoning capabilities
   * so the prompt refiner can send a gated low-effort hint. Optional — when
   * absent the refiner sends no reasoning field (unchanged behavior).
   */
  modelsRegistry?: ModelsRegistry | undefined;
  /**
   * Live app config accessor — used by the refine handler to resolve the
   * one-key "retry with another model" fallback ref (see
   * `resolveEnhanceFallbackRef`). Optional: when absent no fallback ref is
   * offered (the user can still pick a model explicitly).
   */
  getConfig?: (() => Config | undefined) | undefined;
  onMaxContextResolved?:
    | ((providerId: string, modelId: string, maxContext: number) => void)
    | undefined;
  /**
   * Persist durable keys to config.json (runWebUI's createPrefsSeeding closure).
   * Used by model.switch to write the new provider+model so the choice survives
   * restart — parity with the standalone server. Optional: when absent the
   * switch still applies live, it just doesn't persist.
   */
  persistPrefs?: ((payload: Record<string, unknown>) => Promise<void>) | undefined;
}

function sendResult(ctx: WsCommon, ws: WebSocket, success: boolean, message: string): void {
  ctx.send(ws, { type: 'key.operation_result', payload: { success, message } });
}

export async function handleModesList(ctx: AgentConfigContext, ws: WebSocket): Promise<void> {
  if (!ctx.modeStore) {
    ctx.send(ws, {
      type: 'modes.list',
      payload: { modes: [], activeId: 'default', error: 'Mode store not available' },
    });
    return;
  }
  try {
    const modes = await ctx.modeStore.listModes();
    const active = await ctx.modeStore.getActiveMode();
    ctx.send(ws, {
      type: 'modes.list',
      payload: {
        modes: modes.map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          isActive: m.id === (active?.id ?? 'default'),
        })),
        activeId: active?.id ?? 'default',
      },
    });
  } catch (err) {
    ctx.send(ws, {
      type: 'modes.list',
      payload: {
        modes: [],
        activeId: 'default',
        error: toErrorMessage(err),
      },
    });
  }
}

export async function handleModeSwitch(
  ctx: AgentConfigContext,
  ws: WebSocket,
  id: string,
): Promise<void> {
  if (!ctx.modeStore) {
    sendResult(ctx, ws, false, 'Mode store not available');
    return;
  }
  try {
    if (id === 'default') {
      await ctx.modeStore.setActiveMode(null);
    } else {
      const found = await ctx.modeStore.getMode(id);
      if (!found) {
        throw new ToolValidationError({
          message: `Unknown mode "${id}"`,
          field: 'modeId',
          context: { requestedMode: id, kind: 'mode.switch' },
        });
      }
      await ctx.modeStore.setActiveMode(id);
    }
    // Store the mode in context.meta so the agent sees it on the next turn.
    ctx.agent.ctx.meta['mode'] = id;
    sendResult(ctx, ws, true, `Switched to mode "${id}"`);
    const payload = await ctx.buildSessionStart({ mode: id });
    ctx.broadcast({ type: 'session.start', payload });
  } catch (err) {
    sendResult(ctx, ws, false, toErrorMessage(err));
  }
}

/**
 * Apply a provider+model switch to the live agent: rebuild the provider from
 * saved config, resolve the model's maxContext, persist the choice, and
 * broadcast a fresh `session.start`. Shared by the `model.switch` handler and
 * the "adopt on first provider add" path so both mutate the agent identically.
 * Throws on provider-construction failure (the caller decides how to report).
 */
export async function applyModelSwitch(
  ctx: AgentConfigContext,
  newProvider: string,
  newModel: string,
): Promise<void> {
  const actx = ctx.agent.ctx;
  actx.model = newModel;

  // Create a new provider instance from the saved config.
  const saved = await loadSavedProviders(ctx.globalConfigPath);
  const providerCfg = saved[newProvider] ?? { type: newProvider };
  actx.provider = makeProviderFromConfig(newProvider, providerCfg);
  await ctx.modelsRegistry?.refresh().catch((err) => {
    ctx.log(
      JSON.stringify({
        level: 'warn',
        event: 'models.refresh_failed',
        provider: newProvider,
        model: newModel,
        message: toErrorMessage(err),
        timestamp: new Date().toISOString(),
      }),
    );
  });
  const catalogId =
    providerCfg.type && providerCfg.type !== newProvider ? providerCfg.type : newProvider;
  const resolved = await ctx.modelsRegistry?.getModel(catalogId, newModel).catch(() => undefined);
  const maxContext = resolved?.capabilities.maxContext ?? actx.provider.capabilities.maxContext;
  actx.provider.capabilities.maxContext = maxContext;

  // Persist the new provider+model to config.json so the choice survives a
  // restart (the standalone server does this in its own model.switch handler).
  await ctx.persistPrefs?.({ provider: newProvider, model: newModel });

  if (ctx.onMaxContextResolved) {
    ctx.onMaxContextResolved(newProvider, newModel, maxContext);
  } else {
    if (maxContext > 0) actx.meta['effectiveMaxContext'] = maxContext;
    else delete actx.meta['effectiveMaxContext'];
    ctx.broadcast({
      type: 'ctx.max_context',
      payload: {
        sessionId: actx.session.id,
        providerId: newProvider,
        modelId: newModel,
        maxContext,
      },
    });
  }
  const payloadOut = await ctx.buildSessionStart();
  ctx.broadcast({ type: 'session.start', payload: payloadOut });
}

export async function handleModelSwitch(
  ctx: AgentConfigContext,
  ws: WebSocket,
  payload: { provider: string; model: string },
): Promise<void> {
  const { provider: newProvider, model: newModel } = payload;
  try {
    await applyModelSwitch(ctx, newProvider, newModel);
    sendResult(ctx, ws, true, `Switched to ${newProvider} / ${newModel}`);
  } catch (err) {
    sendResult(ctx, ws, false, `Switch failed: ${toErrorMessage(err)}`);
  }
}

/**
 * Build a provider for `providerId` from saved config WITHOUT mutating the
 * live agent — used to refine on a user-picked model ("retry with another
 * model") while leaving the session's own provider/model untouched.
 */
async function buildEphemeralProvider(
  ctx: AgentConfigContext,
  providerId: string,
): Promise<Provider> {
  const saved = await loadSavedProviders(ctx.globalConfigPath);
  const providerCfg = saved[providerId] ?? { type: providerId };
  return makeProviderFromConfig(providerId, providerCfg);
}

export interface ModelRefinePayload {
  text: string;
  /** Retry window override (ms) — set on the auto-retry after a timeout. */
  timeoutMs?: number | undefined;
  /** Refine on this provider/model instead of the session's (ephemeral). */
  provider?: string | undefined;
  model?: string | undefined;
}

export async function handleModelRefine(
  ctx: AgentConfigContext,
  ws: WebSocket,
  payload: ModelRefinePayload,
): Promise<void> {
  const { text } = payload;
  if (!text?.trim()) {
    ctx.send(ws, {
      type: 'model.refine_result',
      payload: { refined: '', english: '', error: 'Empty text', errorKind: 'provider_error' },
    });
    return;
  }
  const actx = ctx.agent.ctx;
  const cfg = ctx.getConfig?.();
  // Compute the one-key fallback ref against the LIVE provider/model so the
  // active model is never offered as its own fallback.
  const liveProviderId = (actx.provider as { id: string }).id;
  const fallbackRef =
    cfg !== undefined
      ? resolveEnhanceFallbackRef({ ...cfg, provider: liveProviderId, model: actx.model })
      : undefined;

  // When the client picked another provider/model, refine ephemerally on it;
  // otherwise use the live session provider/model.
  let provider = actx.provider;
  let providerId = liveProviderId;
  let model = actx.model;
  if (payload.provider && payload.model) {
    try {
      provider = await buildEphemeralProvider(ctx, payload.provider);
      providerId = payload.provider;
      model = payload.model;
    } catch (err) {
      ctx.send(ws, {
        type: 'model.refine_result',
        payload: {
          refined: text,
          english: text,
          error: `Cannot use ${payload.provider}/${payload.model}: ${toErrorMessage(err)}`,
          errorKind: 'provider_error',
          ...(fallbackRef ? { fallbackRef } : {}),
        },
      });
      return;
    }
  }

  const baseTimeout = 90000;
  const timeoutMs =
    typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0
      ? payload.timeoutMs
      : baseTimeout;
  try {
    const history = recentTextTurns(actx.messages);
    // Gate a low-effort reasoning hint to the chosen model so the refiner does
    // not waste thinking on this shallow rewrite. Resolves to undefined (→ no
    // reasoning field, unchanged behavior) when the registry is absent, the
    // lookup fails, or the model can't safely reduce reasoning.
    const resolved = await ctx.modelsRegistry?.getModel(providerId, model).catch(() => undefined);
    const reasoning = gatedEnhancerReasoning(resolved?.capabilities.reasoningConfig);
    let failureKind: EnhanceFailureKind | undefined;
    const result = await enhanceUserPrompt({
      provider,
      model,
      text,
      history,
      timeoutMs,
      ...(reasoning ? { reasoning } : {}),
      onError: (reason, kind) => {
        failureKind = kind;
        ctx.log(
          JSON.stringify({
            level: 'warn',
            event: 'model.refine_failed',
            reason,
            kind,
            provider: providerId,
            model,
            timestamp: new Date().toISOString(),
          }),
        );
      },
    });
    if (result) {
      ctx.send(ws, {
        type: 'model.refine_result',
        payload: {
          refined: result.refined,
          english: result.english,
          refinedWith: { provider: providerId, model },
        },
      });
    } else {
      ctx.send(ws, {
        type: 'model.refine_result',
        payload: {
          refined: text,
          english: text,
          error: 'Refinement returned no result',
          errorKind: failureKind ?? 'empty',
          ...(failureKind === 'timeout'
            ? { retryTimeoutMs: nextEnhanceTimeout(timeoutMs, cfg?.autonomy) }
            : {}),
          ...(fallbackRef ? { fallbackRef } : {}),
        },
      });
    }
  } catch (err) {
    ctx.send(ws, {
      type: 'model.refine_result',
      payload: {
        refined: text,
        english: text,
        error: toErrorMessage(err),
        errorKind: 'provider_error',
        ...(fallbackRef ? { fallbackRef } : {}),
      },
    });
  }
}
