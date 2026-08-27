import { constants as fsConstants, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EventBus } from '@wrongstack/core/kernel';
import {
  DefaultHealthRegistry,
  InMemoryMetricsSink,
  type MetricsServerHandle,
  startMetricsServer,
  wireMetricsToEvents,
} from '@wrongstack/core/observability';
import type { HealthRegistry, MetricsRuntimeStatus, MetricsSink } from '@wrongstack/core/types';
import { toErrorMessage, type WstackPaths } from '@wrongstack/core/utils';
import type {
  MCPHealthState,
  MCPOperationEvent,
  MCPRegistry,
  MCPServerOperationalHealth,
} from '@wrongstack/mcp';

export interface MetricsWiringDeps {
  flags: Record<string, unknown>;
  wpaths: WstackPaths;
  events: EventBus;
  logger: { info(msg: string): void; warn(msg: string): void };
  config: { provider: string; model: string };
}

export interface MetricsWiringResult {
  metricsSink: MetricsSink | undefined;
  healthRegistry: HealthRegistry | undefined;
  metricsServerHandle: MetricsServerHandle | undefined;
  metricsStatus: MetricsRuntimeStatus;
  dispose?: (() => void) | undefined;
}

type McpHealthState = ReturnType<MCPRegistry['describe']>[number]['state'];

type McpHealthSource = Pick<MCPRegistry, 'describe'> & {
  operationalHealth?: (() => MCPServerOperationalHealth[]) | undefined;
};

type McpMetricsSource = Pick<MCPRegistry, 'onOperation' | 'operationalHealth'>;

const MCP_HEALTHY_STATES = new Set<McpHealthState>(['connected', 'dormant']);
const MCP_DEGRADED_STATES = new Set<McpHealthState>([
  'idle',
  'connecting',
  'disconnected',
  'reconnecting',
]);

/**
 * Attach an MCP lifecycle check after the registry has started its configured
 * servers. Details intentionally contain counts only: server names, commands,
 * URLs, and authentication configuration never enter `/health` or `/healthz`.
 */
export function registerMcpHealthCheck(
  healthRegistry: HealthRegistry | undefined,
  mcpRegistry: McpHealthSource,
): void {
  if (!healthRegistry) return;
  healthRegistry.register({
    name: 'mcp',
    check: async () => {
      try {
        if (mcpRegistry.operationalHealth) {
          const servers = mcpRegistry.operationalHealth();
          if (servers.length === 0) {
            return { status: 'healthy', detail: 'no servers configured' };
          }
          const counts = countBy(servers.map((server) => server.healthState));
          const detail = renderCounts(counts);
          const totalFailures = servers.reduce(
            (sum, server) =>
              sum + server.failures.transport + server.failures.protocol + server.failures.tool,
            0,
          );
          const data = { total: servers.length, failures: totalFailures };
          if ((counts.get('failed') ?? 0) > 0) return { status: 'unhealthy', detail, data };
          if ((counts.get('degraded') ?? 0) > 0 || (counts.get('connecting') ?? 0) > 0) {
            return { status: 'degraded', detail, data };
          }
          return { status: 'healthy', detail, data };
        }
        const servers = mcpRegistry.describe().filter((server) => server.enabled);
        if (servers.length === 0) {
          return { status: 'healthy', detail: 'no servers configured' };
        }

        const counts = new Map<McpHealthState, number>();
        for (const server of servers) {
          counts.set(server.state, (counts.get(server.state) ?? 0) + 1);
        }
        const detail = [...counts.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([state, count]) => `${count} ${state}`)
          .join(', ');

        if ((counts.get('failed') ?? 0) > 0) {
          return { status: 'unhealthy', detail, data: { total: servers.length } };
        }
        if (servers.some((server) => MCP_DEGRADED_STATES.has(server.state))) {
          return { status: 'degraded', detail, data: { total: servers.length } };
        }
        if (servers.every((server) => MCP_HEALTHY_STATES.has(server.state))) {
          return { status: 'healthy', detail, data: { total: servers.length } };
        }
        return { status: 'degraded', detail: 'unknown lifecycle state' };
      } catch {
        return { status: 'unhealthy', detail: 'registry status unavailable' };
      }
    },
  });
}

/**
 * Bridge detailed registry telemetry into bounded-cardinality metrics. Server
 * names, reasons, commands, URLs, tool names, and arguments are never labels.
 */
export function registerMcpMetrics(
  metricsSink: MetricsSink | undefined,
  mcpRegistry: McpMetricsSource,
): () => void {
  if (!metricsSink) return () => {};
  const refreshGauges = () => {
    const snapshots = mcpRegistry.operationalHealth();
    const states: MCPHealthState[] = [
      'disabled',
      'dormant',
      'connecting',
      'healthy',
      'degraded',
      'failed',
    ];
    const counts = countBy(snapshots.map((server) => server.healthState));
    for (const state of states) {
      metricsSink.gauge('mcp.servers', counts.get(state) ?? 0, { state });
    }
    metricsSink.gauge(
      'mcp.calls.in_flight',
      snapshots.reduce((sum, server) => sum + server.inFlightCalls, 0),
    );
  };
  refreshGauges();
  return mcpRegistry.onOperation((event) => {
    metricsSink.counter('mcp.operations.total', 1, { operation: event.kind });
    if (event.failureKind) {
      metricsSink.counter('mcp.failures.total', 1, { kind: event.failureKind });
    }
    recordMcpDuration(metricsSink, event);
    refreshGauges();
  });
}

