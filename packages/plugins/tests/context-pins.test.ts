import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const contextPinsPlugin = (await import('../src/context-pins')).default;

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
    histogram: ReturnType<typeof vi.fn>;
    gauge: ReturnType<typeof vi.fn>;
  };
  registerHook: ReturnType<typeof vi.fn>;
  registerSystemPromptContributor: ReturnType<typeof vi.fn>;
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    registerSystemPromptContributor: vi.fn(() => vi.fn()),
  };
}

function getTool(
  api: MockApi,
  name: string,
): { execute: (input: unknown) => Promise<Record<string, unknown>> } {
  const call = api.tools.register.mock.calls.find(
    ([t]: unknown[]) => (t as { name: string }).name === name,
  );
  if (!call) throw new Error(`${name} not registered`);
  return call[0] as { execute: (input: unknown) => Promise<Record<string, unknown>> };
}

let tmp: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmp = mkdtempSync(join(tmpdir(), 'context-pins-'));
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows can be slow to release handles; best-effort.
  }
});

describe('context-pins plugin', () => {
  it('registers pin_add/pin_remove/pin_list and a system prompt contributor', () => {
    const api = makeApi();
    contextPinsPlugin.setup(api as never);
    const names = api.tools.register.mock.calls.map(
      ([t]: unknown[]) => (t as { name: string }).name,
    );
    expect(names).toEqual(expect.arrayContaining(['pin_add', 'pin_remove', 'pin_list']));
    expect(api.registerSystemPromptContributor).toHaveBeenCalledTimes(1);
  });

  it('pin_add then contributor injects the fact', async () => {
    const api = makeApi();
    contextPinsPlugin.setup(api as never);
    const add = getTool(api, 'pin_add');
    const result = await add.execute({
      text: 'API base URL is https://api.example.com',
      label: 'api',
    });
    expect(result['ok']).toBe(true);

    const contributor = api.registerSystemPromptContributor.mock.calls[0]![0] as () => Promise<
      Array<{ type: string; text: string }>
    >;
    const blocks = await contributor();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toContain('[pinned_context]');
    expect(blocks[0]!.text).toContain('[api] API base URL is https://api.example.com');
  });

  it('contributor returns nothing when no pins exist', async () => {
    const api = makeApi();
    contextPinsPlugin.setup(api as never);
    const contributor = api.registerSystemPromptContributor.mock.calls[0]![0] as () => Promise<
      unknown[]
    >;
    expect(await contributor()).toHaveLength(0);
  });

  it('pin_remove works by id and by label', async () => {
    const api = makeApi();
    contextPinsPlugin.setup(api as never);
    const add = getTool(api, 'pin_add');
    const remove = getTool(api, 'pin_remove');
    const first = await add.execute({ text: 'fact one', label: 'one' });
    await add.execute({ text: 'fact two', label: 'two' });
    const pin = first['pin'] as { id: string };
    expect((await remove.execute({ id: pin.id }))['ok']).toBe(true);
    expect((await remove.execute({ id: 'two' }))['ok']).toBe(true);
    const list = await getTool(api, 'pin_list').execute({});
    expect(list['totalPins']).toBe(0);
  });

  it('pin_remove reports unknown keys', async () => {
    const api = makeApi();
    contextPinsPlugin.setup(api as never);
    const result = await getTool(api, 'pin_remove').execute({ id: 'nope' });
    expect(result['ok']).toBe(false);
  });

  it('enforces maxPins', async () => {
    const api = makeApi({ extensions: { 'context-pins': { maxPins: 2 } } });
    contextPinsPlugin.setup(api as never);
    const add = getTool(api, 'pin_add');
    await add.execute({ text: 'a' });
    await add.execute({ text: 'b' });
    const third = await add.execute({ text: 'c' });
    expect(third['ok']).toBe(false);
    expect(String(third['error'])).toContain('limit');
  });

  it('persists pins to filePath and reloads them on next setup', async () => {
    const filePath = join(tmp, 'pins.json');
    const api = makeApi({ extensions: { 'context-pins': { filePath } } });
    contextPinsPlugin.setup(api as never);
    await getTool(api, 'pin_add').execute({ text: 'persisted fact' });
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toContain('persisted fact');

    // Fresh setup with the same file — pin must survive.
    const api2 = makeApi({ extensions: { 'context-pins': { filePath } } });
    contextPinsPlugin.setup(api2 as never);
    const list = await getTool(api2, 'pin_list').execute({});
    expect(list['totalPins']).toBe(1);
  });

  it('enabled:false rejects pin_add and skips the contributor', async () => {
    const api = makeApi({ extensions: { 'context-pins': { enabled: false } } });
    contextPinsPlugin.setup(api as never);
    expect(api.registerSystemPromptContributor).not.toHaveBeenCalled();
    const result = await getTool(api, 'pin_add').execute({ text: 'x' });
    expect(result['ok']).toBe(false);
  });

  it('teardown clears pins and logs', async () => {
    const api = makeApi();
    contextPinsPlugin.setup(api as never);
    await getTool(api, 'pin_add').execute({ text: 'x' });
    contextPinsPlugin.teardown!(api as never);
    const health = (await contextPinsPlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['pins']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'context-pins: teardown complete',
      expect.any(Object),
    );
  });
});
