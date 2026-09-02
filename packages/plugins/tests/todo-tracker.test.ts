import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import todoTrackerPlugin from '../src/todo-tracker';

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
  registerSystemPromptContributor: ReturnType<typeof vi.fn>;
  registerHook: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  session: { append: ReturnType<typeof vi.fn> };
}

function makeApi(filePath: string): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: { 'todo-tracker': { filePath } } },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerSystemPromptContributor: vi.fn(() => () => {}),
    registerHook: vi.fn(() => vi.fn()),
    onEvent: vi.fn(),
    session: { append: vi.fn().mockResolvedValue(undefined) },
  };
}

function makeUnconfiguredApi(): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerSystemPromptContributor: vi.fn(() => () => {}),
    registerHook: vi.fn(() => vi.fn()),
    onEvent: vi.fn(),
    session: { append: vi.fn().mockResolvedValue(undefined) },
  };
}

function getTool(
  api: MockApi,
  name: string,
): {
  execute: (input: unknown) => Promise<unknown>;
} {
  const call = api.tools.register.mock.calls.find(
    ([t]: unknown[]) => (t as { name: string }).name === name,
  );
  if (!call) throw new Error(`tool ${name} not registered`);
  return call[0] as { execute: (input: unknown) => Promise<unknown> };
}

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(join(tmpdir(), 'todo-tracker-test-'));
  filePath = join(tmpDir, 'todo-tracker.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('todo-tracker plugin', () => {
  it('registers all 7 tools on setup', async () => {
    const api = makeApi(filePath);
    await todoTrackerPlugin.setup(api as never);
    const names = api.tools.register.mock.calls.map(
      ([t]: unknown[]) => (t as { name: string }).name,
    );
    expect(names).toContain('todo_tracker_list');
    expect(names).toContain('todo_tracker_add');
    expect(names).toContain('todo_tracker_complete');
    expect(names).toContain('todo_tracker_drop');
    expect(names).toContain('todo_tracker_remove');
    expect(names).toContain('todo_tracker_pull');
    expect(names).toContain('todo_tracker_status');
  });

  it('warns and no-ops when no file path is configured', async () => {
    const api = makeUnconfiguredApi();
    await todoTrackerPlugin.setup(api as never);
    expect(api.log.warn).toHaveBeenCalledWith(expect.stringContaining('no file path configured'));
    // When no file path is configured the plugin short-circuits:
    // no tools are registered, no file is touched. The host surfaces
    // the warning in its own log; calling setupPlugins with a
    // project that lacks paths.projectDir is a host-level misconfig.
    expect(api.tools.register).not.toHaveBeenCalled();
  });
});

