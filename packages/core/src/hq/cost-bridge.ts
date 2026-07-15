/**
 * CostTelemetryBridge — forwards local token/cost accounting events to the HQ
 * publisher as `session.usage` envelopes, giving the command center the
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
import type { Usage } from '../types/provider.js';
import type { HqEventEnvelope, HqUsagePayload } from './protocol.js';
import type { HqPublisher } from './publisher.js';

export interface CostTelemetryBridgeOptions {
  /** Local EventBus emitting `token.accounted`. */
  events: EventBus;
  /** HQ publisher to forward envelopes to. */
  publisher: HqPublisher;
  /** Optional sessionId to tag envelopes with (overrides the event's, when set). */
  sessionId?: string;
  /** Override `now()` for deterministic tests. */
  now?: () => string;
}

interface TokenAccountedEvent {
  sessionId?: string | undefined;
  usage: Usage;
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
  const { events, publisher } = opts;
  const now = opts.now ?? (() => new Date().toISOString());

  const off = events.on('token.accounted', (p: TokenAccountedEvent) => {
    try {
      const payload: HqUsagePayload = {
        inputTokens: p.usage.input,
        outputTokens: p.usage.output,
        totalTokens: p.usage.input + p.usage.output,
        costUsd: p.cost.total,
      };
      // Forward the dimensions HQ needs for per-model/per-provider cost charts
      // and cache-hit-ratio cards. All optional — older counters omit them.
      if (p.provider !== undefined) payload.provider = p.provider;
      if (p.model !== undefined) payload.model = p.model;
      if (p.usage.cacheRead !== undefined) payload.cacheRead = p.usage.cacheRead;
      if (p.usage.cacheWrite !== undefined) payload.cacheWrite = p.usage.cacheWrite;
      const sessionId = opts.sessionId ?? p.sessionId;
      publisher.publishEvent({
        type: 'session.usage',
        payload,
        ...(sessionId !== undefined ? { sessionId } : {}),
        timestamp: now(),
      });
    } catch {
      /* best-effort */
    }
  });

  return () => {
    off();
  };
}

/** Re-export for type-only consumers. */
export type { HqEventEnvelope };
