import { describe, expect, it, vi } from 'vitest';
import { buildHealthCommand } from '../src/slash-commands/health.js';

describe('/health', () => {
  it('reports "health checks not enabled" without registry', async () => {
    const cmd = buildHealthCommand({} as never);
    const res = await cmd.run('');
    expect((res as { message?: string })?.message).toContain('Health checks not enabled');
  });

  it('exposes deep help and structured unavailable output', async () => {
    const cmd = buildHealthCommand({} as never);
    expect(cmd.category).toBe('Inspect');
    expect(cmd.argsHint).toBe('[--json]');
    expect(cmd.help).toContain('Usage: /health [--json]');
    const res = await cmd.run('--json');
    const out = (res as { message?: string })?.message ?? '';
    expect(out).toContain('"status": "unavailable"');
  });

  it('runs all checks and summarizes the worst status', async () => {
    const registry = {
      run: vi.fn(async () => ({
        timestamp: 0,
        status: 'unhealthy',
        checks: [
          { name: 'session-store', status: 'healthy' },
          { name: 'provider', status: 'unhealthy', detail: 'rate limited' },
          { name: 'cache', status: 'degraded', detail: 'stale' },
        ],
      })),
    };
    const cmd = buildHealthCommand({ healthRegistry: registry as never } as never);
    const res = await cmd.run('');
    const out = (res as { message?: string })?.message ?? '';
    expect(out).toContain('overall: unhealthy');
    expect(out).toContain('session-store: healthy');
    expect(out).toContain('provider: unhealthy');
    expect(out).toContain('rate limited');
  });

  it('emits JSON when --json is passed', async () => {
    const registry = {
      run: vi.fn(async () => ({
        timestamp: 42,
        status: 'healthy',
        checks: [{ name: 'db', status: 'healthy' }],
      })),
    };
    const cmd = buildHealthCommand({ healthRegistry: registry as never } as never);
    const res = await cmd.run('--json');
    const out = (res as { message?: string })?.message ?? '';
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe('healthy');
    expect(parsed.timestamp).toBe(42);
  });
});
