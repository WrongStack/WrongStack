import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryMetricsSink } from '../../src/observability/metrics.js';
import {
  buildOtlpMetricsRequest,
  startOtlpMetricsExporter,
} from '../../src/observability/otlp-metrics.js';

/**
 * V2-A: OTLP/JSON push adapter. We don't have a live OTLP receiver in CI,
 * so the tests focus on three things:
 *
 *  1. The JSON body shape matches what the OTel spec expects (the field
 *     names a real collector would parse).
 *  2. The exporter calls fetch on the right URL, with the right method
 *     and headers, on the scheduled interval.
 *  3. Failures call `onError` rather than throwing — telemetry must
 *     never crash the host.
 */

describe('buildOtlpMetricsRequest', () => {
  it('serializes a counter as a sum metric with isMonotonic=true', () => {
    const sink = new InMemoryMetricsSink();
    sink.counter('agent_runs_total', 4, { mode: 'plan' });

    const req = buildOtlpMetricsRequest(sink);
    const metrics = req.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    expect(metrics).toHaveLength(1);
    const m = metrics[0]!;
    expect(m.name).toBe('agent_runs_total');
    expect(m.sum?.isMonotonic).toBe(true);
    expect(m.sum?.aggregationTemporality).toBe(2);
    expect(m.sum?.dataPoints![0]!.asDouble).toBe(4);
    // label attributes are encoded as stringValue per OTLP/JSON spec
    expect(m.sum?.dataPoints![0]!.attributes[0]).toEqual({
      key: 'mode',
      value: { stringValue: 'plan' },
    });
  });

  it('serializes a gauge with the gauge field set', () => {
    const sink = new InMemoryMetricsSink();
    sink.gauge('active_subagents', 3);

    const req = buildOtlpMetricsRequest(sink);
    const m = req.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!;
    expect(m.name).toBe('active_subagents');
    expect(m.gauge?.dataPoints![0]!.asDouble).toBe(3);
    expect(m.sum).toBeUndefined();
    expect(m.summary).toBeUndefined();
  });

  it('serializes a histogram as an OTLP summary with quantile points', () => {
    const sink = new InMemoryMetricsSink();
    for (let i = 1; i <= 100; i++) sink.histogram('tool_duration_ms', i, { tool: 'bash' });

    const req = buildOtlpMetricsRequest(sink);
    const m = req.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!;
    expect(m.name).toBe('tool_duration_ms');
    const summary = m.summary;
    if (!summary) throw new Error('summary should be defined');
    const dp = summary.dataPoints![0];
    if (!dp) throw new Error('dataPoint should be defined');
    expect(dp.count).toBe('100');
    expect(dp.quantileValues).toHaveLength(3);
    expect(dp.quantileValues!.map((q) => q.quantile)).toEqual([0.5, 0.95, 0.99]);
  });

  it('attaches the default service.name resource attribute', () => {
    const sink = new InMemoryMetricsSink();
    sink.counter('hits_total', 1);

    const req = buildOtlpMetricsRequest(sink);
    const attrs = req.resourceMetrics[0]!.resource.attributes;
    const serviceName = attrs.find((a) => a.key === 'service.name');
    expect(serviceName?.value.stringValue).toBe('wrongstack');
  });

  it('respects custom resource attributes and scope name', () => {
    const sink = new InMemoryMetricsSink();
    sink.counter('hits_total', 1);

    const req = buildOtlpMetricsRequest(sink, {
      resourceAttributes: { 'service.name': 'my-agent', env: 'prod' },
      scopeName: 'my-scope',
    });
    const attrs = req.resourceMetrics[0]!.resource.attributes;
    expect(attrs.find((a) => a.key === 'env')?.value.stringValue).toBe('prod');
    expect(req.resourceMetrics[0]!.scopeMetrics[0]!.scope.name).toBe('my-scope');
  });
});

describe('startOtlpMetricsExporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('POSTs to the OTLP endpoint with the right URL and content-type', async () => {
    const sink = new InMemoryMetricsSink();
    sink.counter('events_total', 1);
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 200 }),
    ) as never as typeof globalThis.fetch;

    const exp = startOtlpMetricsExporter({
      sink,
      endpoint: 'http://collector:4318',
      fetchImpl,
    });

    await exp.flush();
    await exp.stop();

    const calls = (fetchImpl as never as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe('http://collector:4318/v1/metrics');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body.resourceMetrics).toBeDefined();
  });

  it('does not duplicate /v1/metrics when already in the endpoint', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 200 }),
    ) as never as typeof globalThis.fetch;
    const exp = startOtlpMetricsExporter({
      sink: new InMemoryMetricsSink(),
      endpoint: 'https://otel.example.com/v1/metrics',
      fetchImpl,
    });
    await exp.flush();
    await exp.stop();
    const [url] = (fetchImpl as never as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      string,
    ];
    expect(url).toBe('https://otel.example.com/v1/metrics');
  });

  it('attaches the authorization header when supplied', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 200 }),
    ) as never as typeof globalThis.fetch;
    const exp = startOtlpMetricsExporter({
      sink: new InMemoryMetricsSink(),
      endpoint: 'http://collector:4318',
      authorization: 'Bearer xyz',
      headers: { 'x-tenant': 'a' },
      fetchImpl,
    });
    await exp.flush();
    await exp.stop();
    const [, init] = (fetchImpl as never as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer xyz');
    expect(h['x-tenant']).toBe('a');
  });

  it('calls onError on non-2xx responses', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('bad', { status: 500 }),
    ) as never as typeof globalThis.fetch;
    const onError = vi.fn();
    const exp = startOtlpMetricsExporter({
      sink: new InMemoryMetricsSink(),
      endpoint: 'http://collector:4318',
      fetchImpl,
      onError,
    });
    await exp.flush();
    await exp.stop();
    expect(onError).toHaveBeenCalled();
    const err = onError.mock.calls[0]![0] as Error;
    expect(err.message).toContain('500');
  });

  it('calls onError when fetch throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('econnrefused');
    }) as never as typeof globalThis.fetch;
    const onError = vi.fn();
    const exp = startOtlpMetricsExporter({
      sink: new InMemoryMetricsSink(),
      endpoint: 'http://collector:4318',
      fetchImpl,
      onError,
    });
    await exp.flush();
    await exp.stop();
    expect(onError).toHaveBeenCalled();
  });

  it('pushes again on the scheduled interval', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 200 }),
    ) as never as typeof globalThis.fetch;
    const exp = startOtlpMetricsExporter({
      sink: new InMemoryMetricsSink(),
      endpoint: 'http://collector:4318',
      intervalMs: 1000,
      fetchImpl,
    });

    // Advance one interval — should trigger one scheduled push
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await exp.stop();

    const calls = (fetchImpl as never as { mock: { calls: unknown[][] } }).mock.calls;
    // 2 interval ticks + 1 final flush during stop()
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
