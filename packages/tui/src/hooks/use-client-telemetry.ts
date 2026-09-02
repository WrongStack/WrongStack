import { projectSlug } from '@wrongstack/core/utils';
import { type Dispatch, useEffect } from 'react';
import type { AppProps } from '../app-props.js';
import type { Action } from '../app-action-type.js';

interface ClientTelemetryOptions {
  events: AppProps['events'];
  clientId: AppProps['clientId'];
  tokenCounter: AppProps['tokenCounter'];
  getAutonomy: AppProps['getAutonomy'];
  agent: AppProps['agent'];
  registerDebugStreamCallback: AppProps['registerDebugStreamCallback'];
  restoreDebugStreamCallback: AppProps['restoreDebugStreamCallback'];
  dispatch: Dispatch<Action>;
}

/** Publishes client telemetry and bridges debug-stream samples into TUI state. */
export function useClientTelemetry({
  events,
  clientId,
  tokenCounter,
  getAutonomy,
  agent,
  registerDebugStreamCallback,
  restoreDebugStreamCallback,
  dispatch,
}: ClientTelemetryOptions): void {
  // ── Client status reporting ─────────────────────────────────────────────────
  // Emit client.status events to the EventBus so the WebUI and other clients
  // can display real-time stats. This drives the FleetHQ map HUD and the
  // JSON status file written by setup-events.ts.
  useEffect(() => {
    if (!clientId || !events) return;

    // Track cumulative stats for client.status events
    let toolCalls = 0;

    const emitStatus = (): void => {
      const usage = tokenCounter?.total();
      const cost = tokenCounter?.estimateCost();
      const mode = getAutonomy?.() ?? 'off';
      events.emit('client.status', {
        clientType: 'tui',
        clientId,
        sessionId: agent.ctx.session.id,
        projectHash: agent.ctx.projectRoot ? projectSlug(agent.ctx.projectRoot) : 'unknown',
        agentCount: 1, // TUI is a single leader agent
        model: agent.ctx.model,
        mode,
        toolCalls,
        inputTokens: usage?.input ?? 0,
        outputTokens: usage?.output ?? 0,
        cacheTokens: (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0),
        costUsd: cost?.total ?? 0,
        timestamp: Date.now(),
        projectSlug: agent.ctx.projectRoot ? projectSlug(agent.ctx.projectRoot) : 'unknown',
      });
    };

    const offTool = events.on('tool.executed', () => {
      toolCalls++;
      emitStatus();
    });

    const offProviderResp = events.on('provider.response', () => {
      emitStatus();
    });

    const offIterCompleted = events.on('iteration.completed', () => {
      emitStatus();
    });

    // Emit initial status
    emitStatus();

    return () => {
      offTool();
      offProviderResp();
      offIterCompleted();
    };
  }, [events, clientId, tokenCounter, getAutonomy, agent.ctx.model, agent.ctx.projectRoot]);

  // ── Debug-stream callback bridge ──
  // The CLI passes a registerDebugStreamCallback prop; this effect
  // installs it once on mount and tears it down on unmount.
  // The callback translates throttled DebugStreamStats from
  // stream-debug-state.ts into reducer dispatches so the stats render
  // inside Ink's StatusBar line 3 instead of bypassing the layout.
  useEffect(() => {
    if (!registerDebugStreamCallback) return;

    let cancelled = false;
    registerDebugStreamCallback((stats) => {
      if (cancelled) return;
      dispatch({
        type: 'debugStreamStats',
        chunkCount: stats.chunkCount,
        lastChunkSize: stats.lastChunkSize,
        lastDeltaMs: stats.lastDeltaMs,
        totalBytes: stats.totalBytes,
        lastChunkAt: stats.lastChunkAt,
      });
    });

    // Clear stats on every provider.response (per-iteration stream reset).
    const offResp = events.on('provider.response', () => {
      dispatch({ type: 'debugStreamStatsClear' });
    });
    const offErr = events.on('provider.error', () => {
      dispatch({ type: 'debugStreamStatsClear' });
    });

    return () => {
      cancelled = true;
      offResp();
      offErr();
      restoreDebugStreamCallback?.();
    };
  }, [events, registerDebugStreamCallback, restoreDebugStreamCallback]);
}
