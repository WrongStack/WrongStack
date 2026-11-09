/**
 * `wstack acp` must start before a provider exists (an editor installing from
 * the ACP registry runs it on a fresh machine) and pick the provider up once
 * `wstack auth` has written it, without a restart.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const built = vi.hoisted(() => ({
  factories: [] as Array<{ config: unknown; disposed: string[]; selected: string[] }>,
  telemetryStops: 0,
  detached: [] as string[],
}));

vi.mock('../src/acp-server-agent.js', () => {
  class AcpServerConfigError extends Error {}
  return {
    AcpServerConfigError,
    buildAcpServerAgentFactory: (deps: { config: unknown }) => {
      const record = { config: deps.config, disposed: [] as string[], selected: [] as string[] };
      built.factories.push(record);
      return Object.assign(async (sessionId: string) => ({ sessionId }) as never, {
        disposeSession: (sessionId: string) => record.disposed.push(sessionId),
        selectModel: async (_agent: unknown, providerId: string, modelId: string) => {
          record.selected.push(`${providerId}/${modelId}`);
        },
      });
    },
  };
});

vi.mock('../src/acp-hq-telemetry.js', () => ({
  startAcpHqTelemetry: () => ({
    wrapAgentFactory: <T>(f: T) => f,
    wrapDispose: (dispose: (id: string) => void) => (id: string) => {
      built.detached.push(id);
      dispose(id);
    },
    active: () => [],
    stop: () => {
      built.telemetryStops++;
    },
  }),
}));

import { ACP_LOGIN_HINT, createAcpServerRuntime } from '../src/acp-server-runtime.js';

const CONFIGURED = { provider: 'openai', model: 'gpt-4o-mini' };

function deps(config: Record<string, unknown> = {}) {
  return { config, cwd: '/tmp/project', flags: {} } as never;
}

beforeEach(() => {
  built.factories.length = 0;
  built.telemetryStops = 0;
  built.detached.length = 0;
});

describe('createAcpServerRuntime', () => {
  it('starts unconfigured and stays not ready while the saved config has no provider', async () => {
    const reloadConfig = vi.fn(async () => ({}) as never);
    const runtime = createAcpServerRuntime(deps(), { reloadConfig });
    expect(runtime.ready()).toBe(false);
    expect(runtime.describe()).toBeUndefined();
    expect(await runtime.authGate()).toEqual({ ok: false, message: ACP_LOGIN_HINT });
    expect(reloadConfig).toHaveBeenCalledTimes(1);
    expect(built.factories).toHaveLength(0);
    await expect(runtime.agentFor('s1', '/tmp')).rejects.toThrow(ACP_LOGIN_HINT);
  });

  it('builds the agent from the reloaded config once a provider appears', async () => {
    let saved: Record<string, unknown> = {};
    const reloadConfig = vi.fn(async () => saved as never);
    const runtime = createAcpServerRuntime(deps(), { reloadConfig });
    expect((await runtime.authGate()).ok).toBe(false);

    saved = CONFIGURED; // `wstack auth` finished in a terminal
    expect(await runtime.authGate()).toEqual({ ok: true });
    expect(runtime.ready()).toBe(true);
    expect(runtime.describe()).toBe('openai/gpt-4o-mini');
    expect(built.factories).toHaveLength(1);
    expect(built.factories[0]?.config).toBe(CONFIGURED);

    // Once ready, the config is not re-read on every request.
    await runtime.authGate();
    expect(reloadConfig).toHaveBeenCalledTimes(2);
  });

  it('shares one reload and one build between concurrent session requests', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reloadConfig = vi.fn(async () => {
      await gate;
      return CONFIGURED as never;
    });
    const runtime = createAcpServerRuntime(deps(), { reloadConfig });
    const checks = [runtime.authGate(), runtime.authGate(), runtime.agentFor('s1', '/tmp')];
    release();
    await Promise.all(checks);
    expect(reloadConfig).toHaveBeenCalledTimes(1);
    expect(built.factories).toHaveLength(1);
  });

  it('reports an unreadable config as not ready instead of throwing', async () => {
    const runtime = createAcpServerRuntime(deps(), {
      reloadConfig: async () => {
        throw new Error('bad json');
      },
    });
    const result = await runtime.authGate();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('bad json');
  });

  it('builds eagerly when the boot config already has a provider', async () => {
    const reloadConfig = vi.fn();
    const runtime = createAcpServerRuntime(deps(CONFIGURED), { reloadConfig });
    expect(runtime.ready()).toBe(true);
    expect(await runtime.authGate()).toEqual({ ok: true });
    expect(reloadConfig).not.toHaveBeenCalled();
  });

  it('tears a session down through telemetry, the turn and the MCP servers', () => {
    const runtime = createAcpServerRuntime(deps(CONFIGURED), { reloadConfig: vi.fn() });
    const turnDispose = vi.fn();
    runtime.composeDispose(turnDispose)('s1');
    expect(built.detached).toEqual(['s1']);
    expect(turnDispose).toHaveBeenCalledWith('s1');
    expect(built.factories[0]?.disposed).toEqual(['s1']);
    runtime.stop();
    expect(built.telemetryStops).toBe(1);
  });

  it('offers a model picker only once a provider is configured', async () => {
    const buildModelOption = vi.fn(async () => ({
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'openai/gpt-4o-mini',
      options: [{ value: 'openai/gpt-4o-mini', name: 'gpt-4o-mini' }],
    }));
    const unconfigured = createAcpServerRuntime(deps(), {
      reloadConfig: async () => ({}) as never,
      buildModelOption,
    });
    expect(await unconfigured.sessionConfigOptions()).toEqual([]);
    expect(buildModelOption).not.toHaveBeenCalled();

    const runtime = createAcpServerRuntime(deps(CONFIGURED), {
      reloadConfig: vi.fn(),
      buildModelOption,
    });
    const [option] = await runtime.sessionConfigOptions();
    expect(option?.category).toBe('model');
    expect(buildModelOption).toHaveBeenCalledWith(expect.objectContaining({ config: CONFIGURED }));
  });

  it('puts the agent on the selected model, and ignores options without a model choice', async () => {
    const runtime = createAcpServerRuntime(deps(CONFIGURED), { reloadConfig: vi.fn() });
    const agent = {} as never;
    await runtime.applyConfigOptions(agent, [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'openrouter/anthropic/claude-x',
        options: [],
      },
    ]);
    await runtime.applyConfigOptions(agent, [
      { id: 'size', name: 'Size', type: 'select', currentValue: 'a/b', options: [] },
    ]);
    expect(built.factories[0]?.selected).toEqual(['openrouter/anthropic/claude-x']);
  });

  it('still runs the turn teardown while unconfigured', () => {
    const runtime = createAcpServerRuntime(deps(), { reloadConfig: vi.fn() });
    const turnDispose = vi.fn();
    runtime.composeDispose(turnDispose)('s1');
    expect(turnDispose).toHaveBeenCalledWith('s1');
    runtime.stop();
  });
});
