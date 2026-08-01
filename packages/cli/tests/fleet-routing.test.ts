/**
 * Tests for fleet/routing.ts — routing runner builder with ACP branch.
 */
import { describe, expect, it, vi } from 'vitest';

describe('buildRoutingRunner', () => {
  it('exports the function', async () => {
    const mod = await import('../src/fleet/routing.js');
    expect(typeof mod.buildRoutingRunner).toBe('function');
  });

  it('returns a runner function', async () => {
    const mod = await import('../src/fleet/routing.js');
    const host = {
      makeSubagentFactory: vi.fn().mockReturnValue(vi.fn()),
      getDirector: vi.fn().mockReturnValue(undefined),
      buildACPRunner: vi.fn(),
    };
    const config = { provider: 'test' };
    const runner = mod.buildRoutingRunner(config as never, host as never);
    expect(typeof runner).toBe('function');
  });

  it('delegates ACP tasks to buildACPRunner', async () => {
    const mod = await import('../src/fleet/routing.js');
    const acpRunner = vi.fn().mockResolvedValue({ status: 'completed' });
    const host = {
      makeSubagentFactory: vi.fn().mockReturnValue(vi.fn()),
      getDirector: vi.fn().mockReturnValue({ fleet: {} }),
      buildACPRunner: vi.fn().mockResolvedValue(acpRunner),
    };
    const config = { provider: 'test' };
    const runner = mod.buildRoutingRunner(config as never, host as never);

    const task = { id: 'test-task', description: 'test' };
    const ctx = { config: { provider: 'acp', role: 'worker', id: 'test-id' } };
    const result = await runner(task as never, ctx as never);

    expect(host.buildACPRunner).toHaveBeenCalledWith('worker');
    expect(acpRunner).toHaveBeenCalledWith(task, ctx);
    expect(result).toEqual({ status: 'completed' });
  });

  it('uses role for ACP cacheKey when available', async () => {
    const mod = await import('../src/fleet/routing.js');
    const acpRunner = vi.fn().mockResolvedValue({ status: 'completed' });
    const host = {
      makeSubagentFactory: vi.fn().mockReturnValue(vi.fn()),
      getDirector: vi.fn().mockReturnValue({ fleet: {} }),
      buildACPRunner: vi.fn().mockResolvedValue(acpRunner),
    };
    const config = { provider: 'test' };
    const runner = mod.buildRoutingRunner(config as never, host as never);

    await runner(
      { id: 't', description: 't' } as never,
      { config: { provider: 'acp', role: 'specialist' } } as never,
    );
    expect(host.buildACPRunner).toHaveBeenCalledWith('specialist');
  });

  it('falls back to id for cacheKey when role and name are absent', async () => {
    const mod = await import('../src/fleet/routing.js');
    const acpRunner = vi.fn().mockResolvedValue({ status: 'completed' });
    const host = {
      makeSubagentFactory: vi.fn().mockReturnValue(vi.fn()),
      getDirector: vi.fn().mockReturnValue({ fleet: {} }),
      buildACPRunner: vi.fn().mockResolvedValue(acpRunner),
    };
    const config = { provider: 'test' };
    const runner = mod.buildRoutingRunner(config as never, host as never);

    await runner(
      { id: 't', description: 't' } as never,
      { config: { provider: 'acp', id: 'direct-id' } } as never,
    );
    expect(host.buildACPRunner).toHaveBeenCalledWith('direct-id');
  });
});
