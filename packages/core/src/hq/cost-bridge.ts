/**
 * CostTelemetryBridge — forwards local token/cost accounting events to the
 * HQ publisher as `session.usage` envelopes, giving the command center the
 * granular per-call cost signal it needs to render live cost trends and
 * roll-ups across every connected machine.
 *
 * Source: the `token.accounted` EventBus event, emitted by the TokenCounter
 * (`infrastructure/token-counter.ts`) after every provider call. The payload
 * is plain serializable data (usage counts + a cost breakdown, plus the
 * provider/model that priced it and cache token counts) — no closures.
 *
 * This is the high-frequency cost feed; HQ's persistence layer time-buckets
 * these into trend series (per-bucket totals + per-model/per-provider
 * breakdowns).
 *
 * @module hq/cost-bridge
 */
import type { EventBus } from '../kernel/events.js';
import { effectiveInputTokens, type Usage } from '../types/provider.js';
import { type BridgeContextOptions, createBridgeContext } from './bridge-context.js';
import type { HqEventEnvelope, HqUsagePayload } from './protocol.js';

export interface CostTelemetryBridgeOptions extends BridgeContextOptions {
  /** Local EventBus emitting `token.accounted`. */
  events: EventBus;
}

interface TokenAccountedEvent {
  sessionId?: string | undefined;
  usage: Usage;
  deltaUsage?: Usage | undefined;
  cost: { input: number; output: number; total: number };
  /** Provider id that produced this usage (e.g. 'anthropic'), when known. */
  provider?: string | undefined;
  /** Model id the cost was priced against, when known. */
  model?: string | undefined;
}

/**
 * Start forwarding token/cost events to HQ. Returns a disposer that
 * unsubscribes the listener — call on shutdown.
 */
export function startCostTelemetryBridge(opts: CostTelemetryBridgeOptions): () => void {
  const { events } = opts;
  const ctx = createBridgeContext(opts);

  const off = events.on('token.accounted', (p: TokenAccountedEvent) => {
    const usage = p.deltaUsage ?? p.usage;
    const totalPromptTokens = effectiveInputTokens(usage);
    const payload: HqUsagePayload = {
      inputTokens: totalPromptTokens,
      outputTokens: usage.output,
      totalTokens: totalPromptTokens + usage.output,
      costUsd: p.cost.total,
    };
    // Forward the dimensions HQ needs for per-model/per-provider cost charts
    // and cache-hit-ratio cards. All optional — older counters omit them.
    if (p.provider !== undefined) payload.provider = p.provider;
    if (p.model !== undefined) payload.model = p.model;
    if (usage.cacheRead !== undefined) payload.cacheRead = usage.cacheRead;
    if (usage.cacheWrite !== undefined) payload.cacheWrite = usage.cacheWrite;
    const sessionId = opts.sessionId ?? p.sessionId;
    ctx.safePublish({
      type: 'session.usage',
      payload,
      ...(sessionId !== undefined ? { sessionId } : {}),
      timestamp: ctx.now(),
    });
  });

  ctx.track(off);
  return ctx.dispose;
}

/** Re-export for type-only consumers. */
export type { HqEventEnvelope };
