import { type Agent, enhanceUserPrompt, type ModeStore, recentTextTurns } from '@wrongstack/core';
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
        error: err instanceof Error ? err.message : String(err),
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
      if (!found) throw new Error(`Unknown mode "${id}"`);
      await ctx.modeStore.setActiveMode(id);
    }
    // Store the mode in context.meta so the agent sees it on the next turn.
    ctx.agent.ctx.meta['mode'] = id;
    sendResult(ctx, ws, true, `Switched to mode "${id}"`);
    const payload = await ctx.buildSessionStart({ mode: id });
    ctx.broadcast({ type: 'session.start', payload });
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
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

    sendResult(ctx, ws, true, `Switched to ${newProvider} / ${newModel}`);
    const payloadOut = await ctx.buildSessionStart();
    ctx.broadcast({ type: 'session.start', payload: payloadOut });
  } catch (err) {
    sendResult(
      ctx,
      ws,
      false,
      `Switch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
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
    const result = await enhanceUserPrompt({
      provider: actx.provider,
      model: actx.model,
      text,
      history,
      timeoutMs: 90000,
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
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
