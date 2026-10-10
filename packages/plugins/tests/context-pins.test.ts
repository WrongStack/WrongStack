import * as testNodeFs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
): {
  permission?: string;
  mutating?: boolean;
  execute: (input: unknown) => Promise<Record<string, unknown>>;
} {
  const call = api.tools.register.mock.calls.find(
    ([t]: unknown[]) => (t as { name: string }).name === name,
  );
  if (!call) throw new Error(`${name} not registered`);
  return call[0] as {
    permission?: string;
    mutating?: boolean;
    execute: (input: unknown) => Promise<Record<string, unknown>>;
  };
}

let tmp: string;
let originalCwd: string;

beforeEach(() => {
  vi.clearAllMocks();
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'context-pins-'));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
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

  it('requires confirmation before changing pinned prompt context', () => {
    const api = makeApi();
    contextPinsPlugin.setup(api as never);

    for (const name of ['pin_add', 'pin_remove']) {
      const tool = getTool(api, name);
      expect(tool.permission, name).toBe('confirm');
      expect(tool.mutating, name).toBe(true);
    }
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
    expect((await remove.execute({ label: 'two' }))['ok']).toBe(true);
    const list = await getTool(api, 'pin_list').execute({});
    expect(list['totalPins']).toBe(0);
  });

  it('pin_remove reports unknown keys', async () => {
    const api = makeApi();
    contextPinsPlugin.setup(api as never);
    await expect(getTool(api, 'pin_remove').execute({ id: 'nope' })).rejects.toThrow(
      /no pin matches/,
    );
  });

  it('enforces maxPins', async () => {
    const api = makeApi({ extensions: { 'context-pins': { maxPins: 2 } } });
    contextPinsPlugin.setup(api as never);
    const add = getTool(api, 'pin_add');
    await add.execute({ text: 'a' });
    await add.execute({ text: 'b' });
    await expect(add.execute({ text: 'c' })).rejects.toThrow(/limit/);
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

  it('never saves over a pins file it could not read at setup', async () => {
    const filePath = join(tmp, 'pins.json');
    writeFileSync(filePath, JSON.stringify({ pins: [{ id: 'pin-1', text: 'stored' }], nextId: 2 }));
    const before = readFileSync(filePath, 'utf-8');
    const nodeFs = testNodeFs as typeof import('node:fs');
    let nodeFs_readFileSync_spy: { mockRestore(): void } | undefined;
    const realReadFileSync = nodeFs.readFileSync;
    nodeFs_readFileSync_spy = vi.spyOn(nodeFs, 'readFileSync').mockImplementation(((
      p: unknown,
      ...rest: unknown[]
    ) => {
      if (String(p) === filePath) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return (realReadFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof nodeFs.readFileSync);

    const api = makeApi({ extensions: { 'context-pins': { filePath } } });
    try {
      contextPinsPlugin.setup(api as never);
    } finally {
      nodeFs_readFileSync_spy?.mockRestore();
    }
    const result = await getTool(api, 'pin_add').execute({ text: 'new' });
    expect(result['persisted']).toBe(false);
    expect(readFileSync(filePath, 'utf-8')).toBe(before);
  });

  it('keeps stored pins past a lowered maxPins instead of deleting them on the next write', async () => {
    const filePath = join(tmp, 'pins.json');
    const api = makeApi({ extensions: { 'context-pins': { filePath } } });
    contextPinsPlugin.setup(api as never);
    for (const text of ['one', 'two', 'three']) await getTool(api, 'pin_add').execute({ text });

    const api2 = makeApi({ extensions: { 'context-pins': { filePath, maxPins: 2 } } });
    contextPinsPlugin.setup(api2 as never);
    await getTool(api2, 'pin_remove').execute({ id: 'pin-1' });
    expect(readFileSync(filePath, 'utf-8')).toContain('three');
  });

  it('rejects filePath outside the project directory and runs in-memory', async () => {
    const outside = join(tmpdir(), `outside-pins-${Date.now()}.json`);
    const api = makeApi({ extensions: { 'context-pins': { filePath: outside } } });
    contextPinsPlugin.setup(api as never);
    const list = await getTool(api, 'pin_list').execute({});
    expect(list['filePath']).toBeNull();
    await getTool(api, 'pin_add').execute({ text: 'in-memory fact' });
    expect(existsSync(outside)).toBe(false);
  });

  it('persists to the host-seeded project directory even though it is outside the cwd', async () => {
    // The CLI seeds `<projectDir>/context-pins.json` (wiring/plugins.ts), and
    // projectDir is `~/.wrongstack/projects/<hash>/` — outside the cwd. The
    // cwd-only containment rejected exactly that path, so EVERY host-seeded
    // store was silently in-memory while pin_add answered `persisted: true`,
    // in a plugin that promises pins "persist across sessions".
    const projectDir = mkdtempSync(join(tmpdir(), 'ws-project-dir-'));
    const filePath = join(projectDir, 'context-pins.json');
    try {
      const api = makeApi({ extensions: { 'context-pins': { filePath } } });
      (api.config as Record<string, unknown>)['paths'] = { projectDir };
      contextPinsPlugin.setup(api as never);
      const result = await getTool(api, 'pin_add').execute({ text: 'seeded fact' });
      expect(result['persisted']).toBe(true);
      expect(result['storage']).toBe('file');
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, 'utf-8')).toContain('seeded fact');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('reports in-memory storage honestly when no filePath is configured', async () => {
    // `persistPins('')` used to return true — "nothing to write" reported as
    // "written", which is what hid the bug above.
    const api = makeApi();
    contextPinsPlugin.setup(api as never);
    const result = await getTool(api, 'pin_add').execute({ text: 'x' });
    expect(result['persisted']).toBe(false);
    expect(result['storage']).toBe('memory');
  });

  it('enabled:false rejects pin_add and skips the contributor', async () => {
    const api = makeApi({ extensions: { 'context-pins': { enabled: false } } });
    contextPinsPlugin.setup(api as never);
    expect(api.registerSystemPromptContributor).not.toHaveBeenCalled();
    await expect(getTool(api, 'pin_add').execute({ text: 'x' })).rejects.toThrow(/disabled/);
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

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));
