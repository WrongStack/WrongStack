import { resolveWstackPaths } from '@wrongstack/core/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the core's rewinder/store classes — exercised in their own tests.
// Use vi.hoisted so the mock factory can refer to the shared instances.
const mocks = vi.hoisted(() => ({
  rewindConstructor: vi.fn(),
  storeConstructor: vi.fn(),
  registryConstructor: vi.fn(),
  rewindInstance: {
    listCheckpoints: vi.fn(),
    rewindToStart: vi.fn(),
    rewindLastN: vi.fn(),
    rewindToCheckpoint: vi.fn(),
  },
  storeInstance: {
    resume: vi.fn(),
  },
  registryInstance: {
    register: vi.fn(),
    unregister: vi.fn(),
  },
}));
const { rewindInstance, storeInstance, registryInstance } = mocks;

vi.mock('@wrongstack/core/storage', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  class FakeRewinder {
    constructor(...args: unknown[]) {
      mocks.rewindConstructor(...args);
    }
    listCheckpoints = mocks.rewindInstance.listCheckpoints;
    rewindToStart = mocks.rewindInstance.rewindToStart;
    rewindLastN = mocks.rewindInstance.rewindLastN;
    rewindToCheckpoint = mocks.rewindInstance.rewindToCheckpoint;
  }
  class FakeStore {
    constructor(...args: unknown[]) {
      mocks.storeConstructor(...args);
    }
    resume = mocks.storeInstance.resume;
  }
  class FakeRegistry {
    constructor(...args: unknown[]) {
      mocks.registryConstructor(...args);
    }
    register = mocks.registryInstance.register;
    unregister = mocks.registryInstance.unregister;
  }
  return {
    ...actual,
    DefaultSessionRewinder: FakeRewinder,
    DefaultSessionStore: FakeStore,
    SessionRegistry: FakeRegistry,
  };
});

import { rewindCmd } from '../src/subcommands/handlers/rewind.js';
import type { SubcommandDeps } from '../src/subcommands/index.js';

function fakeDeps(overrides: Partial<SubcommandDeps> = {}): SubcommandDeps {
  return {
    config: {} as SubcommandDeps['config'],
    renderer: { write: vi.fn(), writeError: vi.fn() } as unknown as SubcommandDeps['renderer'],
    reader: {} as SubcommandDeps['reader'],
    sessionStore: {
      list: vi.fn().mockResolvedValue([{ id: 'auto-session-1' }]),
    } as unknown as NonNullable<SubcommandDeps['sessionStore']>,
    skillLoader: undefined,
    toolRegistry: undefined,
    modelsRegistry: {} as SubcommandDeps['modelsRegistry'],
    paths: {} as SubcommandDeps['paths'],
    vault: {} as SubcommandDeps['vault'],
    cwd: '/tmp/proj',
    projectRoot: '/tmp/proj',
    userHome: '/tmp',
    flags: {},
    ...overrides,
  };
}

beforeEach(() => {
  mocks.rewindConstructor.mockReset();
  mocks.storeConstructor.mockReset();
  mocks.registryConstructor.mockReset();
  rewindInstance.listCheckpoints.mockReset();
  rewindInstance.rewindToStart.mockReset();
  rewindInstance.rewindLastN.mockReset();
  rewindInstance.rewindToCheckpoint.mockReset();
  storeInstance.resume.mockReset();
  registryInstance.register.mockReset().mockResolvedValue(undefined);
  registryInstance.unregister.mockReset().mockResolvedValue(undefined);
});

