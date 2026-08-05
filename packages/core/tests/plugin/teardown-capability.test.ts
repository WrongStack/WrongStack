import { describe, expect, it, vi } from 'vitest';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { loadPlugins, unloadPlugins } from '../../src/plugin/loader.js';
import type { Plugin, PluginAPI } from '../../src/types/plugin.js';

const log = new DefaultLogger({ level: 'error' });

/**
 * Build a stub Logger that exposes a vi.fn-backed `warn` (the capability
 * check uses this preferred path). Other levels delegate to a silent noop.
 * Plain object spread of a class instance drops prototype methods, so we
 * build the surface explicitly here.
 */
function makeStubLog(warnSpy: ReturnType<typeof vi.fn>) {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
  } as never;
}

function makeMockApi(): PluginAPI {
  const tools = { register: vi.fn(), unregister: vi.fn(), get: vi.fn(), list: vi.fn() };
  const providers = { register: vi.fn(), create: vi.fn(), list: vi.fn() };
  const slashCommands = { register: vi.fn(), unregister: vi.fn(), get: vi.fn(), list: vi.fn() };
  const mcp = { start: vi.fn(), stop: vi.fn(), restart: vi.fn(), list: vi.fn() };
  return {
    container: {} as never,
    pipelines: {} as never,
    events: {} as never,
    tools: tools as never,
    providers: providers as never,
    mcp: mcp as never,
    slashCommands: slashCommands as never,
    config: {} as never,
    log,
    onEvent: vi.fn() as never,
  };
}

function p(overrides: Partial<Plugin> & { name: string }): Plugin {
  return {
    apiVersion: '^0.1',
    setup: () => undefined,
    ...overrides,
  };
}

describe('unloadPlugins', () => {
  it('calls teardown on each loaded plugin in reverse order', async () => {
    const order: string[] = [];
    const plugins = [
      p({
        name: 'a',
        teardown: async () => {
          order.push('a');
        },
      }),
      p({
        name: 'b',
        teardown: async () => {
          order.push('b');
        },
        dependsOn: ['a'],
      }),
    ];
    const api = makeMockApi();
    const { loaded } = await loadPlugins(plugins, {
      apiFactory: () => api,
      log,
    });
    expect(loaded.map((x) => x.name)).toEqual(['a', 'b']);

    await unloadPlugins(loaded, { apiFactory: () => api, log });
    // b loaded last → torn down first
    expect(order).toEqual(['b', 'a']);
  });

  it('skips plugins without a teardown function', async () => {
    const plugins = [p({ name: 'no-teardown' })];
    const { loaded } = await loadPlugins(plugins, {
      apiFactory: () => makeMockApi(),
      log,
    });
    await expect(
      unloadPlugins(loaded, { apiFactory: () => makeMockApi(), log }),
    ).resolves.toBeUndefined();
  });

  it('swallows teardown errors and continues with siblings', async () => {
    const calls: string[] = [];
    const plugins = [
      p({
        name: 'good1',
        teardown: async () => {
          calls.push('good1');
        },
      }),
      p({
        name: 'bad',
        teardown: async () => {
          calls.push('bad');
          throw new Error('boom');
        },
      }),
      p({
        name: 'good2',
        teardown: async () => {
          calls.push('good2');
        },
        dependsOn: ['good1'],
      }),
    ];
    const api = makeMockApi();
    const { loaded } = await loadPlugins(plugins, { apiFactory: () => api, log });
    await unloadPlugins(loaded, { apiFactory: () => api, log });
    // All three teardowns invoked despite the middle one throwing
    expect(calls).toContain('good1');
    expect(calls).toContain('bad');
    expect(calls).toContain('good2');
  });
});

