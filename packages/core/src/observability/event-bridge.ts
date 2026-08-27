import type { EventBus } from '../kernel/events.js';
import type { MetricsSink } from '../types/observability.js';

/** Per-tool usage record maintained by the event-bridge for the auto-thinning
 *  pipeline's in-process fallback. The Chronicle rollup is the cross-session
 *  source of truth; this Map only fills the gap when Chronicle is unavailable
 *  (no node:sqlite at runtime) or hasn't refreshed yet. */
export interface ToolUsageRecord {
  invocations: number;
  failures: number;
  durationMsTotal: number;
  lastInvokedAt: number;
  firstInvokedAt: number;
}

export type ToolUsageSnapshot = ReadonlyMap<string, ToolUsageRecord>;

/** The wireMetricsToEvents return value: the metrics sink plus the in-process
 *  tool-usage Map (read-only snapshot, updated in place by the listener), plus
 *  a `dispose()` that detaches every listener. */
export interface WiredMetricsHandle {
  sink: MetricsSink;
  getToolUsage(): ToolUsageSnapshot;
  dispose(): void;
}

/**
 * Subscribes a MetricsSink to the EventBus. Returns a handle with the sink
 * and a `getToolUsage()` accessor for the in-process per-tool usage Map.
 * This is the single integration point between the agent's event stream
 * and the observability layer — no metric calls leak into core call sites.
 */
export function wireMetricsToEvents(events: EventBus, sink: MetricsSink): WiredMetricsHandle {
  const unsubs: Array<() => void> = [];
  const toolUsage = new Map<string, ToolUsageRecord>();

  const record = (name: string, ok: boolean, durationMs: number): void => {
    const metricName = metricToolName(name);
    const now = Date.now();
    const existing = toolUsage.get(metricName);
    if (existing) {
      existing.invocations += 1;
      if (!ok) existing.failures += 1;
      existing.durationMsTotal += durationMs;
      existing.lastInvokedAt = now;
    } else {
      toolUsage.set(metricName, {
        invocations: 1,
        failures: ok ? 0 : 1,
        durationMsTotal: durationMs,
        lastInvokedAt: now,
        firstInvokedAt: now,
      });
    }
  };

  unsubs.push(
    events.on('session.started', () => sink.counter('agent.sessions.started')),
    events.on('session.ended', (e) => {
      sink.counter('agent.sessions.ended');
      sink.histogram('agent.session.tokens.input', e.usage.input);
      sink.histogram('agent.session.tokens.output', e.usage.output);
    }),
    events.on('session.damaged', () => sink.counter('agent.sessions.damaged')),
    events.on('iteration.completed', () => sink.counter('agent.iterations.total')),
    events.on('iteration.limit_reached', () => sink.counter('agent.iteration_limit.hit')),
    events.on('provider.response', (e) => {
      sink.counter('provider.responses.total', 1, { stop_reason: e.stopReason });
      sink.counter('provider.tokens.input', e.usage.input);
      sink.counter('provider.tokens.output', e.usage.output);
      if (e.usage.cacheRead) sink.counter('provider.tokens.cache_read', e.usage.cacheRead);
      if (e.usage.cacheWrite) sink.counter('provider.tokens.cache_write', e.usage.cacheWrite);
    }),
    events.on('provider.retry', (e) =>
      sink.counter('provider.retries.total', 1, {
        provider: e.providerId,
        status: String(e.status),
      }),
    ),
    events.on('provider.error', (e) =>
      sink.counter('provider.errors.total', 1, {
        provider: e.providerId,
        status: String(e.status),
        retryable: String(e.retryable),
      }),
    ),
    events.on('tool.started', (e) => {
      sink.counter('tool.starts.total', 1, { tool: metricToolName(e.name) });
      // `started` carries no durationMs; record as success-only so the
      // failure-rate and avg-duration histograms stay correct.
      record(e.name, true, 0);
    }),
    events.on('tool.executed', (e) => {
      const tool = metricToolName(e.name);
      sink.counter('tool.executions.total', 1, { tool, ok: String(e.ok) });
      sink.histogram('tool.duration_ms', e.durationMs, { tool });
      record(e.name, e.ok, e.durationMs);
    }),
    events.on('token.threshold', (e) => sink.gauge('agent.tokens.used', e.used)),
    events.on('compaction.fired', (e) => {
      sink.counter('compaction.fired.total');
      sink.histogram('compaction.reduction_tokens', e.report.before - e.report.after);
    }),
    // MCP server names are user-controlled and may contain tenant/project
    // identifiers. Keep them out of metric labels to bound cardinality and
    // prevent operational metadata leaks.
    events.on('mcp.server.connected', () => sink.counter('mcp.connects.total')),
    events.on('mcp.server.reconnected', () => sink.counter('mcp.reconnects.total')),
    events.on('mcp.server.disconnected', () => sink.counter('mcp.disconnects.total')),
    events.on('error', (e) => sink.counter('agent.errors.total', 1, { phase: e.phase })),
  );

  return {
    sink,
    getToolUsage(): ToolUsageSnapshot {
      return toolUsage;
    },
    dispose(): void {
      for (const u of unsubs) u();
    },
  };
}

function metricToolName(name: string): string {
  return name.startsWith('mcp__') ? 'mcp_proxy' : name;
}
