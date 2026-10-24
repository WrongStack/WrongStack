/**
 * Observability primitives — metrics, tracing, health. Implementations live in
 * `defaults/observability/`. Consumers depend on these interfaces so a noop
 * sink can be swapped for an OTel/Prometheus adapter without touching call
 * sites.
 */

export type MetricLabels = Record<string, string>;

export interface MetricsSink {
  /** Monotonically-increasing counter (e.g. total tool calls). */
  counter(name: string, value?: number | undefined, labels?: MetricLabels): void | undefined;
  /** Latency / size distribution (e.g. tool duration). */
  histogram(name: string, value: number, labels?: MetricLabels): void | undefined;
  /** Current value (e.g. active subagents, pending tasks). */
  gauge(name: string, value: number, labels?: MetricLabels): void | undefined;
  /** Point-in-time export — for /metrics scrape, debug dumps, tests. */
  snapshot(): MetricsSnapshot;
  /**
   * Cumulative count of observations dropped by the sink (e.g. a
   * high-cardinality label guard that refused new series). Returns 0 for
   * sinks without a cap.
   */
  droppedObservations(): number;
  /** Reset all metrics. Useful for tests; production code should rarely use. */
  reset(): void;
}

export interface MetricSeries {
  name: string;
  type: 'counter' | 'histogram' | 'gauge';
  labels: MetricLabels;
  /** Counter/gauge: latest value. Histogram: count, sum, min, max, p50, p95, p99. */
  values: Record<string, number>;
}

export interface MetricsSnapshot {
  /** Snapshot time (epoch ms). */
  timestamp: number;
  series: MetricSeries[];
  /**
   * Per-metric observation drops since the sink was created (or last reset).
   * Names mirror `MetricSeries.name`. `droppedObservations` is undefined on
   * sinks without a cardinality cap.
   */
  droppedObservations?: Record<string, number> | undefined;
}

/** Safe host-level status surfaced by `/metrics`; contains no endpoint or credentials. */
export interface MetricsRuntimeStatus {
  collectionEnabled: boolean;
  httpExporter: 'disabled' | 'listening' | 'failed' | 'unknown';
}

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthCheckResult {
  status: HealthStatus;
  detail?: string | undefined;
  /** Optional structured data (e.g. latency, version) for dashboards. */
  data?: Record<string, unknown>;
}

export interface HealthCheck {
  readonly name: string;
  check(): Promise<HealthCheckResult>;
}

export interface AggregateHealth {
  status: HealthStatus;
  timestamp: number;
  checks: (HealthCheckResult & { name: string })[];
}

export interface HealthRegistry {
  register(check: HealthCheck): void;
  unregister(name: string): void;
  run(): Promise<AggregateHealth>;
}

/**
 * Minimal OTel-compatible Span. The default implementation is a noop; wire an
 * OpenTelemetry adapter in production to get distributed tracing for free.
 */
export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  recordError(err: Error): void;
  end(): void;
}

export interface Tracer {
  startSpan(name: string, attrs?: Record<string, string | number | boolean>): Span;
}
