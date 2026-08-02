import { describe, expect, it } from 'vitest';
import { buildMetricsCommand } from '../src/slash-commands/metrics.js';

describe('/metrics', () => {
  it('reports "metrics not enabled" when no sink', async () => {
    const cmd = buildMetricsCommand({} as never);
    const res = await cmd.run('');
    expect(res!.message).toContain('Metrics not enabled');
  });

  it('exposes deep help and structured unavailable output', async () => {
    const cmd = buildMetricsCommand({ metricsStatus: { collectionEnabled: false, httpExporter: 'disabled' } } as never);
    expect(cmd.category).toBe('Inspect');
    expect(cmd.argsHint).toBe('[--json]');
    expect(cmd.help).toContain('Usage: /metrics [--json]');

    const res = await cmd.run('--json');
    expect(JSON.parse(res!.message!)).toEqual({
      enabled: false,
      exporter: { collectionEnabled: false, httpExporter: 'disabled' },
      snapshot: null,
    });
    expect(res!.metadata?.['metrics']).toMatchObject({ enabled: false });
  });

  it('reports "no metrics recorded" when series is empty', async () => {
    const sink = { snapshot: () => ({ series: [] }) };
    const cmd = buildMetricsCommand({ metricsSink: sink as never } as never);
    const res = await cmd.run('');
    expect(res!.message).toContain('No metrics recorded');
    expect(res!.message).toContain('http_exporter=unknown');
  });

  it('returns snapshot and exporter state as JSON and metadata', async () => {
    const snapshot = {
      timestamp: 123,
      series: [{ name: 'tool.calls', type: 'counter', labels: {}, values: { value: 2 } }],
    };
    const cmd = buildMetricsCommand({
      metricsSink: { snapshot: () => snapshot } as never,
      metricsStatus: { collectionEnabled: true, httpExporter: 'listening' },
    } as never);
    const res = await cmd.run('--json');
    expect(JSON.parse(res!.message!)).toEqual({
      enabled: true,
      exporter: { collectionEnabled: true, httpExporter: 'listening' },
      snapshot,
    });
    expect(res!.metadata?.['metrics']).toMatchObject({ enabled: true, snapshot });
    expect(res!.message).not.toContain('http://');
  });

  it('renders counter and histogram series with labels', async () => {
    const sink = {
      snapshot: () => ({
        series: [
          {
            name: 'tokens_used',
            type: 'counter',
            labels: { provider: 'anthropic' },
            values: { value: 12345 },
          },
          {
            name: 'latency_ms',
            type: 'histogram',
            labels: { model: 'opus' },
            values: { count: 10, sum: 500, min: 30, max: 80, p50: 50, p95: 75, p99: 79 },
          },
          {
            name: 'no_labels',
            type: 'counter',
            labels: {},
            values: { value: 1 },
          },
        ],
      }),
    };
    const cmd = buildMetricsCommand({ metricsSink: sink as never } as never);
    const res = await cmd.run('');
    const out = res!.message ?? '';
    expect(out).toContain('# latency_ms');
    expect(out).toContain('count=10');
    expect(out).toContain('p95=75');
    expect(out).toContain('model=opus');
    expect(out).toContain('# tokens_used');
    expect(out).toContain('12345');
    expect(out).toContain('provider=anthropic');
    expect(out).toContain('# no_labels');
    expect(out.indexOf('latency_ms')).toBeLessThan(out.indexOf('tokens_used'));
  });
});
