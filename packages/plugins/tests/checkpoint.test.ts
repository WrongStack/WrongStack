import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const checkpointPlugin = (await import('../src/checkpoint')).default;

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
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
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

function getHook(api: MockApi): (input: unknown) => void {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as (input: unknown) => void;
}

let tmp: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmp = mkdtempSync(join(tmpdir(), 'checkpoint-'));
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort on Windows
  }
});

describe('checkpoint plugin', () => {
  it('registers create/list/restore tools and a PreToolUse write|edit hook', () => {
    const api = makeApi();
    checkpointPlugin.setup(api as never);
    const names = api.tools.register.mock.calls.map(
      ([t]: unknown[]) => (t as { name: string }).name,
    );
    expect(names).toEqual(
      expect.arrayContaining(['checkpoint_create', 'checkpoint_list', 'checkpoint_restore']),
    );
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PreToolUse');
    expect(matcher).toBe('write|edit');
  });

  it('auto-captures file content before a write and restores it', async () => {
    const api = makeApi();
    checkpointPlugin.setup(api as never);
    const hook = getHook(api);

    const file = join(tmp, 'a.txt');
    writeFileSync(file, 'original');
    // Simulate the agent about to overwrite the file.
    hook({ toolName: 'write', toolInput: { path: file } });
    writeFileSync(file, 'clobbered');

    const list = await getTool(api, 'checkpoint_list').execute({});
    const snapshots = list['snapshots'] as Array<{ id: string; origin: string }>;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.origin).toBe('auto:write');

    const restore = await getTool(api, 'checkpoint_restore').execute({ id: snapshots[0]!.id });
    expect(restore['ok']).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe('original');
  });

  it('restore without id uses the newest snapshot', async () => {
    const api = makeApi();
    checkpointPlugin.setup(api as never);
    const file = join(tmp, 'b.txt');
    writeFileSync(file, 'v1');
    await getTool(api, 'checkpoint_create').execute({ paths: [file] });
    writeFileSync(file, 'v2');
    const restore = await getTool(api, 'checkpoint_restore').execute({});
    expect(restore['ok']).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe('v1');
  });

  it('records non-existent files and never deletes them on restore', async () => {
    const api = makeApi();
    checkpointPlugin.setup(api as never);
    const missing = join(tmp, 'new.txt');
    await getTool(api, 'checkpoint_create').execute({ paths: [missing] });
    writeFileSync(missing, 'created later');
    const restore = await getTool(api, 'checkpoint_restore').execute({});
    expect(restore['notRestoredFileDidNotExist']).toContain(missing);
    expect(readFileSync(missing, 'utf-8')).toBe('created later');
  });

  it('skips files larger than maxFileBytes', async () => {
    const api = makeApi({ extensions: { checkpoint: { maxFileBytes: 1024 } } });
    checkpointPlugin.setup(api as never);
    const big = join(tmp, 'big.txt');
    writeFileSync(big, 'x'.repeat(4096));
    const result = await getTool(api, 'checkpoint_create').execute({ paths: [big] });
    expect(result['ok']).toBe(false);
  });

  it('ring drops oldest snapshots beyond maxSnapshots', async () => {
    const api = makeApi({ extensions: { checkpoint: { maxSnapshots: 2 } } });
    checkpointPlugin.setup(api as never);
    const file = join(tmp, 'c.txt');
    writeFileSync(file, 'v');
    const create = getTool(api, 'checkpoint_create');
    await create.execute({ paths: [file], label: 'one' });
    await create.execute({ paths: [file], label: 'two' });
    await create.execute({ paths: [file], label: 'three' });
    const list = await getTool(api, 'checkpoint_list').execute({});
    expect(list['total']).toBe(2);
    const snapshots = list['snapshots'] as Array<{ origin: string }>;
    expect(snapshots.map((s) => s.origin)).toEqual(['manual:three', 'manual:two']);
  });

  it('autoCapture:false skips the hook registration', () => {
    const api = makeApi({ extensions: { checkpoint: { autoCapture: false } } });
    checkpointPlugin.setup(api as never);
    expect(api.registerHook).not.toHaveBeenCalled();
  });

  it('enabled:false rejects tool calls', async () => {
    const api = makeApi({ extensions: { checkpoint: { enabled: false } } });
    checkpointPlugin.setup(api as never);
    expect(api.registerHook).not.toHaveBeenCalled();
    const result = await getTool(api, 'checkpoint_create').execute({ paths: ['x'] });
    expect(result['ok']).toBe(false);
  });

  it('teardown drops snapshots and logs', async () => {
    const api = makeApi();
    checkpointPlugin.setup(api as never);
    const file = join(tmp, 'd.txt');
    writeFileSync(file, 'v');
    await getTool(api, 'checkpoint_create').execute({ paths: [file] });
    checkpointPlugin.teardown!(api as never);
    const health = (await checkpointPlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['snapshotsHeld']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith('checkpoint: teardown complete', expect.any(Object));
  });
});