describe('rewindCmd', () => {
  it('uses the modern project-scoped sessions directory', async () => {
    rewindInstance.listCheckpoints.mockResolvedValue([]);
    const deps = fakeDeps();

    await rewindCmd(['--list'], deps);

    expect(mocks.rewindConstructor).toHaveBeenCalledWith(
      resolveWstackPaths({ projectRoot: deps.projectRoot }).projectSessions,
      deps.projectRoot,
    );
  });

  it('errors when no sessions available and no id passed', async () => {
    const deps = fakeDeps({
      sessionStore: {
        create: vi.fn(),
        load: vi.fn(),
        resume: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        delete: vi.fn(),
        clearHistory: vi.fn(),
        prune: vi.fn(),
      } as unknown as NonNullable<SubcommandDeps['sessionStore']>,
    });
    const code = await rewindCmd([], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith('No sessions found.');
  });

  it('errors when sessionStore unavailable and no id passed', async () => {
    const deps = fakeDeps({ sessionStore: undefined });
    const code = await rewindCmd([], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith('No session store available.');
  });

  it('--list with no checkpoints prints empty message', async () => {
    rewindInstance.listCheckpoints.mockResolvedValue([]);
    const deps = fakeDeps();
    const code = await rewindCmd(['--list'], deps);
    expect(code).toBe(0);
    const calls = (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join('');
    expect(calls).toContain('No checkpoints');
  });

  it('--list renders checkpoint table with file counts', async () => {
    rewindInstance.listCheckpoints.mockResolvedValue([
      { promptIndex: 0, ts: '2026-01-01', promptPreview: 'first', fileCount: 0 },
      { promptIndex: 1, ts: '2026-01-02', promptPreview: 'second', fileCount: 3 },
      { promptIndex: 2, ts: '2026-01-03', promptPreview: 'third', fileCount: 1 },
    ]);
    const deps = fakeDeps();
    await rewindCmd(['my-session', '--list'], deps);
    const all = (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join('');
    expect(all).toContain('first');
    expect(all).toContain('3 files');
    expect(all).toContain('1 file');
  });

  it('shows usage when no action flag passed', async () => {
    const deps = fakeDeps();
    const code = await rewindCmd([], deps);
    expect(code).toBe(1);
    const all = (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join('');
    expect(all).toContain('Usage:');
  });

  it('--all calls rewindToStart and reports no-files when empty', async () => {
    rewindInstance.rewindToStart.mockResolvedValue({
      revertedFiles: [],
      errors: [],
      toPromptIndex: 0,
    });
    const deps = fakeDeps();
    const code = await rewindCmd(['--all'], deps);
    expect(code).toBe(0);
    expect(rewindInstance.rewindToStart).toHaveBeenCalledWith('auto-session-1');
    const all = (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join('');
    expect(all).toContain('No files to revert');
  });

  it('--all reports reverted files with checkmarks', async () => {
    rewindInstance.rewindToStart.mockResolvedValue({
      revertedFiles: ['src/a.ts', 'src/b.ts'],
      errors: [],
      toPromptIndex: 0,
    });
    const deps = fakeDeps();
    const code = await rewindCmd(['--all'], deps);
    expect(code).toBe(0);
    const all = (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join('');
    expect(all).toContain('src/a.ts');
    expect(all).toContain('src/b.ts');
    expect(all).toContain('Reverted 2 file');
  });

  it('--last N rewinds last N', async () => {
    rewindInstance.rewindLastN.mockResolvedValue({
      revertedFiles: ['src/foo.ts'],
      errors: [],
      toPromptIndex: 1,
    });
    const deps = fakeDeps();
    await rewindCmd(['--last', '2'], deps);
    expect(rewindInstance.rewindLastN).toHaveBeenCalledWith('auto-session-1', 2);
  });

  it('--last with invalid N reports usage', async () => {
    const deps = fakeDeps();
    const code = await rewindCmd(['--last', 'abc'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith('--last requires a positive number');
  });

  it('--last with 0 reports usage', async () => {
    const deps = fakeDeps();
    const code = await rewindCmd(['--last', '0'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith('--last requires a positive number');
  });

  it('--to <idx> calls rewindToCheckpoint', async () => {
    rewindInstance.rewindToCheckpoint.mockResolvedValue({
      revertedFiles: ['x.ts'],
      errors: [],
      toPromptIndex: 3,
    });
    const deps = fakeDeps();
    await rewindCmd(['--to', '3'], deps);
    expect(rewindInstance.rewindToCheckpoint).toHaveBeenCalledWith('auto-session-1', 3);
  });

  it('--to invalid number reports usage', async () => {
    const deps = fakeDeps();
    const code = await rewindCmd(['--to', 'bad'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith('--to requires a non-negative number');
  });

  it('--to negative reports usage', async () => {
    const deps = fakeDeps();
    const code = await rewindCmd(['--to', '-1'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith('--to requires a non-negative number');
  });

  it('--resume after rewind truncates session history', async () => {
    rewindInstance.rewindLastN.mockResolvedValue({
      revertedFiles: ['x.ts'],
      errors: [],
      toPromptIndex: 5,
    });
    const truncate = vi.fn().mockResolvedValue(3);
    const close = vi.fn().mockResolvedValue(undefined);
    storeInstance.resume.mockResolvedValue({
      writer: { truncateToCheckpoint: truncate, close },
    });
    const deps = fakeDeps();
    await rewindCmd(['--last', '1', '--resume'], deps);
    expect(registryInstance.register).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'auto-session-1',
        clientType: 'cli',
        pid: process.pid,
      }),
    );
    expect(truncate).toHaveBeenCalledWith(5);
    expect(close).toHaveBeenCalled();
    expect(registryInstance.unregister).toHaveBeenCalledOnce();
  });

  it('--resume with no reverted files still truncates', async () => {
    rewindInstance.rewindToStart.mockResolvedValue({
      revertedFiles: [],
      errors: [],
      toPromptIndex: 0,
    });
    const truncate = vi.fn().mockResolvedValue(0);
    const close = vi.fn().mockResolvedValue(undefined);
    storeInstance.resume.mockResolvedValue({
      writer: { truncateToCheckpoint: truncate, close },
    });
    const deps = fakeDeps();
    const code = await rewindCmd(['--all', '--resume'], deps);
    expect(code).toBe(0);
    expect(truncate).toHaveBeenCalledWith(0);
  });

  it('--resume refuses to mutate a session owned by another live PID', async () => {
    registryInstance.register.mockRejectedValue(
      new Error('Session auto-session-1 is already open in another running wstack (pid 4242).'),
    );
    const deps = fakeDeps();

    const code = await rewindCmd(['--all', '--resume'], deps);

    expect(code).toBe(1);
    expect(rewindInstance.rewindToStart).not.toHaveBeenCalled();
    expect(storeInstance.resume).not.toHaveBeenCalled();
    expect(deps.renderer.writeError).toHaveBeenCalledWith(
      'Session auto-session-1 is already open in another running wstack (pid 4242).',
    );
    expect(registryInstance.unregister).not.toHaveBeenCalled();
  });

  it('returns 1 when rewind produces errors', async () => {
    rewindInstance.rewindToStart.mockResolvedValue({
      revertedFiles: ['x.ts'],
      errors: ['perm denied'],
      toPromptIndex: 0,
    });
    const deps = fakeDeps();
    const code = await rewindCmd(['--all'], deps);
    expect(code).toBe(1);
    const all = (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join('');
    expect(all).toContain('perm denied');
  });

  it('catches and reports thrown errors', async () => {
    rewindInstance.rewindToStart.mockRejectedValue(new Error('disk full'));
    const deps = fakeDeps();
    const code = await rewindCmd(['--all'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith('disk full');
  });

  it('handles non-Error thrown values', async () => {
    rewindInstance.rewindToStart.mockRejectedValue('string error');
    const deps = fakeDeps();
    const code = await rewindCmd(['--all'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith('string error');
  });
});
