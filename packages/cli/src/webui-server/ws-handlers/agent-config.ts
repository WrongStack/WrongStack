import {
  type Agent,
  enhanceUserPrompt,
  gatedEnhancerReasoning,
  type ModelsRegistry,
  type ModeStore,
  recentTextTurns,
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

export async function handleModelSwitch(
  ctx: AgentConfigContext,
  ws: WebSocket,
  payload: { provider: string; model: string },
): Promise<void> {
  const { provider: newProvider, model: newModel } = payload;
  try {
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
    const resolved = await ctx.modelsRegistry
      ?.getModel(catalogId, newModel)
      .catch(() => undefined);
    const maxContext = resolved?.capabilities.maxContext ?? actx.provider.capabilities.maxContext;
    actx.provider.capabilities.maxContext = maxContext;

    // Persist the new provider+model to config.json so the choice survives a
    // restart (the standalone server does this in its own model.switch handler).
    await ctx.persistPrefs?.({ provider: newProvider, model: newModel });

    sendResult(ctx, ws, true, `Switched to ${newProvider} / ${newModel}`);
    if (ctx.onMaxContextResolved) {
      ctx.onMaxContextResolved(newProvider, newModel, maxContext);
    } else {
      if (maxContext > 0) actx.meta['effectiveMaxContext'] = maxContext;
      else delete actx.meta['effectiveMaxContext'];
      ctx.broadcast({
        type: 'ctx.max_context',
        payload: { sessionId: actx.session.id, providerId: newProvider, modelId: newModel, maxContext },
      });
    }
    const payloadOut = await ctx.buildSessionStart();
    ctx.broadcast({ type: 'session.start', payload: payloadOut });
  } catch (err) {
    sendResult(ctx, ws, false, `Switch failed: ${toErrorMessage(err)}`);
  }
}

export async function handleModelRefine(
  ctx: AgentConfigContext,
  ws: WebSocket,
  text: string,
): Promise<void> {
  if (!text?.trim()) {
    ctx.send(ws, {
      type: 'model.refine_result',
      payload: { refined: '', english: '', error: 'Empty text' },
    });
    return;
  }
  try {
    const actx = ctx.agent.ctx;
    const history = recentTextTurns(actx.messages);
    // Gate a low-effort reasoning hint to the active model so the refiner does
    // not waste thinking on this shallow rewrite. Resolves to undefined (→ no
    // reasoning field, unchanged behavior) when the registry is absent, the
    // lookup fails, or the model can't safely reduce reasoning.
    const resolved = await ctx.modelsRegistry
      ?.getModel((actx.provider as { id: string }).id, actx.model)
      .catch(() => undefined);
    const reasoning = gatedEnhancerReasoning(resolved?.capabilities.reasoningConfig);
    const result = await enhanceUserPrompt({
      provider: actx.provider,
      model: actx.model,
      text,
      history,
      timeoutMs: 90000,
      ...(reasoning ? { reasoning } : {}),
      onError: (reason) => {
        ctx.log(
          JSON.stringify({
            level: 'warn',
            event: 'model.refine_failed',
            reason,
            timestamp: new Date().toISOString(),
          }),
        );
      },
    });
    if (result) {
      ctx.send(ws, {
        type: 'model.refine_result',
        payload: { refined: result.refined, english: result.english },
      });
    } else {
      ctx.send(ws, {
        type: 'model.refine_result',
        payload: { refined: text, english: text, error: 'Refinement returned no result' },
      });
    }
  } catch (err) {
    ctx.send(ws, {
      type: 'model.refine_result',
      payload: {
        refined: text,
        english: text,
        error: toErrorMessage(err),
      },
    });
  }
}
