import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';

const knowledgeGraphPlugin = (await import('../src/knowledge-graph')).default;

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: {
    counter: ReturnType<typeof vi.fn>;
  };
  registerSystemPromptContributor: ReturnType<typeof vi.fn>;
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: {
      extensions: overrides.extensions ?? { 'knowledge-graph': { filePath: '' } },
    },
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

describe('knowledge-graph plugin', () => {
  it('registers four tools and a system prompt contributor', async () => {
    const api = makeApi();
    knowledgeGraphPlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(4);
    expect(api.registerSystemPromptContributor).toHaveBeenCalledTimes(1);
  });

  it('kg_add_fact stores a fact', async () => {
    const api = makeApi();
    knowledgeGraphPlugin.setup(api as never);
    const add = getTool(api, 'kg_add_fact');
    const result = (await add({
      subject: 'auth-service',
      relation: 'depends_on',
      object: 'postgres',
      confidence: 'high',
    })) as { ok: boolean; fact: { id: string }; totalFacts: number };
    expect(result.ok).toBe(true);
    expect(result.fact.id).toMatch(/^kg-/);
    expect(result.totalFacts).toBe(1);
  });

  it('kg_query finds facts by subject', async () => {
    const api = makeApi();
    knowledgeGraphPlugin.setup(api as never);
    const add = getTool(api, 'kg_add_fact');
    const query = getTool(api, 'kg_query');
    await add({ subject: 'auth-service', relation: 'uses', object: 'jwt' });
    const result = (await query({ subject: 'auth' })) as {
      ok: boolean;
      totalFacts: number;
      returned: number;
    };
    expect(result.ok).toBe(true);
    expect(result.returned).toBe(1);
  });

  it('kg_remove_fact deletes by id', async () => {
    const api = makeApi();
    knowledgeGraphPlugin.setup(api as never);
    const add = getTool(api, 'kg_add_fact');
    const remove = getTool(api, 'kg_remove_fact');
    const added = (await add({ subject: 'x', relation: 'y', object: 'z' })) as { fact: { id: string } };
    const result = (await remove({ id: added.fact.id })) as { ok: boolean; removed: number };
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(1);
  });

  it('enabled:false disables tools and reports disabled', async () => {
    const api = makeApi({ extensions: { 'knowledge-graph': { enabled: false } } });
    knowledgeGraphPlugin.setup(api as never);
    const add = getTool(api, 'kg_add_fact');
    const result = (await add({})) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
  });

  it('teardown zeros state and logs', async () => {
    const api = makeApi();
    knowledgeGraphPlugin.setup(api as never);
    knowledgeGraphPlugin.teardown!(api as never);
    const health = (await knowledgeGraphPlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['facts']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'knowledge-graph: teardown complete',
      expect.any(Object),
    );
  });

  it('refuses a relative store path that escapes the project root', async () => {
    // Regression: resolveProjectPath used to pass absolute paths and `..`
    // traversal straight through. The store both READS and WRITES the file,
    // so an uncontained config path meant arbitrary-file I/O.
    const api = makeApi({
      extensions: { 'knowledge-graph': { filePath: '../kg-escape-probe.json' } },
    });
    knowledgeGraphPlugin.setup(api as never);
    const status = (await getTool(api, 'kg_status')({})) as {
      resolvedPath: string | null;
    };
    expect(status.resolvedPath).toBeNull();
  });

  it('refuses an absolute store path outside the project root', async () => {
    const api = makeApi({
      extensions: {
        'knowledge-graph': { filePath: resolve(process.cwd(), '..', 'kg-escape-abs.json') },
      },
    });
    knowledgeGraphPlugin.setup(api as never);
    const status = (await getTool(api, 'kg_status')({})) as {
      resolvedPath: string | null;
    };
    expect(status.resolvedPath).toBeNull();
  });

  it('keeps a contained project-local store path usable', async () => {
    const api = makeApi({
      extensions: { 'knowledge-graph': { filePath: '.wrongstack/knowledge-graph.json' } },
    });
    knowledgeGraphPlugin.setup(api as never);
    const status = (await getTool(api, 'kg_status')({})) as {
      resolvedPath: string | null;
    };
    expect(status.resolvedPath).toBeTruthy();
    expect(status.resolvedPath?.toLowerCase()).toContain('.wrongstack');
  });
});
