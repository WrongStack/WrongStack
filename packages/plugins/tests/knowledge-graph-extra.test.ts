/**
 * Additional tests for knowledge-graph plugin — covering uncovered paths.
 * Tests: disabled plugin, fact limit, empty fields, system prompt contributor,
 * kg_status, kg_remove_fact errors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const knowledgeGraphPlugin = (await import('../src/knowledge-graph')).default;

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: { counter: ReturnType<typeof vi.fn> };
  registerSystemPromptContributor: ReturnType<typeof vi.fn>;
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? { 'knowledge-graph': { filePath: '' } } },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
    registerSystemPromptContributor: vi.fn(() => vi.fn()),
  };
}

function getTool(api: MockApi, name: string): (input: unknown) => Promise<unknown> {
  const call = api.tools.register.mock.calls.find((c) => (c[0] as { name: string }).name === name);
  if (!call) throw new Error(`tool ${name} not registered`);
  return (call[0] as { execute: (input: unknown) => Promise<unknown> }).execute;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  const api = makeApi();
  await knowledgeGraphPlugin.teardown?.(api as never);
});

describe('knowledge-graph plugin - additional coverage', () => {
  it('kg_add_fact returns error when plugin is disabled', async () => {
    const api = makeApi({ extensions: { 'knowledge-graph': { enabled: false, filePath: '' } } });
    knowledgeGraphPlugin.setup(api as never);
    const add = getTool(api, 'kg_add_fact');
    const result = (await add({ subject: 'a', relation: 'b', object: 'c' })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('disabled');
  });

  it('kg_add_fact returns error when subject is empty', async () => {
    const api = makeApi();
    knowledgeGraphPlugin.setup(api as never);
    const add = getTool(api, 'kg_add_fact');
    const result = (await add({ subject: '', relation: 'b', object: 'c' })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('required');
  });

  it('kg_add_fact returns error when relation is empty', async () => {
    const api = makeApi();
    knowledgeGraphPlugin.setup(api as never);
    const add = getTool(api, 'kg_add_fact');
    const result = (await add({ subject: 'a', relation: '', object: 'c' })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('required');
  });

  it('kg_add_fact returns error when object is empty', async () => {
    const api = makeApi();
    knowledgeGraphPlugin.setup(api as never);
    const add = getTool(api, 'kg_add_fact');
    const result = (await add({ subject: 'a', relation: 'b', object: '' })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('required');
  });

  it('kg_add_fact returns error when fact limit is reached', async () => {
    const api = makeApi({ extensions: { 'knowledge-graph': { maxFacts: 1, filePath: '' } } });
    knowledgeGraphPlugin.setup(api as never);
    const add = getTool(api, 'kg_add_fact');
    await add({ subject: 'a', relation: 'b', object: 'c' });
    const result = (await add({ subject: 'd', relation: 'e', object: 'f' })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('limit');
  });

  it('kg_status returns correct state', async () => {
    const api = makeApi();
    knowledgeGraphPlugin.setup(api as never);
    const add = getTool(api, 'kg_add_fact');
    const status = getTool(api, 'kg_status');
    await add({ subject: 'a', relation: 'b', object: 'c' });
    const result = (await status({})) as { ok: boolean; totalFacts: number; enabled: boolean };
    expect(result.ok).toBe(true);
    expect(result.totalFacts).toBe(1);
    expect(result.enabled).toBe(true);
  });

  it('kg_remove_fact returns error when id is missing', async () => {
    const api = makeApi();
    knowledgeGraphPlugin.setup(api as never);
    const remove = getTool(api, 'kg_remove_fact');
    const result = (await remove({})) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no fact matches');
  });

  it('system prompt contributor is registered when enabled', async () => {
    const api = makeApi({
      extensions: { 'knowledge-graph': { contributeToSystemPrompt: true, filePath: '' } },
    });
    knowledgeGraphPlugin.setup(api as never);
    expect(api.registerSystemPromptContributor).toHaveBeenCalled();
  });

  it('system prompt contributor is not registered when disabled', async () => {
    const api = makeApi({
      extensions: { 'knowledge-graph': { contributeToSystemPrompt: false, filePath: '' } },
    });
    knowledgeGraphPlugin.setup(api as never);
    expect(api.registerSystemPromptContributor).not.toHaveBeenCalled();
  });
});
