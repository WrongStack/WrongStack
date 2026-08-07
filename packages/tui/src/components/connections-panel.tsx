import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ConnectionHealthService,
  type ConnectionsHealthReport,
  collectConnectionsHealth,
} from '../connections-health.js';
import { Box, Text, useInput } from '../ink.js';
import { usePanelShortcutsEnabled } from './monitor-shell.js';

/** Refresh interval for auto-updating service status. */
const REFRESH_MS = 8_000;

const STATUS_GLYPH: Record<ConnectionHealthService['status'], string> = {
  healthy: '●',
  degraded: '◐',
  offline: '○',
  unavailable: '⊘',
  error: '✗',
};

const STATUS_COLOR: Record<ConnectionHealthService['status'], string> = {
  healthy: 'green',
  degraded: 'yellow',
  offline: 'gray',
  unavailable: 'gray',
  error: 'red',
};

const OVERALL_COLOR: Record<ConnectionsHealthReport['overall'], string> = {
  healthy: 'green',
  degraded: 'yellow',
  error: 'red',
};

function formatUptime(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function formatLatency(ms: number | undefined): string | null {
  if (ms === undefined) return null;
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

function ServiceRow({ service }: { service: ConnectionHealthService }): React.ReactElement {
  const glyph = STATUS_GLYPH[service.status];
  const color = STATUS_COLOR[service.status];
  const latency = formatLatency(service.latencyMs);

  const metaParts: string[] = [];
  if (service.ownerPid !== undefined) metaParts.push(`PID ${service.ownerPid}`);
  if (service.clients !== undefined)
    metaParts.push(`${service.clients} client${service.clients === 1 ? '' : 's'}`);
  if (service.activeRequests !== undefined && service.activeRequests > 0) {
    metaParts.push(`${service.activeRequests} active`);
  }
  if (service.uptimeMs !== undefined) metaParts.push(`up ${formatUptime(service.uptimeMs)}`);
  if (latency) metaParts.push(`${latency}`);
  if (service.queuedWork !== undefined && service.queuedWork > 0) {
    metaParts.push(`${service.queuedWork} queued`);
  }

  return (
    <Box flexDirection="column" marginTop={0}>
      <Box gap={1}>
        <Text color={color}>{glyph}</Text>
        <Text bold>{service.label}</Text>
        {service.required ? <Text dimColor>required</Text> : null}
        <Text dimColor>· {service.mode}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>{service.detail}</Text>
      </Box>
      {metaParts.length > 0 ? (
        <Box marginLeft={2}>
          <Text dimColor>{metaParts.join(' · ')}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

interface ConnectionsPanelProps {
  projectRoot: string;
  onClose: () => void;
}

export function ConnectionsPanel({
  projectRoot,
  onClose,
}: ConnectionsPanelProps): React.ReactElement {
  const [report, setReport] = useState<ConnectionsHealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const fetch = useCallback(async () => {
    try {
      const r = await collectConnectionsHealth(projectRoot);
      if (cancelledRef.current) return;
      setReport(r);
      setError(null);
    } catch (e) {
      if (cancelledRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [projectRoot]);

  useEffect(() => {
    cancelledRef.current = false;
    void fetch();
    const timer = setInterval(() => void fetch(), REFRESH_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(timer);
    };
  }, [fetch]);

  const shortcutsEnabled = usePanelShortcutsEnabled();
  useInput((_input, _key) => {
    // Esc is owned by the central ESC_CLOSE_PANELS table (esc-close-panels.ts).
    // Handling it here too double-fires the toggle on one keypress — the panel
    // closes and immediately re-opens in the same React batch.
    if (!shortcutsEnabled) return;
    if (_input === 'q') onClose();
    if (_input === 'r') void fetch();
  });

  const overallLabel = report
    ? report.overall === 'healthy'
      ? 'All required services healthy'
      : report.overall === 'degraded'
        ? 'Some services degraded'
        : 'Service errors detected'
    : 'Checking…';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={report ? OVERALL_COLOR[report.overall] : 'gray'}
      paddingX={1}
      marginY={0}
      flexShrink={0}
    >
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text bold>Service Connections</Text>
          {report ? <Text color={OVERALL_COLOR[report.overall]}>● {overallLabel}</Text> : null}
        </Box>
        <Text dimColor>Esc/q close · r refresh</Text>
      </Box>

      {loading && !report ? (
        <Box paddingY={1}>
          <Text dimColor>Checking service health…</Text>
        </Box>
      ) : null}

      {error ? (
        <Box paddingY={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      ) : null}

      {report ? (
        <Box flexDirection="column" marginTop={0}>
          {report.services.map((s) => (
            <ServiceRow key={s.id} service={s} />
          ))}
        </Box>
      ) : null}

      {report ? (
        <Box marginTop={0}>
          <Text dimColor>Last checked {new Date(report.checkedAt).toLocaleTimeString()}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