export function registerMcpObservability(
  healthRegistry: HealthRegistry | undefined,
  metricsSink: MetricsSink | undefined,
  mcpRegistry: McpHealthSource & McpMetricsSource,
): () => void {
  registerMcpHealthCheck(healthRegistry, mcpRegistry);
  return registerMcpMetrics(metricsSink, mcpRegistry);
}

function recordMcpDuration(metricsSink: MetricsSink, event: Readonly<MCPOperationEvent>): void {
  if (event.durationMs === undefined) return;
  if (event.kind === 'discover') {
    metricsSink.histogram('mcp.discovery.duration_ms', event.durationMs);
  } else if (event.kind === 'call' || event.failureKind === 'tool') {
    metricsSink.histogram('mcp.call.duration_ms', event.durationMs, {
      outcome: event.failureKind ? 'error' : 'ok',
    });
  } else if (
    event.kind === 'connect' ||
    event.kind === 'reconnect' ||
    event.failureKind === 'transport'
  ) {
    metricsSink.histogram('mcp.connection.duration_ms', event.durationMs, {
      outcome: event.failureKind ? 'error' : 'ok',
    });
  }
}

function countBy<T extends string>(values: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function renderCounts<T extends string>(counts: ReadonlyMap<T, number>): string {
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([state, count]) => `${count} ${state}`)
    .join(', ');
}

// Labels can contain provider/model/tool/session identifiers. Keep the
// production sink bounded even if a plugin emits a high-cardinality value.
const MAX_METRIC_SERIES_PER_NAME = 500;

export function setupMetrics(params: MetricsWiringDeps): MetricsWiringResult {
  const { flags, wpaths, events, logger, config } = params;
  let metricsSink: MetricsSink | undefined;
  let healthRegistry: HealthRegistry | undefined;
  let metricsServerHandle: MetricsServerHandle | undefined;
  let metricsWiredHandle: ReturnType<typeof wireMetricsToEvents> | undefined;
  const metricsStatus: MetricsRuntimeStatus = {
    collectionEnabled: false,
    httpExporter: 'disabled',
  };

  const metricsPortFlag = flags['metrics-port'];
  const metricsPort =
    typeof metricsPortFlag === 'string' && metricsPortFlag.length > 0
      ? Number.parseInt(metricsPortFlag, 10)
      : undefined;
  if (metricsPort !== undefined && !flags.metrics) flags.metrics = true;

  if (!flags.metrics) return { metricsSink, healthRegistry, metricsServerHandle, metricsStatus };

  metricsSink = new InMemoryMetricsSink({
    maxSeriesPerMetric: MAX_METRIC_SERIES_PER_NAME,
  });
  metricsStatus.collectionEnabled = true;
  metricsWiredHandle = wireMetricsToEvents(events, metricsSink);
  healthRegistry = new DefaultHealthRegistry();
  healthRegistry.register({
    name: 'session-store',
    check: async () => {
      try {
        await fs.access(wpaths.projectSessions, fsConstants.R_OK | fsConstants.W_OK);
        return { status: 'healthy' };
      } catch {
        return { status: 'unhealthy', detail: 'session storage is not readable and writable' };
      }
    },
  });
  healthRegistry.register({
    name: 'project-storage',
    check: async () => {
      try {
        await fs.access(wpaths.projectDir, fsConstants.R_OK | fsConstants.W_OK);
        return { status: 'healthy' };
      } catch {
        return { status: 'unhealthy', detail: 'project storage is not readable and writable' };
      }
    },
  });
  healthRegistry.register({
    name: 'provider',
    check: async () =>
      config.provider.trim() && config.model.trim()
        ? { status: 'healthy', detail: 'configured' }
        : { status: 'degraded', detail: 'provider or model is not configured' },
  });

  const dumpMetrics = () => {
    if (!metricsSink) return;
    try {
      const out = path.join(wpaths.projectSessions, 'metrics.json');
      const snap = metricsSink.snapshot();
      writeFileSync(out, JSON.stringify(snap, null, 2));
    } catch {
      // best-effort
    }
  };
  const onExit = () => {
    dumpMetrics();
    void metricsServerHandle?.close().catch(() => {});
  };
  process.on('exit', onExit);

  const dispose = () => {
    process.removeListener('exit', onExit);
    void metricsServerHandle?.close().catch(() => {});
    metricsWiredHandle?.dispose();
  };

  if (metricsPort !== undefined && Number.isFinite(metricsPort)) {
    metricsStatus.httpExporter = 'failed';
    try {
      // eslint-disable-next-line no-restricted-syntax
      metricsServerHandle = startMetricsServer({
        port: metricsPort,
        host: process.env['METRICS_HOST'] ?? '127.0.0.1',
        sink: metricsSink,
        healthRegistry,
      }) as never as MetricsServerHandle;
      logger.info(
        `metrics endpoint listening on ${(metricsServerHandle as never as { url?: string | undefined }).url} (healthz on same port)`,
      );
      metricsStatus.httpExporter = 'listening';
    } catch (err) {
      logger.warn(`metrics endpoint failed to start: ${toErrorMessage(err)}`);
    }
  } else if (metricsPort !== undefined) {
    metricsStatus.httpExporter = 'failed';
  }

  return { metricsSink, healthRegistry, metricsServerHandle, metricsStatus, dispose };
}