describe('add + list round trip', () => {
  it('persists across setup() calls (the cross-session use case)', async () => {
    // Session 1: add an item
    const api1 = makeApi(filePath);
    await todoTrackerPlugin.setup(api1 as never);
    const addTool = getTool(api1, 'todo_tracker_add');
    const added = (await addTool.execute({ content: 'fix flaky test' })) as {
      ok: boolean;
      item: { id: string; content: string; status: string };
    };
    expect(added.ok).toBe(true);
    expect(added.item.content).toBe('fix flaky test');
    expect(added.item.status).toBe('pending');
    todoTrackerPlugin.teardown!(api1 as never);

    // Session 2: re-setup and verify the item is still there
    const api2 = makeApi(filePath);
    await todoTrackerPlugin.setup(api2 as never);
    const listTool = getTool(api2, 'todo_tracker_list');
    const listed = (await listTool.execute({})) as {
      ok: boolean;
      total: number;
      items: Array<{ id: string; content: string }>;
    };
    expect(listed.ok).toBe(true);
    expect(listed.total).toBe(1);
    expect(listed.items[0]?.content).toBe('fix flaky test');
  });

  it('rejects empty content with a clear error', async () => {
    const api = makeApi(filePath);
    await todoTrackerPlugin.setup(api as never);
    const addTool = getTool(api, 'todo_tracker_add');
    const result = (await addTool.execute({ content: '   ' })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/content is required/);
  });

  it('list filters by status, priority, and tag', async () => {
    const api = makeApi(filePath);
    await todoTrackerPlugin.setup(api as never);
    const addTool = getTool(api, 'todo_tracker_add');
    await addTool.execute({ content: 'low prio bug', priority: 'low', tags: ['bug'] });
    await addTool.execute({ content: 'high prio bug', priority: 'high', tags: ['bug'] });
    await addTool.execute({ content: 'unrelated task', tags: ['chore'] });

    const listAll = (await getTool(api, 'todo_tracker_list').execute({ status: 'all' })) as {
      total: number;
    };
    expect(listAll.total).toBe(3);

    const listBugs = (await getTool(api, 'todo_tracker_list').execute({
      status: 'all',
      tag: 'bug',
    })) as { total: number; items: Array<{ content: string; priority: string }> };
    expect(listBugs.total).toBe(2);
    for (const it of listBugs.items) expect(it.priority).not.toBe('normal');

    const listHigh = (await getTool(api, 'todo_tracker_list').execute({
      status: 'all',
      priority: 'high',
    })) as { total: number; items: Array<{ content: string }> };
    expect(listHigh.total).toBe(1);
    expect(listHigh.items[0]?.content).toBe('high prio bug');
  });

  it('list defaults to active items (pending + in_progress) only', async () => {
    const api = makeApi(filePath);
    await todoTrackerPlugin.setup(api as never);
    const addTool = getTool(api, 'todo_tracker_add');
    const completeTool = getTool(api, 'todo_tracker_complete');
    const a = (await addTool.execute({ content: 'pending one' })) as { item: { id: string } };
    const b = (await addTool.execute({ content: 'completed one' })) as { item: { id: string } };
    await completeTool.execute({ id: b.item.id });

    const listed = (await getTool(api, 'todo_tracker_list').execute({})) as {
      total: number;
      items: Array<{ id: string }>;
    };
    expect(listed.total).toBe(1);
    expect(listed.items[0]?.id).toBe(a.item.id);
  });
});

describe('complete / drop / remove', () => {
  it('complete is idempotent', async () => {
    const api = makeApi(filePath);
    await todoTrackerPlugin.setup(api as never);
    const addTool = getTool(api, 'todo_tracker_add');
    const completeTool = getTool(api, 'todo_tracker_complete');
    const added = (await addTool.execute({ content: 'do thing' })) as { item: { id: string } };

    const first = (await completeTool.execute({ id: added.item.id })) as {
      ok: boolean;
      message?: string;
    };
    expect(first.ok).toBe(true);
    expect(first.message).toBeUndefined();

    const second = (await completeTool.execute({ id: added.item.id })) as {
      ok: boolean;
      message?: string;
    };
    expect(second.ok).toBe(true);
    expect(second.message).toMatch(/already completed/);
  });

  it('drop marks an item dropped (kept in store for audit)', async () => {
    const api = makeApi(filePath);
    await todoTrackerPlugin.setup(api as never);
    const addTool = getTool(api, 'todo_tracker_add');
    const dropTool = getTool(api, 'todo_tracker_drop');
    const added = (await addTool.execute({ content: 'obsolete thing' })) as {
      item: { id: string };
    };

    await dropTool.execute({ id: added.item.id });
    const status = (await getTool(api, 'todo_tracker_status').execute({})) as {
      counters: Record<string, number>;
      total: number;
    };
    // The item is still in the file (audit) but counted as dropped.
    expect(status.total).toBe(1);
    expect(status.counters['dropped']).toBe(1);
  });

  it('remove permanently deletes the item from disk', async () => {
    const api = makeApi(filePath);
    await todoTrackerPlugin.setup(api as never);
    const addTool = getTool(api, 'todo_tracker_add');
    const removeTool = getTool(api, 'todo_tracker_remove');
    const added = (await addTool.execute({ content: 'gone tomorrow' })) as { item: { id: string } };

    const result = (await removeTool.execute({ id: added.item.id })) as {
      ok: boolean;
      removed: { id: string };
    };
    expect(result.ok).toBe(true);
    expect(result.removed.id).toBe(added.item.id);

    // Verify on-disk too
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as { items: unknown[] };
    expect(onDisk.items).toHaveLength(0);
  });

  it('returns a clear error for an unknown id', async () => {
    const api = makeApi(filePath);
    await todoTrackerPlugin.setup(api as never);
    const result = (await getTool(api, 'todo_tracker_complete').execute({ id: 'no-such-id' })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no item with id/);
  });
});

