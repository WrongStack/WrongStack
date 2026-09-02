import { describe, expect, it } from 'vitest';
import { DefaultHealthRegistry } from '../../src/observability/health.js';
import type { HealthCheck } from '../../src/types/observability.js';

const check = (name: string, impl: HealthCheck['check']): HealthCheck => ({ name, check: impl });

describe('DefaultHealthRegistry', () => {
  it('reports healthy with no checks', async () => {
    const r = new DefaultHealthRegistry();
    const result = await r.run();
    expect(result.status).toBe('healthy');
    expect(result.checks).toEqual([]);
    expect(typeof result.timestamp).toBe('number');
  });

  it('runs registered checks and includes results', async () => {
    const r = new DefaultHealthRegistry();
    r.register(check('a', async () => ({ status: 'healthy' })));
    r.register(check('b', async () => ({ status: 'healthy', detail: 'ok' })));
    const result = await r.run();
    expect(result.status).toBe('healthy');
    expect(result.checks).toHaveLength(2);
    expect(result.checks.map((c) => c.name).sort()).toEqual(['a', 'b']);
    const b = result.checks.find((c) => c.name === 'b');
    expect(b?.detail).toBe('ok');
  });

  it('picks the worst status across checks (degraded beats healthy)', async () => {
    const r = new DefaultHealthRegistry();
    r.register(check('ok', async () => ({ status: 'healthy' })));
    r.register(check('slow', async () => ({ status: 'degraded' })));
    const result = await r.run();
    expect(result.status).toBe('degraded');
  });

  it('picks the worst status (unhealthy beats degraded)', async () => {
    const r = new DefaultHealthRegistry();
    r.register(check('a', async () => ({ status: 'healthy' })));
    r.register(check('b', async () => ({ status: 'degraded' })));
    r.register(check('c', async () => ({ status: 'unhealthy', detail: 'down' })));
    const result = await r.run();
    expect(result.status).toBe('unhealthy');
  });

  it('captures thrown exceptions as unhealthy', async () => {
    const r = new DefaultHealthRegistry();
    r.register(
      check('boom', async () => {
        throw new Error('explode');
      }),
    );
    const result = await r.run();
    expect(result.status).toBe('unhealthy');
    expect(result.checks[0]!.status).toBe('unhealthy');
    expect(result.checks[0]!.detail).toBe('explode');
  });

  it('captures non-Error throws as unhealthy with string detail', async () => {
    const r = new DefaultHealthRegistry();
    r.register(
      check('plain', async () => {
        throw 'oops';
      }),
    );
    const result = await r.run();
    expect(result.checks[0]!.detail).toBe('oops');
  });

  it('times out a slow check and marks it unhealthy', async () => {
    const r = new DefaultHealthRegistry({ timeoutMs: 30 });
    r.register(
      check(
        'slow',
        () => new Promise((resolve) => setTimeout(() => resolve({ status: 'healthy' }), 200)),
      ),
    );
    const result = await r.run();
    expect(result.status).toBe('unhealthy');
    expect(result.checks[0]!.detail).toMatch(/timeout after 30ms/);
  });

  it('unregister removes a previously registered check', async () => {
    const r = new DefaultHealthRegistry();
    r.register(check('a', async () => ({ status: 'unhealthy' })));
    r.unregister('a');
    const result = await r.run();
    expect(result.status).toBe('healthy');
    expect(result.checks).toEqual([]);
  });

  it('register replaces an existing check of the same name', async () => {
    const r = new DefaultHealthRegistry();
    r.register(check('a', async () => ({ status: 'unhealthy' })));
    r.register(check('a', async () => ({ status: 'healthy' })));
    const result = await r.run();
    expect(result.status).toBe('healthy');
    expect(result.checks).toHaveLength(1);
  });

  it('runs checks in parallel (total time ~ slowest)', async () => {
    const r = new DefaultHealthRegistry({ timeoutMs: 2000 });
    const slow = (ms: number) =>
      check(
        `slow-${ms}`,
        () =>
          new Promise<{ status: 'healthy' }>((resolve) =>
            setTimeout(() => resolve({ status: 'healthy' }), ms),
          ),
      );
    r.register(slow(300));
    r.register(slow(300));
    r.register(slow(300));
    const start = Date.now();
    const result = await r.run();
    const elapsed = Date.now() - start;
    expect(result.status).toBe('healthy');
    // Serial execution would take 900ms+. A 750ms bound proves parallelism
    // while leaving slack for late timer firing under full-suite load (a
    // 50ms/140ms version of this flaked: only a 10ms discrimination window).
    expect(elapsed).toBeLessThan(750);
  });
});
