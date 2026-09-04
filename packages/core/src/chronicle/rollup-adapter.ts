import { createHash } from 'node:crypto';
import type { EventBus } from '../kernel/events.js';
import type { ChronicleContext } from './context.js';
import type { ChronicleEventSink } from './sink.js';
import type { ChronicleEventInput } from './types.js';

export interface ChronicleRollupAdapterOptions {
  events: EventBus;
  journal: ChronicleEventSink;
  context: ChronicleContext | (() => ChronicleContext);
  windowMs?: number;
  /** Aggregation window for periodic gauges; see {@link DEFAULT_GAUGE_WINDOW_MS}. */
  gaugeWindowMs?: number;
  onPersistError?: ((error: unknown, event: ChronicleEventInput) => void) | undefined;
}
interface Bucket {
  signal: string;
  sessionId?: string;
  agentId?: string;
  toolCallId?: string;
  logicalRequestId?: string;
  dimensions: Record<string, string>;
  startedAt: number;
  updatedAt: number;
  count: number;
  /**
   * Set on periodic gauges: flush once the bucket reaches this age, rather than
   * once it has been idle for `windowMs`. See {@link DEFAULT_GAUGE_WINDOW_MS}.
   */
  aggregateMs?: number;
  metrics: Record<string, { sum: number; min: number; max: number; last: number }>;
  categories: Record<string, number>;
  /** Distinct resources touched (tool.resource rollups only) — id-keyed so kind/path survive. */
  resources: Map<string, { kind: string; path?: string }>;
}

const MAX_ROLLUP_RESOURCES = 100;

/**
 * Window for signals that arrive on a fixed cadence rather than in bursts.
 *
 * Burst signals are flushed by an idle rule — a bucket that has not been touched
 * for `windowMs` is done, because the burst that fed it has ended. A periodic
 * gauge never satisfies that rule usefully: `runtime.health` samples every 30 s
 * against a 10 s window, so every bucket went idle between samples and flushed
 * carrying exactly one. The layer whose job is to compress was inflating instead,
 * writing `{sum,min,max,last,avg}` — the same number five times — per metric per
 * sample. Measured at 12.7 MB, 8.4% of the whole journal, for 5 971 rollups that
 * each aggregated nothing.
 *
 * Lengthening `windowMs` alone would not fix it and would in fact be worse: the
 * idle rule reads `updatedAt`, which a live gauge keeps pushing forward, so the
 * bucket would never flush at all and would grow without bound. Gauges therefore
 * flush on *age* instead — `startedAt` does not move — which is what lets several
 * samples land in one aggregate and makes min/max/avg mean something.
 *
 * The cost is freshness: a consumer reading the newest gauge rollup sees a value
 * up to one window old. The only such consumer is the WebUI health tile
 * (`ChronicleDashboard.tsx`), which reads `.last` off the most recent rollup.
 */
const DEFAULT_GAUGE_WINDOW_MS = 120_000;

