/**
 * Telemetry export. Off unless the user's own config asks for it: a
 * repo-committed config is denied this whole section, because an endpoint
 * chosen by a repository would receive a record of every turn, provider call
 * and tool call made in it.
 */
export interface ObservabilityConfig {
  otlp?: OtlpExportConfig | undefined;
}

/**
 * OTLP/HTTP (JSON) export of traces and metrics to a collector or vendor
 * (Grafana, Honeycomb, Datadog, Jaeger, …).
 *
 * Export starts when `endpoint` is set, or when `enabled` is true and the
 * standard `OTEL_EXPORTER_OTLP_ENDPOINT` variable supplies one. The variable
 * alone never turns it on: it is often set for other programs on the machine.
 */
export interface OtlpExportConfig {
  /** `false` switches export off even with an endpoint configured. */
  enabled?: boolean | undefined;
  /**
   * Base URL, e.g. `http://localhost:4318`. `/v1/traces` and `/v1/metrics`
   * are appended. Falls back to `OTEL_EXPORTER_OTLP_ENDPOINT`.
   */
  endpoint?: string | undefined;
  /**
   * Request headers, merged over `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k2=v2`).
   * Credential-looking names (`Authorization`, `x-api-key`, …) are encrypted
   * in the saved config; put other vendor keys in the variable instead.
   */
  headers?: Record<string, string> | undefined;
  /** `service.name` resource attribute. Falls back to `OTEL_SERVICE_NAME`, then `wrongstack`. */
  serviceName?: string | undefined;
  /** Export spans for turns, provider calls, tool calls and subagent runs. Default true. */
  traces?: boolean | undefined;
  /** Export the metrics the host collects (counters, histograms). Default true. */
  metrics?: boolean | undefined;
}
