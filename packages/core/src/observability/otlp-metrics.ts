import type { MetricSeries, MetricsSink } from '../types/observability.js';

/**
 * V2-A: OTLP/JSON metrics push exporter.
 *
 * Periodically POSTs `MetricsSink.snapshot()` to an OTLP HTTP receiver
 * (the OpenTelemetry Collector, vendor agents like Honeycomb, Datadog,
 * Grafana Cloud, etc.). The wire format is OTLP/JSON v1.0 — covered by
 * the spec at github.com/open-telemetry/opentelemetry-proto.
 *
 * Why no `@opentelemetry/*` dep: the core graph is intentionally
 * dependency-free. The JSON shape is well-defined and stable; bringing
 * in the official SDK would add ~3MB and pin us to its release cadence.
 * Operators who need the OTLP gRPC transport or vendor-specific quirks
 * can wrap an `@opentelemetry/exporter-metrics-otlp-grpc` in a custom
 * `MetricsSink` instead — the seam exists.
 */

export interface OtlpMetricsExporterOptions {
  /** Source of metric data. The exporter reads `snapshot()` per interval. */
  sink: MetricsSink;
  /**
   * OTLP HTTP endpoint base URL. Path `/v1/metrics` is appended unless
   * the URL already ends with `/v1/metrics` (idempotent).
   * Example: `http://otel-collector:4318` or `https://otlp.example.com`.
   */
  endpoint: string;
  /** Push interval in milliseconds. Defaults to 30s (Prometheus default). */
  intervalMs?: number | undefined;
  /** Optional bearer token / API key (sent as `Authorization`). */
  authorization?: string | undefined;
  /** Extra request headers (vendor-specific keys go here). */
  headers?: Record<string, string>;
  /** Resource attributes attached to every export. Defaults: `service.name=wrongstack`. */
  resourceAttributes?: Record<string, string>;
  /** Instrumentation scope. Default: `wrongstack`. */
  scopeName?: string | undefined;
  /** Per-request timeout. Defaults to 10s. */
  timeoutMs?: number | undefined;
  /** Override fetch (for tests). Defaults to global `fetch`. */
  fetchImpl?: typeof globalThis.fetch | undefined;
  /** Called when a push fails. Defaults to silent (telemetry must never crash the host). */
  onError?: ((err: unknown) => void) | undefined;
}

