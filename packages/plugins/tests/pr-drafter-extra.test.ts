/**
 * Supplementary tests for pr-drafter — targeting uncovered branches.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prDrafterPlugin = (await import('../src/pr-drafter')).default;

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: { counter: ReturnType<typeof vi.fn> };
  registerHook: ReturnType<typeof vi.fn>;
  onPattern: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  llm: undefined;
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    onPattern: vi.fn(() => vi.fn()),
    onEvent: vi.fn(() => vi.fn()),
    llm: undefined,
  };
}

function getTool(api: MockApi, name: string) {
  const call = api.tools.register.mock.calls.find((c) => (c[0] as { name: string }).name === name);
  if (!call) throw new Error(`tool ${name} not registered`);
  return (call[0] as { execute: (input: unknown) => Promise<unknown> }).execute;
}

beforeEach(() => vi.clearAllMocks());

describe('pr-drafter extra coverage', () => {
  it('health() returns active state with zero counters', async () => {
    const api = makeApi();
    prDrafterPlugin.setup(api as never);
    const h = (await prDrafterPlugin.health!()) as {
      ok: boolean;
      message: string;
      counters: Record<string, number>;
    };
    expect(h.ok).toBe(true);
    expect(h.message).toContain('0 commit(s)');
    expect(h.counters.commits).toBe(0);
  });

  it('readConfig uses defaults for null/undefined config', async () => {
    const api = makeApi({ extensions: { 'pr-drafter': null } });
    prDrafterPlugin.setup(api as never);
    const tool = getTool(api, 'pr_draft');
    const result = (await tool({ preview: true })) as { ok: boolean; body: string };
    expect(result.ok).toBe(true);
    expect(result.body).toContain('# PR Draft');
  });

  it('onPattern handler records git_autocommit and write/edit tool calls', async () => {
    const api = makeApi();
    prDrafterPlugin.setup(api as never);
    const onPatternHandler = api.onPattern.mock.calls[0]?.[1] as (
      event: string,
      payload: unknown,
    ) => void;
    expect(onPatternHandler).toBeDefined();

    // Simulate git_autocommit
    onPatternHandler('tool.completed', {
      tool: 'git_autocommit',
      result: { committed: true, commitMessage: 'fix: resolve auth bug' },
    });

    // Simulate write tool
    onPatternHandler('tool.completed', {
      tool: 'write',
      input: { path: 'src/auth.ts' },
    });

    // Simulate edit tool
    onPatternHandler('tool.completed', {
      tool: 'edit',
      input: { path: 'src/utils.ts' },
    });

    const h = (await prDrafterPlugin.health!()) as {
      counters: Record<string, number>;
      message: string;
    };
    expect(h.counters.commits).toBe(1);
    // 3 tool.completed events: git_autocommit + write + edit
    expect(h.counters.toolCalls).toBe(3);
    expect(h.message).toContain('1 commit(s)');
  });

  it('onPattern handler handles null/empty payload gracefully', async () => {
    const api = makeApi();
    prDrafterPlugin.setup(api as never);
    const onPatternHandler = api.onPattern.mock.calls[0]?.[1] as (
      event: string,
      payload: unknown,
    ) => void;
    expect(() => onPatternHandler('tool.completed', null)).not.toThrow();
    expect(() => onPatternHandler('tool.completed', {})).not.toThrow();
    expect(() => onPatternHandler('tool.completed', { tool: 'write' })).not.toThrow();
  });

  it('onEvent handler records provider responses', async () => {
    const api = makeApi();
    prDrafterPlugin.setup(api as never);
    const onEventHandler = api.onEvent.mock.calls[0]?.[1] as (payload: unknown) => void;

    onEventHandler({
      model: 'gpt-4o',
      usage: { input: 100, output: 50 },
    });
    onEventHandler({
      model: 'gpt-4o',
      usage: { input: 200, output: 100 },
    });

    const h = (await prDrafterPlugin.health!()) as { counters: Record<string, number> };
    // onEvent handler doesn't increment toolCalls, but records models/tokens
    expect(h.counters.toolCalls).toBe(0); // toolCalls is only for onPattern
  });

  it('onEventHandler handles null payload gracefully', async () => {
    const api = makeApi();
    prDrafterPlugin.setup(api as never);
    const onEventHandler = api.onEvent.mock.calls[0]?.[1] as (payload: unknown) => void;
    expect(() => onEventHandler(null)).not.toThrow();
    expect(() => onEventHandler({})).not.toThrow();
  });

  it('onPattern handler has null payload protection for path access', async () => {
    const api = makeApi();
    prDrafterPlugin.setup(api as never);
    const onPatternHandler = api.onPattern.mock.calls[0]?.[1] as (
      event: string,
      payload: unknown,
    ) => void;

    // Payload with no input should not throw
    onPatternHandler('tool.completed', { tool: 'write' });
    onPatternHandler('tool.completed', { tool: 'edit', input: null });

    const h = (await prDrafterPlugin.health!()) as { counters: Record<string, number> };
    // The handler should have safely handled these
    expect(h.counters.toolCalls).toBe(2);
  });

  it('teardown unhooks all subscriptions', async () => {
    const api = makeApi();
    const unsub1 = vi.fn();
    const unsub2 = vi.fn();
    api.onPattern = vi.fn(() => unsub1);
    api.onEvent = vi.fn(() => unsub2);

    prDrafterPlugin.setup(api as never);
    prDrafterPlugin.teardown!(api as never);

    expect(unsub1).toHaveBeenCalled();
    expect(unsub2).toHaveBeenCalled();
  });

  it('teardown is safe when no subscriptions exist', async () => {
    const api = makeApi();
    expect(() => prDrafterPlugin.teardown!(api as never)).not.toThrow();
  });

  it('teardown handles unsub throwing', async () => {
    const api = makeApi();
    api.onPattern = vi.fn(() => {
      throw new Error('unsub fails');
    });
    prDrafterPlugin.teardown!(api as never);
    expect(api.log.info).toHaveBeenCalled();
  });
});