describe('pull', () => {
  it('returns only pending + in_progress items', async () => {
    const api = makeApi(filePath);
    await todoTrackerPlugin.setup(api as never);
    const addTool = getTool(api, 'todo_tracker_add');
    const completeTool = getTool(api, 'todo_tracker_complete');
    const a = (await addTool.execute({ content: 'open work' })) as { item: { id: string } };
    await addTool.execute({ content: 'another open' });
    const c = (await addTool.execute({ content: 'closed' })) as { item: { id: string } };
    await completeTool.execute({ id: c.item.id });

    const pulled = (await getTool(api, 'todo_tracker_pull').execute({})) as {
      ok: boolean;
      total: number;
      items: Array<{ id: string; content: string }>;
    };
    expect(pulled.ok).toBe(true);
    expect(pulled.total).toBe(2);
    const ids = pulled.items.map((i) => i.id);
    expect(ids).toContain(a.item.id);
    expect(ids).not.toContain(c.item.id);
  });
});

describe('file persistence (atomic write + corruption tolerance)', () => {
  it('creates a file on first save and reads it back on next setup', async () => {
    const api1 = makeApi(filePath);
    await todoTrackerPlugin.setup(api1 as never);
    const addTool = getTool(api1, 'todo_tracker_add');
    await addTool.execute({ content: 'persisted item' });
    todoTrackerPlugin.teardown!(api1 as never);

    // Read the file directly and confirm shape
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as {
      version: number;
      items: Array<{ content: string }>;
    };
    expect(onDisk.version).toBe(1);
    expect(onDisk.items).toHaveLength(1);
    expect(onDisk.items[0]?.content).toBe('persisted item');

    // Re-setup and confirm we can read it
    const api2 = makeApi(filePath);
    await todoTrackerPlugin.setup(api2 as never);
    const listed = (await getTool(api2, 'todo_tracker_list').execute({})) as { total: number };
    expect(listed.total).toBe(1);
  });

  it('treats a corrupt file as empty (does not crash setup)', async () => {
    // Seed a corrupt file before setup
    const { writeFileSync } = await import('node:fs');
    writeFileSync(filePath, 'not valid json {{{');

    const api = makeApi(filePath);
    await expect(todoTrackerPlugin.setup(api as never)).resolves.not.toThrow();

    // The plugin should now treat the file as empty — list returns 0
    const listed = (await getTool(api, 'todo_tracker_list').execute({})) as { total: number };
    expect(listed.total).toBe(0);
  });
});

describe('teardown + H1 pattern', () => {
  it('teardown zeros counters and clears in-memory cache', async () => {
    const api = makeApi(filePath);
    await todoTrackerPlugin.setup(api as never);
    const addTool = getTool(api, 'todo_tracker_add');
    await addTool.execute({ content: 'a' });
    await addTool.execute({ content: 'b' });
    expect((await todoTrackerPlugin.health!()) as { sessionCounts: { add: number } }).toMatchObject(
      {
        sessionCounts: { add: 2 },
      },
    );

    todoTrackerPlugin.teardown!(api as never);
    const h = (await todoTrackerPlugin.health!()) as {
      ok: boolean;
      message: string;
    };
    // After teardown, the plugin is "unconfigured" — filePath is null.
    expect(h.ok).toBe(false);
    expect(h.message).toContain('no file path configured');
  });

  it('teardown is safe to call before setup (defensive)', () => {
    const api = makeApi(filePath);
    expect(() => todoTrackerPlugin.teardown!(api as never)).not.toThrow();
  });

  it('reload cycle: setup → teardown → setup reads fresh counters', async () => {
    const api = makeApi(filePath);
    await todoTrackerPlugin.setup(api as never);
    await getTool(api, 'todo_tracker_add').execute({ content: 'one' });
    await getTool(api, 'todo_tracker_add').execute({ content: 'two' });

    todoTrackerPlugin.teardown!(api as never);
    // Second round: re-setup with the same file (so persisted items
    // remain on disk, but counters reset).
    await todoTrackerPlugin.setup(api as never);
    const status = (await getTool(api, 'todo_tracker_status').execute({})) as {
      total: number;
      session: { add: number };
    };
    // Two items persisted, but session counter is reset to 0
    expect(status.total).toBe(2);
    expect(status.session.add).toBe(0);
  });
});
