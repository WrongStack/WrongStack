import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const docSyncGuardPlugin = (await import('../src/doc-sync-guard')).default;

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
  registerHook: ReturnType<typeof vi.fn>;
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: {
      extensions: {
        'doc-sync-guard': { enabled: true },
        ...(overrides.extensions ?? {}),
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
  };
}

type HookResult = { decision?: string; reason?: string; additionalContext?: string } | undefined;

function getHook(api: MockApi): (input: unknown) => HookResult {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as (input: unknown) => HookResult;
}

function getTool(api: MockApi, name: string) {
  const calls = api.tools.register.mock.calls as unknown as [
    { name: string; execute: (...args: unknown[]) => unknown },
  ][];
  const found = calls.find((c) => c[0].name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  const api = makeApi();
  await docSyncGuardPlugin.teardown?.(api as never);
});

describe('doc-sync-guard plugin', () => {
  it('registers doc_sync_status and a PostToolUse write|edit hook', () => {
    const api = makeApi();
    docSyncGuardPlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
    expect(getTool(api, 'doc_sync_status')).toBeDefined();
  });

  it('tracks public source files changed by write or edit', async () => {
    const api = makeApi();
    docSyncGuardPlugin.setup(api as never);
    const hook = getHook(api);

    hook({
      toolName: 'write',
      toolInput: { path: 'src/utils.ts', content: 'export const x = 1;' },
      toolResult: { content: '', isError: false },
    });
    hook({
      toolName: 'edit',
      toolInput: { path: 'src/api.tsx', old_string: 'a', new_string: 'b' },
      toolResult: { content: '', isError: false },
    });

    const status = getTool(api, 'doc_sync_status');
    const result = status.execute();
    await expect(result).resolves.toMatchObject({
      ok: true,
      changedFiles: ['src/utils.ts', 'src/api.tsx'],
      counters: { sourceWrites: 2, docWrites: 0, warningsIssued: 0 },
    });
  });

  it('warns when a README write omits recently changed source files', () => {
    const api = makeApi();
    docSyncGuardPlugin.setup(api as never);
    const hook = getHook(api);

    hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts', content: 'export const foo = 1;' },
      toolResult: { content: '', isError: false },
    });
    const result = hook({
      toolName: 'write',
      toolInput: { path: 'README.md', content: '# Project\n\nIntro text.' },
      toolResult: { content: '', isError: false },
    });

    expect(result).toBeDefined();
    expect(result?.additionalContext).toContain('src/foo.ts');
    expect(result?.additionalContext).toContain('README.md');
  });

  it('does not warn when the doc references the changed source file', () => {
    const api = makeApi();
    docSyncGuardPlugin.setup(api as never);
    const hook = getHook(api);

    hook({
      toolName: 'write',
      toolInput: { path: 'src/bar.ts', content: 'export const bar = 1;' },
      toolResult: { content: '', isError: false },
    });
    const result = hook({
      toolName: 'write',
      toolInput: { path: 'README.md', content: '# Project\n\nSee src/bar.ts for details.' },
      toolResult: { content: '', isError: false },
    });

    expect(result).toBeUndefined();
  });

  it('does not track test or spec source files', async () => {
    const api = makeApi();
    docSyncGuardPlugin.setup(api as never);
    const hook = getHook(api);

    hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.test.ts', content: '' },
      toolResult: { content: '', isError: false },
    });
    hook({
      toolName: 'write',
      toolInput: { path: 'src/bar.spec.tsx', content: '' },
      toolResult: { content: '', isError: false },
    });

    const status = getTool(api, 'doc_sync_status');
    await expect(status.execute()).resolves.toMatchObject({
      ok: true,
      changedFiles: [],
      counters: { sourceWrites: 0, docWrites: 0, warningsIssued: 0 },
    });
  });

  it('does not warn for non-doc writes', () => {
    const api = makeApi();
    docSyncGuardPlugin.setup(api as never);
    const hook = getHook(api);

    hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts', content: 'export const foo = 1;' },
      toolResult: { content: '', isError: false },
    });
    const result = hook({
      toolName: 'write',
      toolInput: { path: 'src/other.ts', content: 'export const other = 1;' },
      toolResult: { content: '', isError: false },
    });

    expect(result).toBeUndefined();
  });

  it('skips processing when the tool result is an error', async () => {
    const api = makeApi();
    docSyncGuardPlugin.setup(api as never);
    const hook = getHook(api);

    hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts', content: '' },
      toolResult: { content: 'error', isError: true },
    });
    hook({
      toolName: 'write',
      toolInput: { path: 'README.md', content: '# Project' },
      toolResult: { content: 'error', isError: true },
    });

    const status = getTool(api, 'doc_sync_status');
    await expect(status.execute()).resolves.toMatchObject({
      ok: true,
      changedFiles: [],
      counters: { sourceWrites: 0, docWrites: 0, warningsIssued: 0 },
    });
  });

  it('enabled:false disables the hook', () => {
    const api = makeApi({ extensions: { 'doc-sync-guard': { enabled: false } } });
    docSyncGuardPlugin.setup(api as never);
    const hook = getHook(api);

    hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts', content: '' },
      toolResult: { content: '', isError: false },
    });
    const result = hook({
      toolName: 'write',
      toolInput: { path: 'README.md', content: '# Project' },
      toolResult: { content: '', isError: false },
    });

    expect(result).toBeUndefined();
  });

  it('respects maxTrackedFiles by evicting oldest entries', async () => {
    const api = makeApi({ extensions: { 'doc-sync-guard': { maxTrackedFiles: 2 } } });
    docSyncGuardPlugin.setup(api as never);
    const hook = getHook(api);

    hook({
      toolName: 'write',
      toolInput: { path: 'src/a.ts', content: '' },
      toolResult: { content: '', isError: false },
    });
    hook({
      toolName: 'write',
      toolInput: { path: 'src/b.ts', content: '' },
      toolResult: { content: '', isError: false },
    });
    hook({
      toolName: 'write',
      toolInput: { path: 'src/c.ts', content: '' },
      toolResult: { content: '', isError: false },
    });

    const status = getTool(api, 'doc_sync_status');
    await expect(status.execute()).resolves.toMatchObject({
      ok: true,
      changedFiles: ['src/b.ts', 'src/c.ts'],
    });
  });

  it('teardown zeros state and logs', async () => {
    const api = makeApi();
    docSyncGuardPlugin.setup(api as never);
    const hook = getHook(api);
    hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts', content: '' },
      toolResult: { content: '', isError: false },
    });

    docSyncGuardPlugin.teardown!(api as never);
    const health = (await docSyncGuardPlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['changedFiles']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'doc-sync-guard: teardown complete',
      expect.any(Object),
    );
  });
});
