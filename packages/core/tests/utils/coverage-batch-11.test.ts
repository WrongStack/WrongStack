import { describe, it, expect, vi } from 'vitest';
import { NoopTracer } from '../../src/observability/tracer.js';
import { DefaultHealthRegistry } from '../../src/observability/health.js';
import { OTelTracer } from '../../src/observability/otel-tracer.js';

// ── NoopTracer ───────────────────────────────────────────────────────────

describe('NoopTracer', () => {
  it('startSpan returns a span with no-op methods', () => {
    const tracer = new NoopTracer();
    const span = tracer.startSpan();
    expect(() => span.setAttribute('k', 'v')).not.toThrow();
    expect(() => span.recordError(new Error('x'))).not.toThrow();
    expect(() => span.end()).not.toThrow();
  });
});

// ── DefaultHealthRegistry ────────────────────────────────────────────────

describe('DefaultHealthRegistry', () => {
  it('returns healthy when no checks registered', async () => {
    const reg = new DefaultHealthRegistry();
    const result = await reg.run();
    expect(result.status).toBe('healthy');
    expect(result.checks).toEqual([]);
  });

  it('returns healthy when all checks pass', async () => {
    const reg = new DefaultHealthRegistry();
    reg.register({ name: 'db', check: async () => ({ status: 'healthy' }) });
    reg.register({ name: 'cache', check: async () => ({ status: 'healthy' }) });
    const result = await reg.run();
    expect(result.status).toBe('healthy');
    expect(result.checks).toHaveLength(2);
  });

  it('worst status wins (one unhealthy makes all unhealthy)', async () => {
    const reg = new DefaultHealthRegistry();
    reg.register({ name: 'db', check: async () => ({ status: 'healthy' }) });
    reg.register({ name: 'queue', check: async () => ({ status: 'unhealthy', detail: 'down' }) });
    const result = await reg.run();
    expect(result.status).toBe('unhealthy');
    expect(result.checks.find((c) => c.name === 'queue')?.status).toBe('unhealthy');
  });

  it('degraded is between healthy and unhealthy', async () => {
    const reg = new DefaultHealthRegistry();
    reg.register({ name: 'a', check: async () => ({ status: 'degraded' }) });
    reg.register({ name: 'b', check: async () => ({ status: 'healthy' }) });
    const result = await reg.run();
    expect(result.status).toBe('degraded');
  });

  it('catches check errors as unhealthy', async () => {
    const reg = new DefaultHealthRegistry();
    reg.register({
      name: 'fail',
      check: async () => {
        throw new Error('crash');
      },
    });
    const result = await reg.run();
    expect(result.status).toBe('unhealthy');
    expect(result.checks[0]?.detail).toContain('crash');
  });

  it('unregister removes a check', async () => {
    const reg = new DefaultHealthRegistry();
    reg.register({ name: 'temp', check: async () => ({ status: 'unhealthy' }) });
    reg.unregister('temp');
    const result = await reg.run();
    expect(result.status).toBe('healthy');
  });

  it('times out slow checks', async () => {
    const reg = new DefaultHealthRegistry({ timeoutMs: 50 });
    reg.register({
      name: 'slow',
      check: () => new Promise((resolve) => setTimeout(() => resolve({ status: 'healthy' }), 500)),
    });
    const result = await reg.run();
    expect(result.status).toBe('unhealthy');
    expect(result.checks[0]?.detail).toContain('timeout');
  });
});

// ── OTelTracer ───────────────────────────────────────────────────────────

describe('OTelTracer', () => {
  it('startSpan delegates to upstream tracer', () => {
    const mockSpan = {
      setAttribute: vi.fn(),
      recordException: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn(() => mockSpan),
    };
    const tracer = new OTelTracer(mockTracer as any);
    const span = tracer.startSpan('test-span');
    expect(mockTracer.startSpan).toHaveBeenCalledWith('test-span', undefined);
    // Verify span methods delegate
    span.setAttribute('key', 'value');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('key', 'value');
    span.recordError(new Error('test'));
    expect(mockSpan.recordException).toHaveBeenCalled();
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 2, message: 'test' });
    span.end();
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('passes attributes to upstream', () => {
    const mockSpan = { setAttribute: vi.fn(), recordException: vi.fn(), end: vi.fn() };
    const mockTracer = { startSpan: vi.fn(() => mockSpan) };
    const tracer = new OTelTracer(mockTracer as any);
    tracer.startSpan('op', { attr1: 'val1', attr2: 42 });
    expect(mockTracer.startSpan).toHaveBeenCalledWith('op', {
      attributes: { attr1: 'val1', attr2: 42 },
    });
  });
});