/** Converts high-frequency ephemeral signals into bounded window aggregates before persistence. */
export function wireRollupsToChronicle(options: ChronicleRollupAdapterOptions): () => void {
  const buckets = new Map<string, Bucket>();
  const windowMs = Math.max(1_000, options.windowMs ?? 10_000);
  // Never below the burst window: a gauge window shorter than the tick that
  // checks it would just reproduce the one-sample-per-rollup behaviour.
  const gaugeWindowMs = Math.max(windowMs, options.gaugeWindowMs ?? DEFAULT_GAUGE_WINDOW_MS);
  const bucket = (
    key: string,
    seed: Omit<
      Bucket,
      'startedAt' | 'updatedAt' | 'count' | 'metrics' | 'categories' | 'resources'
    >,
  ) => {
    let value = buckets.get(key);
    if (!value) {
      const now = Date.now();
      value = {
        ...seed,
        startedAt: now,
        updatedAt: now,
        count: 0,
        metrics: {},
        categories: {},
        resources: new Map(),
      };
      buckets.set(key, value);
    }
    return value;
  };
  const sample = (target: Bucket, values: Record<string, number>, category?: string) => {
    target.count++;
    target.updatedAt = Date.now();
    for (const [name, value] of Object.entries(values)) {
      const metric = target.metrics[name];
      target.metrics[name] = metric
        ? {
            sum: metric.sum + value,
            min: Math.min(metric.min, value),
            max: Math.max(metric.max, value),
            last: value,
          }
        : { sum: value, min: value, max: value, last: value };
    }
    if (category) target.categories[category] = (target.categories[category] ?? 0) + 1;
  };
  const flush = (key: string) => {
    const value = buckets.get(key);
    if (!value || value.count === 0) return;
    buckets.delete(key);
    const context = typeof options.context === 'function' ? options.context() : options.context;
    // A metric that never varied within the window is three copies of one
    // number plus a total: drop `min` and `max`, which say nothing `last` does
    // not, and drop `avg` unconditionally because it is `sum / samples` and no
    // reader in the repo has ever asked for it. `sum` always survives -- it is
    // the one field a collapsed form could not reconstruct, since a window of
    // four identical samples has a total four times its `last`.
    //
    // Measured: 38-66% of rollups per signal aggregate a single sample, so the
    // collapsed shape is the common one, not the exception. Both shapes expose
    // `stats[name].last`, which is what ChronicleDashboard.tsx reads.
    const stats = Object.fromEntries(
      Object.entries(value.metrics).map(([name, metric]) => [
        name,
        metric.min === metric.max && metric.max === metric.last
          ? { sum: metric.sum, last: metric.last }
          : metric,
      ]),
    );
    const resources =
      value.resources.size > 0
        ? [...value.resources]
            .slice(0, MAX_ROLLUP_RESOURCES)
            .map(([id, r]) => ({ id, kind: r.kind, ...(r.path ? { path: r.path } : {}) }))
        : undefined;
    const input: ChronicleEventInput = {
      eventType: 'metrics.rollup',
      outcome: 'success',
      occurredAt: new Date(value.updatedAt).toISOString(),
      scope: {
        ...context.scope,
        ...(value.sessionId ? { sessionId: value.sessionId } : {}),
        ...(value.agentId ? { agentId: value.agentId } : {}),
      },
      correlation: {
        ...context.correlation,
        ...(value.logicalRequestId ? { logicalRequestId: value.logicalRequestId } : {}),
        ...(value.toolCallId ? { toolCallId: value.toolCallId } : {}),
      },
      durationNs: String(Math.max(0, value.updatedAt - value.startedAt) * 1_000_000),
      attributes: {
        signal: value.signal,
        windowStart: new Date(value.startedAt).toISOString(),
        windowEnd: new Date(value.updatedAt).toISOString(),
        samples: value.count,
        dimensions: value.dimensions,
        stats,
        categories: value.categories,
        ...(resources ? { resources, resourceCount: value.resources.size } : {}),
      },
    };
    void options.journal.append(input).catch((error) => options.onPersistError?.(error, input));
  };
  const gauge = (signal: string, event: Record<string, unknown>, dimension?: string) => {
    const sessionId = text(event.sessionId);
    const dimensionValue = dimension ? text(event[dimension]) : undefined;
    const key = `${signal}\0${sessionId ?? ''}\0${dimensionValue ?? ''}`;
    const target = bucket(key, {
      signal,
      aggregateMs: gaugeWindowMs,
      ...(sessionId ? { sessionId } : {}),
      ...(dimensionValue ? { agentId: dimensionValue } : {}),
      dimensions: dimensionValue && dimension ? { [dimension]: dimensionValue } : {},
    });
    sample(
      target,
      Object.fromEntries(
        Object.entries(event).filter(([, value]) => typeof value === 'number'),
      ) as Record<string, number>,
    );
  };
  const offs = [
    options.events.on('process.output', (event) => {
      const key = `process.output\0${event.sessionId}\0${event.toolCallId}\0${event.pid ?? ''}\0${event.stream}`;
      const target = bucket(key, {
        signal: 'process.output',
        sessionId: event.sessionId,
        ...(event.agentId ? { agentId: event.agentId } : {}),
        toolCallId: event.toolCallId,
        dimensions: {
          stream: event.stream,
          toolName: event.toolName,
          pid: String(event.pid ?? ''),
        },
      });
      sample(target, { bytes: event.bytes }, event.stream);
    }),
    options.events.on('process.completed', (event) => {
      for (const key of [...buckets.keys()])
        if (key.startsWith(`process.output\0${event.sessionId}\0${event.toolCallId}\0`)) flush(key);
    }),
    options.events.on('tool.progress', (event) => {
      if (event.event.type === 'file_changed') return;
      const key = `tool.progress\0${event.sessionId ?? ''}\0${event.id}`;
      const target = bucket(key, {
        signal: 'tool.progress',
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...(event.agentId ? { agentId: event.agentId } : {}),
        toolCallId: event.id,
        dimensions: { toolName: event.name },
      });
      sample(target, { textBytes: Buffer.byteLength(event.event.text ?? '') }, event.event.type);
    }),
    options.events.on('tool.executed', (event) => {
      flush(`tool.progress\0${event.sessionId ?? ''}\0${event.id ?? ''}`);
      // Resources a leader-level tool call touched (files read/grepped,
      // symbols, commands) — one bounded rollup instead of one raw
      // tool.resource.observed event per resource. Subagent calls never
      // carry this metadata (see host-event-bridge.ts), so nothing here.
      const metadata = event.metadata;
      if (
        !metadata ||
        (metadata.files.length === 0 &&
          metadata.symbols.length === 0 &&
          metadata.commands.length === 0)
      )
        return;
      // Keyed on the logical request, not the tool call, and left for the idle
      // sweep instead of being flushed here. Keying on `event.id` made every
      // bucket a bucket of one: an agent turn that greps six files wrote six
      // rollups whose envelope — scope, correlation, the two chain hashes,
      // window bounds — cost more than the resource lists they carried.
      // Measured at 7.1 MB and 38% single-sample, the largest single line item
      // in the journal. One turn now shares one aggregate, and `resources` is
      // already deduped by id so re-reading a file within the turn is free.
      const key = `tool.resource\0${event.sessionId ?? ''}\0${event.logicalRequestId ?? event.id ?? ''}`;
      const target = bucket(key, {
        signal: 'tool.resource.observed',
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...(event.agentId ? { agentId: event.agentId } : {}),
        ...(event.logicalRequestId ? { logicalRequestId: event.logicalRequestId } : {}),
        // Which tools contributed is counted per name in `categories` below; a
        // merged bucket spans several calls, so a single `toolName` dimension
        // would name only whichever call happened to open it.
        dimensions: {},
      });
      target.categories[`tool:${event.name}`] = (target.categories[`tool:${event.name}`] ?? 0) + 1;
      for (const file of metadata.files) {
        target.resources.set(resourceId('file', file), { kind: 'file', path: file });
        sample(target, {}, 'file');
      }
      for (const symbol of metadata.symbols) {
        target.resources.set(resourceId('symbol', symbol), { kind: 'symbol' });
        sample(target, {}, 'symbol');
      }
      for (const command of metadata.commands) {
        target.resources.set(resourceId('command', command), { kind: 'process' });
        sample(target, {}, 'command');
      }
    }),
    options.events.on('tool.failed', (event) =>
      flush(`tool.progress\0${event.sessionId}\0${event.id}`),
    ),
    options.events.on('ctx.pct', (event) => gauge('ctx.pct', event)),
    options.events.on('subagent.ctx_pct', (event) =>
      gauge('subagent.ctx_pct', event, 'subagentId'),
    ),
    options.events.on('countdown.tick', (event) => gauge('countdown.tick', event)),
    options.events.on('coordinator.stats', (event) => gauge('coordinator.stats', event)),
    // Periodic self-observation gauge (nested fields, so the flat gauge()
    // helper can't be reused directly — flatten before sampling).
    options.events.on('runtime.health.sampled', (event) => {
      const key = `runtime.health\0${event.sessionId ?? ''}`;
      const target = bucket(key, {
        signal: 'runtime.health',
        aggregateMs: gaugeWindowMs,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        dimensions: {},
      });
      const chronicle = event.chronicle as
        | { pendingEvents?: unknown; rejectedEvents?: unknown }
        | undefined;
      sample(target, {
        'eventLoop.utilization': event.eventLoop.utilization,
        'eventLoop.delayMeanMs': event.eventLoop.delayMeanMs,
        'eventLoop.delayP95Ms': event.eventLoop.delayP95Ms,
        'eventLoop.delayMaxMs': event.eventLoop.delayMaxMs,
        'cpu.userMicros': event.cpu.userMicros,
        'cpu.systemMicros': event.cpu.systemMicros,
        'memory.rssBytes': event.memory.rssBytes,
        'memory.heapUsedBytes': event.memory.heapUsedBytes,
        'memory.heapTotalBytes': event.memory.heapTotalBytes,
        ...(typeof chronicle?.pendingEvents === 'number'
          ? { 'chronicle.pendingEvents': chronicle.pendingEvents }
          : {}),
        ...(typeof chronicle?.rejectedEvents === 'number'
          ? { 'chronicle.rejectedEvents': chronicle.rejectedEvents }
          : {}),
      });
    }),
    // Full-fleet snapshots fired on every agent-state flush (~14KB each) are
    // reduced to one windowed aggregate per session; the raw event is excluded
    // from the domain adapter. Sums preserve the fleet-level metric trail.
    options.events.on('session.agents_updated', (event) => {
      const key = `session.agents\0${event.sessionId ?? ''}`;
      const target = bucket(key, {
        signal: 'session.agents',
        aggregateMs: gaugeWindowMs,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        dimensions: {},
      });
      const sums = {
        agents: 0,
        running: 0,
        iterations: 0,
        toolCalls: 0,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
      };
      for (const agent of event.agents) {
        sums.agents++;
        if (agent.status === 'running') sums.running++;
        sums.iterations += numeric(agent.iterations);
        sums.toolCalls += numeric(agent.toolCalls);
        sums.costUsd += numeric(agent.costUsd);
        sums.tokensIn += numeric(agent.tokensIn);
        sums.tokensOut += numeric(agent.tokensOut);
      }
      sample(target, sums);
    }),
    // Per-request network chatter (started/completed pairs were the 2nd most
    // frequent raw family) becomes one aggregate per session×initiator×host
    // window with status-class categories. network.request.failed stays raw.
    options.events.on('network.request.completed', (event) => {
      const key = `network.request\0${event.sessionId}\0${event.initiator}\0${event.serverAddress}`;
      const target = bucket(key, {
        signal: 'network.request',
        // Age-based, like the gauges: requests to one host trickle in over a
        // turn rather than arriving as a burst, so the idle rule closed 53% of
        // these buckets holding a single request. `startedAt` does not move,
        // so a window genuinely spans the period it names.
        aggregateMs: gaugeWindowMs,
        sessionId: event.sessionId,
        dimensions: { initiator: event.initiator, serverAddress: event.serverAddress },
      });
      sample(
        target,
        {
          durationMs: event.durationMs,
          ...(event.requestBytes !== undefined ? { requestBytes: event.requestBytes } : {}),
          ...(event.responseBytes !== undefined ? { responseBytes: event.responseBytes } : {}),
        },
        `${Math.floor(event.statusCode / 100)}xx`,
      );
    }),
  ];
  // Burst buckets are done when they go quiet; gauge buckets are done when the
  // window has elapsed, because a live gauge keeps pushing `updatedAt` forward
  // and would otherwise never be collected at all.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of buckets) {
      const due =
        value.aggregateMs === undefined
          ? value.updatedAt <= now - windowMs
          : value.startedAt <= now - value.aggregateMs;
      if (due) flush(key);
    }
  }, windowMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    for (const key of [...buckets.keys()]) flush(key);
    offs.forEach((off) => {
      off();
    });
  };
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
/** Matches tool-adapter.ts's scheme exactly so a resource observed here and
 *  one mutated via file.mutation.observed resolve to the same graph node. */
function resourceId(kind: string, value: string): string {
  return `${kind}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}
