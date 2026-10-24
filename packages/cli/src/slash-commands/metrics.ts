import type { MetricsRuntimeStatus, SlashCommand } from '@wrongstack/contracts/types';
import { color } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';

export function buildMetricsCommand(opts: SlashCommandContext): SlashCommand {
  const help = [
    'Usage: /metrics [--json]',
    '',
    'Shows the current in-memory metrics snapshot and safe exporter status.',
    'Use --json for stable machine-readable output and slash-command metadata.',
    'Metric collection requires --metrics or --metrics-port.',
  ].join('\n');

  const runtimeStatus: MetricsRuntimeStatus = opts.metricsStatus ?? {
    collectionEnabled: opts.metricsSink !== undefined,
    httpExporter: 'unknown',
  };

  return {
    name: 'metrics',
    category: 'Inspect',
    argsHint: '[--json]',
    description: 'Show metrics snapshot (requires --metrics flag).',
    help,
    async run(args: string) {
      const json = args.trim().split(/\s+/).includes('--json');
      const metricsSink = opts.metricsSink;
      if (!metricsSink) {
        if (json) {
          const unavailable = { enabled: false, exporter: runtimeStatus, snapshot: null };
          return {
            message: JSON.stringify(unavailable, null, 2),
            metadata: { metrics: unavailable },
          };
        }
        return { message: 'Metrics not enabled. Restart with --metrics to collect.' };
      }
      const snap = metricsSink.snapshot();
      const payload = { enabled: true, exporter: runtimeStatus, snapshot: snap };
      if (json) {
        return { message: JSON.stringify(payload, null, 2), metadata: { metrics: payload } };
      }

      const statusLine = `collection=${runtimeStatus.collectionEnabled ? 'enabled' : 'disabled'} http_exporter=${runtimeStatus.httpExporter}`;
      if (snap.series.length === 0) {
        return { message: `${color.dim(statusLine)}\nNo metrics recorded yet.` };
      }

      const lines: string[] = [color.dim(statusLine)];
      const byName = new Map<string, typeof snap.series>();
      for (const s of snap.series) {
        const bucket = byName.get(s.name) ?? [];
        bucket.push(s);
        byName.set(s.name, bucket);
      }
      for (const [name, series] of [...byName.entries()].sort()) {
        lines.push(color.dim(`# ${name}`));
        for (const s of series) {
          const labels = Object.entries(s.labels)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
          const labelStr = labels ? color.dim(` {${labels}}`) : '';
          if (s.type === 'histogram') {
            lines.push(
              `  count=${s.values.count} sum=${s.values.sum} min=${s.values.min} max=${s.values.max} p50=${s.values.p50} p95=${s.values.p95} p99=${s.values.p99}${labelStr}`,
            );
          } else {
            lines.push(`  ${s.values.value}${labelStr}`);
          }
        }
      }
      return { message: lines.join('\n') };
    },
  };
}