export interface OtlpMetricsExporterHandle {
  /** Push immediately (in addition to the scheduled interval). */
  flush(): Promise<void>;
  /** Stop the timer, attempt a final flush, then resolve. */
  stop(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

function joinEndpoint(base: string): string {
  if (/\/v1\/metrics\/?$/.test(base)) return base;
  return base.replace(/\/$/, '') + '/v1/metrics';
}

interface OtlpAttribute {
  key: string;
  value: { stringValue: string };
}

interface OtlpDataPoint {
  attributes: OtlpAttribute[];
  timeUnixNano: string;
  asDouble?: number | undefined;
  asInt?: string | undefined;
  count?: string | undefined;
  sum?: number | undefined;
  quantileValues?: { quantile: number | undefined; value: number }[];
}

interface OtlpMetric {
  name: string;
  description?: string | undefined;
  unit?: string | undefined;
  sum?: { dataPoints: OtlpDataPoint[] | undefined; aggregationTemporality: 2; isMonotonic: true };
  gauge?: { dataPoints: OtlpDataPoint[] | undefined };
  summary?: { dataPoints: OtlpDataPoint[] | undefined };
}

interface OtlpExportRequest {
  resourceMetrics: {
    resource: { attributes: OtlpAttribute[] };
    scopeMetrics: {
      scope: { name: string; version?: string | undefined };
      metrics: OtlpMetric[];
    }[];
  }[];
}

function attributesFor(labels: Record<string, string>): OtlpAttribute[] {
  return Object.entries(labels).map(([key, value]) => ({
    key,
    value: { stringValue: value },
  }));
}

function buildExportBody(opts: {
  series: MetricSeries[];
  resourceAttributes: Record<string, string>;
  scopeName: string;
  timeUnixNano: string;
}): OtlpExportRequest {
  const metrics: OtlpMetric[] = [];
  for (const s of opts.series) {
    const dp: OtlpDataPoint = {
      attributes: attributesFor(s.labels),
      timeUnixNano: opts.timeUnixNano,
    };

    if (s.type === 'counter') {
      // OTLP requires sum data points carry `startTimeUnixNano`, but the spec
      // accepts omission for cumulative counters when the receiver can
      // assume process start. Most collectors do; vendor-specific tightness
      // is the user's problem if they need it stricter.
      dp.asDouble = s.values.value ?? 0;
      metrics.push({
        name: s.name,
        sum: { dataPoints: [dp], aggregationTemporality: 2, isMonotonic: true },
      });
    } else if (s.type === 'gauge') {
      dp.asDouble = s.values.value ?? 0;
      metrics.push({ name: s.name, gauge: { dataPoints: [dp] } });
    } else {
      // histogram → OTLP summary (quantiles are pre-computed by the sink)
      dp.count = String(s.values.count ?? 0);
      dp.sum = s.values.sum ?? 0;
      dp.quantileValues = [
        { quantile: 0.5, value: s.values.p50 ?? 0 },
        { quantile: 0.95, value: s.values.p95 ?? 0 },
        { quantile: 0.99, value: s.values.p99 ?? 0 },
      ];
      metrics.push({ name: s.name, summary: { dataPoints: [dp] } });
    }
  }

  return {
    resourceMetrics: [
      {
        resource: { attributes: attributesFor(opts.resourceAttributes) },
        scopeMetrics: [
          {
            scope: { name: opts.scopeName },
            metrics,
          },
        ],
      },
    ],
  };
}

/**
 * Build the OTLP/JSON export body from a sink snapshot. Exported for tests
 * and for callers that want to ship via their own transport.
 */
export function buildOtlpMetricsRequest(
  sink: MetricsSink,
  opts: { resourceAttributes?: Record<string, string>; scopeName?: string | undefined } = {},
): OtlpExportRequest {
  return buildExportBody({
    series: sink.snapshot().series,
    resourceAttributes: opts.resourceAttributes ?? { 'service.name': 'wrongstack' },
    scopeName: opts.scopeName ?? 'wrongstack',
    timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
  });
}

/**
 * Start pushing metrics to an OTLP HTTP receiver. Returns a handle with
 * `flush()` and `stop()`.
 */
export function startOtlpMetricsExporter(
  opts: OtlpMetricsExporterOptions,
): OtlpMetricsExporterHandle {
  const url = joinEndpoint(opts.endpoint);
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const onError = opts.onError ?? (() => {});
  const resourceAttributes = opts.resourceAttributes ?? { 'service.name': 'wrongstack' };
  const scopeName = opts.scopeName ?? 'wrongstack';

  let stopped = false;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(opts.headers ?? {}),
  };
  if (opts.authorization) headers.authorization = opts.authorization;

  async function pushOnce(): Promise<void> {
    // No `stopped` guard here: stop() relies on this for its final flush
    // (mirrors the traces exporter). The interval callback is what must
    // respect `stopped`.
    const body = buildExportBody({
      series: opts.sink.snapshot().series,
      resourceAttributes,
      scopeName,
      timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        onError(new Error(`OTLP push failed: ${res.status} ${res.statusText} ${text}`));
      }
    } catch (err) {
      onError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  const handle = setInterval(() => {
    if (!stopped) void pushOnce();
  }, intervalMs);
  // Don't keep the process alive just to push metrics — graceful shutdown
  // is the host's job.
  handle.unref?.();

  return {
    flush: pushOnce,
    async stop() {
      stopped = true;
      clearInterval(handle);
      await pushOnce().catch(onError);
    },
  };
}
