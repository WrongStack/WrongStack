import type { ObservabilityConfig } from '@wrongstack/contracts/types/config/observability';
import type { MetricsSink, Tracer } from '@wrongstack/contracts/types/observability';
import { toErrorMessage } from '../utils/error.js';
import { startOtlpMetricsExporter } from './otlp-metrics.js';
import { startOtlpTraceExporter } from './otlp-traces.js';

/**
 * Turns `observability.otlp` (plus the standard `OTEL_*` variables) into
 * running exporters. One call per host process; the handle owns both timers.
 */

type Env = Readonly<Record<string, string | undefined>>;

interface ResolvedOtlpExport {
  endpoint: string;
  headers: Record<string, string>;
  serviceName: string;
  traces: boolean;
  metrics: boolean;
}

/**
 * `OTEL_EXPORTER_OTLP_HEADERS`: `key=value` pairs separated by commas, values
 * percent-encoded (the OTel spec's format).
 */
function parseOtelHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!key) continue;
    try {
      headers[key] = decodeURIComponent(value);
    } catch {
      headers[key] = value;
    }
  }
  return headers;
}

/**
 * What to export, or `undefined` when export is off. The config must ask for
 * it — an endpoint of its own, or `enabled: true` to take the one in
 * `OTEL_EXPORTER_OTLP_ENDPOINT` — and `OTEL_SDK_DISABLED=true` wins over both.
 * Throws on an endpoint that is not an http(s) URL.
 */
function resolveOtlpExport(
  config: ObservabilityConfig | undefined,
  env: Env = process.env,
): ResolvedOtlpExport | undefined {
  const otlp = config?.otlp;
  if (!otlp || otlp.enabled === false) return undefined;
  if (env['OTEL_SDK_DISABLED']?.trim().toLowerCase() === 'true') return undefined;
  const endpoint =
    otlp.endpoint?.trim() ||
    (otlp.enabled === true ? env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim() : undefined);
  if (!endpoint) return undefined;
  let protocol: string;
  try {
    protocol = new URL(endpoint).protocol;
  } catch {
    throw new Error(`observability.otlp endpoint is not a URL: ${endpoint}`);
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`observability.otlp endpoint must be http(s): ${endpoint}`);
  }
  return {
    endpoint,
    headers: { ...parseOtelHeaders(env['OTEL_EXPORTER_OTLP_HEADERS']), ...(otlp.headers ?? {}) },
    serviceName: otlp.serviceName?.trim() || env['OTEL_SERVICE_NAME']?.trim() || 'wrongstack',
    traces: otlp.traces !== false,
    metrics: otlp.metrics !== false,
  };
}

export interface OtlpExportHandle {
  readonly endpoint: string;
  /** Install on the agent, provider runner and tool executor; undefined when traces are off. */
  readonly tracer: Tracer | undefined;
  /** Whether the host should collect metrics for export. */
  readonly wantsMetrics: boolean;
  /** Start pushing `sink` (once; later calls are ignored). */
  exportMetrics(sink: MetricsSink): void;
  /** Push what is buffered and stop both timers. */
  stop(): Promise<void>;
}

export interface StartOtlpExportOptions {
  env?: Env | undefined;
  /** `service.version` resource attribute. */
  serviceVersion?: string | undefined;
  /**
   * Where problems go. A bad endpoint is a warning and no export, never a
   * failed boot; so is the first failed push — later ones stay quiet, since a
   * collector that is down should not flood the terminal.
   */
  logger?: { info(msg: string): void; warn(msg: string): void } | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export function startOtlpExport(
  config: ObservabilityConfig | undefined,
  opts: StartOtlpExportOptions = {},
): OtlpExportHandle | undefined {
  let resolved: ResolvedOtlpExport | undefined;
  try {
    resolved = resolveOtlpExport(config, opts.env);
  } catch (err) {
    opts.logger?.warn(`OTLP export not started: ${toErrorMessage(err)}`);
    return undefined;
  }
  if (!resolved) return undefined;
  let warned = false;
  const onError = (err: unknown): void => {
    if (warned) return;
    warned = true;
    opts.logger?.warn(`OTLP export to ${resolved.endpoint} failed: ${toErrorMessage(err)}`);
  };
  const resourceAttributes: Record<string, string> = {
    'service.name': resolved.serviceName,
    ...(opts.serviceVersion ? { 'service.version': opts.serviceVersion } : {}),
  };
  const common = {
    endpoint: resolved.endpoint,
    headers: resolved.headers,
    resourceAttributes,
    onError,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  };
  let metrics: ReturnType<typeof startOtlpMetricsExporter> | undefined;
  // Metrics go out with each finished turn as well as on their 30 s timer:
  // a one-shot run is over long before the first tick.
  const traces = resolved.traces
    ? startOtlpTraceExporter({ ...common, onTurnEnd: () => void metrics?.flush() })
    : undefined;
  opts.logger?.info(`OTLP export to ${resolved.endpoint}`);
  return {
    endpoint: resolved.endpoint,
    tracer: traces?.tracer,
    wantsMetrics: resolved.metrics,
    exportMetrics(sink) {
      if (!resolved.metrics || metrics) return;
      metrics = startOtlpMetricsExporter({ ...common, sink });
    },
    async stop() {
      await Promise.all([traces?.stop(), metrics?.stop()]);
    },
  };
}
