import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/kernel/events.js';
import { wireMetricsToEvents } from '../../src/observability/event-bridge.js';
import type { MetricsSink } from '../../src/types/observability.js';

const makeSink = () => {
  const counter = vi.fn();
  const histogram = vi.fn();
  const gauge = vi.fn();
  const sink: MetricsSink = {
    counter,
    histogram,
    gauge,
    droppedObservations: () => 0,
    snapshot: () => ({ timestamp: Date.now(), series: [] }),
    reset: () => {},
  };
  return { sink, counter, histogram, gauge };
};

const usage = (input = 100, output = 50, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

describe('wireMetricsToEvents', () => {
  it('counts session.started', () => {
    const bus = new EventBus();
    const { sink, counter } = makeSink();
    wireMetricsToEvents(bus, sink);
    bus.emit('session.started', { id: 's1' });
    expect(counter).toHaveBeenCalledWith('agent.sessions.started');
  });

  it('counts session.ended and records token histograms', () => {
    const bus = new EventBus();
    const { sink, counter, histogram } = makeSink();
    wireMetricsToEvents(bus, sink);
    bus.emit('session.ended', { id: 's1', usage: usage(123, 45) });
    expect(counter).toHaveBeenCalledWith('agent.sessions.ended');
    expect(histogram).toHaveBeenCalledWith('agent.session.tokens.input', 123);
    expect(histogram).toHaveBeenCalledWith('agent.session.tokens.output', 45);
  });

  it('counts session.damaged', () => {
    const bus = new EventBus();
    const { sink, counter } = makeSink();
    wireMetricsToEvents(bus, sink);
    bus.emit('session.damaged', { sessionId: 's1', detail: 'corrupt' });
    expect(counter).toHaveBeenCalledWith('agent.sessions.damaged');
  });

  it('counts iteration.completed and iteration.limit_reached', () => {
    const bus = new EventBus();
    const { sink, counter } = makeSink();
    wireMetricsToEvents(bus, sink);
    bus.emit('iteration.completed', { ctx: {} as never, index: 1 });
    bus.emit('iteration.limit_reached', {
      currentIterations: 50,
      currentLimit: 50,
      grant: () => {},
      deny: () => {},
    });
    expect(counter).toHaveBeenCalledWith('agent.iterations.total');
    expect(counter).toHaveBeenCalledWith('agent.iteration_limit.hit');
  });

  it('counts provider.response and breaks out token counters', () => {
    const bus = new EventBus();
    const { sink, counter } = makeSink();
    wireMetricsToEvents(bus, sink);
    bus.emit('provider.response', {
      ctx: {} as never,
      model: 'test-model',
      usage: usage(10, 20, 5, 3),
      stopReason: 'end_turn',
    });
    expect(counter).toHaveBeenCalledWith('provider.responses.total', 1, {
      stop_reason: 'end_turn',
    });
    expect(counter).toHaveBeenCalledWith('provider.tokens.input', 10);
    expect(counter).toHaveBeenCalledWith('provider.tokens.output', 20);
    expect(counter).toHaveBeenCalledWith('provider.tokens.cache_read', 5);
    expect(counter).toHaveBeenCalledWith('provider.tokens.cache_write', 3);
  });

  it('omits cache counters when no cache usage', () => {
    const bus = new EventBus();
    const { sink, counter } = makeSink();
    wireMetricsToEvents(bus, sink);
    bus.emit('provider.response', {
      ctx: {} as never,
      model: 'test-model',
      usage: usage(10, 20, 0, 0),
      stopReason: 'end_turn',
    });
    const calls = counter.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain('provider.tokens.cache_read');
    expect(calls).not.toContain('provider.tokens.cache_write');
  });

  it('counts provider.retry with provider+status labels', () => {
    const bus = new EventBus();
    const { sink, counter } = makeSink();
    wireMetricsToEvents(bus, sink);
    bus.emit('provider.retry', {
      providerId: 'anthropic',
      attempt: 1,
      delayMs: 100,
      status: 429,
      description: 'rate limited',
    });
    expect(counter).toHaveBeenCalledWith('provider.retries.total', 1, {
      provider: 'anthropic',
      status: '429',
    });
  });

  it('counts provider.error with retryable label', () => {
    const bus = new EventBus();
    const { sink, counter } = makeSink();
    wireMetricsToEvents(bus, sink);
    bus.emit('provider.error', {
      providerId: 'openai',
      status: 500,
      description: 'oops',
      retryable: false,
    });
    expect(counter).toHaveBeenCalledWith('provider.errors.total', 1, {
      provider: 'openai',
      status: '500',
      retryable: 'false',
    });
  });

  it('counts tool.started and tool.executed with duration histogram', () => {
    const bus = new EventBus();
    const { sink, counter, histogram } = makeSink();
    wireMetricsToEvents(bus, sink);
    bus.emit('tool.started', { name: 'bash', id: 't1' });
    bus.emit('tool.executed', { name: 'bash', durationMs: 42, ok: true });
    expect(counter).toHaveBeenCalledWith('tool.starts.total', 1, { tool: 'bash' });
    expect(counter).toHaveBeenCalledWith('tool.executions.total', 1, {
      tool: 'bash',
      ok: 'true',
    });
    expect(histogram).toHaveBeenCalledWith('tool.duration_ms', 42, { tool: 'bash' });
  });

  it('collapses MCP server and tool names into one bounded tool label', () => {
    const bus = new EventBus();
    const { sink, counter, histogram } = makeSink();
    wireMetricsToEvents(bus, sink);
    bus.emit('tool.started', { name: 'mcp__private-server__secret-tool', id: 't1' });
    bus.emit('tool.executed', {
      name: 'mcp__private-server__secret-tool',
      durationMs: 12,
      ok: false,
    });
    expect(counter).toHaveBeenCalledWith('tool.starts.total', 1, { tool: 'mcp_proxy' });
    expect(counter).toHaveBeenCalledWith('tool.executions.total', 1, {
      tool: 'mcp_proxy',
      ok: 'false',
    });
    expect(histogram).toHaveBeenCalledWith('tool.duration_ms', 12, { tool: 'mcp_proxy' });
    expect(JSON.stringify(counter.mock.calls)).not.toContain('private-server');
    expect(JSON.stringify(counter.mock.calls)).not.toContain('secret-tool');
  });

  it('gauges token.threshold', () => {
    const bus = new EventBus();
    const { sink, gauge } = makeSink();
    wireMetricsToEvents(bus, sink);
    bus.emit('token.threshold', { used: 75_000, limit: 100_000 });
    expect(gauge).toHaveBeenCalledWith('agent.tokens.used', 75_000);
  });

  it('counts compaction.fired and records reduction histogram', () => {
    const bus = new EventBus();
    const { sink, counter, histogram } = makeSink();
    wireMetricsToEvents(bus, sink);
    bus.emit('compaction.fired', { report: { before: 100_000, after: 40_000, reductions: [] } });
    expect(counter).toHaveBeenCalledWith('compaction.fired.total');
    expect(histogram).toHaveBeenCalledWith('compaction.reduction_tokens', 60_000);
  });

  it('counts mcp connect / reconnect / disconnect without server labels', () => {
    const bus = new EventBus();
    const { sink, counter } = makeSink();
    wireMetricsToEvents(bus, sink);
    bus.emit('mcp.server.connected', { name: 'srv-a', toolCount: 3 });
    bus.emit('mcp.server.reconnected', { name: 'srv-a', toolCount: 3 });
    bus.emit('mcp.server.disconnected', { name: 'srv-a', reason: 'eof' });
    expect(counter).toHaveBeenCalledWith('mcp.connects.total');
    expect(counter).toHaveBeenCalledWith('mcp.reconnects.total');
    expect(counter).toHaveBeenCalledWith('mcp.disconnects.total');
  });

  it('counts generic error events with phase label', () => {
    const bus = new EventBus();
    const { sink, counter } = makeSink();
    wireMetricsToEvents(bus, sink);
    bus.emit('error', { err: new Error('boom'), phase: 'provider' });
    expect(counter).toHaveBeenCalledWith('agent.errors.total', 1, { phase: 'provider' });
  });

  it('returns a handle whose dispose() detaches every listener', () => {
    const bus = new EventBus();
    const { sink, counter } = makeSink();
    const handle = wireMetricsToEvents(bus, sink);
    bus.emit('session.started', { id: 's1' });
    expect(counter).toHaveBeenCalledTimes(1);
    counter.mockClear();
    handle.dispose();
    bus.emit('session.started', { id: 's2' });
    bus.emit('iteration.completed', { ctx: {} as never, index: 1 });
    bus.emit('compaction.fired', { before: 100, after: 50 });
    expect(counter).not.toHaveBeenCalled();
  });

  it('exposes the in-process tool-usage Map and updates it on every event', () => {
    const bus = new EventBus();
    const { sink } = makeSink();
    const handle = wireMetricsToEvents(bus, sink);
    expect(handle.getToolUsage().size).toBe(0);
    bus.emit('tool.started', { name: 'read', id: 't1' });
    bus.emit('tool.executed', { name: 'read', durationMs: 25, ok: true });
    bus.emit('tool.executed', { name: 'bash', durationMs: 100, ok: false });
    const usage = handle.getToolUsage();
    expect(usage.get('read')?.invocations).toBe(2);
    expect(usage.get('read')?.failures).toBe(0);
    expect(usage.get('read')?.durationMsTotal).toBe(25);
    expect(usage.get('bash')?.invocations).toBe(1);
    expect(usage.get('bash')?.failures).toBe(1);
    expect(usage.get('bash')?.durationMsTotal).toBe(100);
    handle.dispose();
  });

  it('collapses mcp__ tool names into mcp_proxy in the usage Map', () => {
    const bus = new EventBus();
    const { sink } = makeSink();
    const handle = wireMetricsToEvents(bus, sink);
    bus.emit('tool.started', { name: 'mcp__srv__tool', id: 't1' });
    bus.emit('tool.executed', { name: 'mcp__srv__tool', durationMs: 5, ok: true });
    const usage = handle.getToolUsage();
    expect(usage.get('mcp_proxy')?.invocations).toBe(2);
    expect(usage.has('mcp__srv__tool')).toBe(false);
    handle.dispose();
  });
});
