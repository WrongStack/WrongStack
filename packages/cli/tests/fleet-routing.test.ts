/**
 * Tests for fleet/routing.ts — routing runner builder with ACP branch.
 */
import { describe, expect, it, vi } from 'vitest';

describe('buildRoutingRunner', () => {
  it('merges profile and session ACP defaults beneath explicit lane settings', async () => {
    const { buildRoutingRunner } = await import('@wrongstack/fleet');
    const { setSessionAcpRuntime, resetSessionSubagentModelPlan } = await import(
      '@wrongstack/coordination'
    );
    const external = vi.fn().mockResolvedValue({ result: 'done' });
    const host = {
      makeSubagentFactory: vi.fn(),
      getDirector: () => undefined,
      buildACPRunner: vi.fn().mockResolvedValue(external),
    };
    await setSessionAcpRuntime(
      { session: { id: 'acp-defaults-test', append: async () => {} } },
      { fixture: { engine: 'session', thought: 'medium' } },
    );
    try {
      const run = buildRoutingRunner(
        { modelRuntime: { acp: { fixture: { engine: 'profile', fast: 'on' } } } } as never,
        host,
      );
      await run({ id: 'task', description: 'work' }, {
        sessionId: 'acp-defaults-test',
        config: {
          provider: 'acp',
          model: 'fixture',
          modelRuntime: { acp: { fixture: { thought: 'ultra' } } },
        },
      } as never);
      expect(external.mock.calls[0]![1].config.modelRuntime.acp.fixture).toEqual({
        engine: 'session',
        fast: 'on',
        thought: 'ultra',
      });
    } finally {
      resetSessionSubagentModelPlan('acp-defaults-test');
    }
  });
  it.each(['pi-acp', 'opencode-classic'])(
    'runs the agent selected in an ACP model lane (%s)',
    async (model) => {
      const { buildRoutingRunner } = await import('@wrongstack/fleet');
      const external = vi.fn().mockResolvedValue({ result: 'external-result' });
      const host = {
        makeSubagentFactory: vi.fn().mockReturnValue(vi.fn()),
        getDirector: () => undefined,
        buildACPRunner: vi.fn().mockResolvedValue(external),
      };
      const run = buildRoutingRunner({} as never, host);
      const task = { id: 'selected-task', description: 'Review the change' };
      const ctx = {
        config: {
          id: 'worker-uuid',
          name: 'Review worker',
          role: 'general',
          provider: 'acp',
          model,
        },
      };
      expect(await run(task, ctx as never)).toEqual({ result: 'external-result' });
      expect(host.buildACPRunner).toHaveBeenCalledWith(model);
      expect(external).toHaveBeenCalledWith(task, ctx);
    },
  );

  it('keeps the legacy WrongForge worker name when its model names the upstream model', async () => {
    const { buildRoutingRunner } = await import('@wrongstack/fleet');
    const host = {
      makeSubagentFactory: vi.fn().mockReturnValue(vi.fn()),
      getDirector: () => undefined,
      buildACPRunner: vi.fn().mockResolvedValue(vi.fn()),
    };
    await buildRoutingRunner({} as never, host)({ id: 't', description: 'Review' }, {
      config: { provider: 'acp', role: 'wrongforge', model: 'vendor/model' },
    } as never);
    expect(host.buildACPRunner).toHaveBeenCalledWith('wrongforge');
  });
  it('exports the function', async () => {
    const mod = await import('@wrongstack/fleet');
    expect(typeof mod.buildRoutingRunner).toBe('function');
  });

  it('returns a runner function', async () => {
    const mod = await import('@wrongstack/fleet');
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
    const mod = await import('@wrongstack/fleet');
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
    const mod = await import('@wrongstack/fleet');
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
    const mod = await import('@wrongstack/fleet');
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