describe('Plugin capability runtime check', () => {
  it('logs a warning when plugin uses tools but declared capabilities.tools=false', async () => {
    const warnSpy = vi.fn();
    const customLog = makeStubLog(warnSpy);
    const api = makeMockApi();

    await loadPlugins(
      [
        p({
          name: 'sneaky',
          capabilities: { tools: false },
          setup: (a) => {
            a.tools.register({ name: 'rogue' } as never);
          },
        }),
      ],
      { apiFactory: () => api, log: customLog },
    );

    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0]![0];
    expect(msg).toMatch(/sneaky/);
    expect(msg).toMatch(/tools/);
    expect(msg).toMatch(/rogue/);
  });

  it('does not warn when capability is declared true', async () => {
    const warnSpy = vi.fn();
    const customLog = makeStubLog(warnSpy);
    const api = makeMockApi();

    await loadPlugins(
      [
        p({
          name: 'honest',
          capabilities: { tools: true },
          setup: (a) => {
            a.tools.register({ name: 'ok' } as never);
          },
        }),
      ],
      { apiFactory: () => api, log: customLog },
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn when capabilities object is absent (no claims, no lies)', async () => {
    const warnSpy = vi.fn();
    const customLog = makeStubLog(warnSpy);
    const api = makeMockApi();

    await loadPlugins(
      [
        p({
          name: 'silent',
          // No capabilities field at all
          setup: (a) => {
            a.tools.register({ name: 'unannounced' } as never);
          },
        }),
      ],
      { apiFactory: () => api, log: customLog },
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('still completes the underlying registration even when warning fires', async () => {
    const api = makeMockApi();
    await loadPlugins(
      [
        p({
          name: 'sneaky',
          capabilities: { tools: false },
          setup: (a) => {
            a.tools.register({ name: 'gets-registered' } as never);
          },
        }),
      ],
      { apiFactory: () => api, log: makeStubLog(vi.fn()) },
    );
    // Plugin still gets its work done; we only flag the discrepancy
    expect(api.tools.register as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it('warns on slashCommands.register too', async () => {
    const warnSpy = vi.fn();
    const api = makeMockApi();
    await loadPlugins(
      [
        p({
          name: 'sneaky',
          capabilities: { slashCommands: false },
          setup: (a) => {
            a.slashCommands.register({ name: 'rogue-cmd' } as never);
          },
        }),
      ],
      { apiFactory: () => api, log: makeStubLog(warnSpy) },
    );
    expect(warnSpy.mock.calls[0]![0]).toMatch(/slashCommands/);
  });

  it('warns on providers.register and mcp.start', async () => {
    const warnSpy = vi.fn();
    const api = makeMockApi();
    await loadPlugins(
      [
        p({
          name: 'p1',
          capabilities: { providers: false },
          setup: (a) => {
            a.providers.register({ type: 'fake' } as never);
          },
        }),
        p({
          name: 'p2',
          capabilities: { mcp: false },
          setup: async (a) => {
            await a.mcp.start({ name: 'svc' });
          },
        }),
      ],
      { apiFactory: () => api, log: makeStubLog(warnSpy) },
    );
    const all = warnSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(all).toMatch(/providers/);
    expect(all).toMatch(/mcp/);
  });

  it('warns on every api.llm operation when capabilities.llm=false', async () => {
    const warnSpy = vi.fn();
    const complete = vi.fn().mockResolvedValue({ text: 'ok' });
    const council = vi.fn().mockResolvedValue({ status: 'decided', answer: 'ok' });
    const api = {
      ...makeMockApi(),
      llm: {
        defaults: () => ({ provider: 'test', model: 'test' }),
        complete,
        council,
      },
    } as PluginAPI;

    await loadPlugins(
      [
        p({
          name: 'sneaky-llm',
          capabilities: { llm: false },
          setup: async (a) => {
            await a.llm?.complete('hello');
            await a.llm?.council?.('review this');
          },
        }),
      ],
      { apiFactory: () => api, log: makeStubLog(warnSpy) },
    );

    const warnings = warnSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(warnings).toMatch(/capabilities\.llm/);
    expect(warnings).toMatch(/complete\(5 chars\)/);
    expect(warnings).toMatch(/council\(11 chars\)/);
    expect(complete).toHaveBeenCalledWith('hello');
    expect(council).toHaveBeenCalledWith('review this');
  });
});
