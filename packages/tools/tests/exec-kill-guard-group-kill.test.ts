import { afterEach, describe, expect, it, vi } from 'vitest';

// A group/all kill (`kill -9 -1234`, `kill -TERM -1`) signals every process in
// the group, so it must be refused while any protected process exists — the
// same rule the bash kill guard applies. Ordinary PID kills keep their checks.

let protectedPids: number[] = [];

vi.mock('../src/process-registry-persistent.js', () => ({
  getPersistentProcessRegistry: () => ({
    shouldBlockKill: async (pid: number) => protectedPids.includes(pid),
    getAllProtectedPids: async () => protectedPids,
    getGlobalStatus: async () => ({ instances: new Map() }),
  }),
  isEntryFromThisHost: () => true,
}));

async function loadGuard() {
  vi.resetModules();
  vi.doMock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    const patched = { ...actual, platform: () => 'linux' };
    return { ...patched, default: patched };
  });
  return import('../src/exec-kill-guard.js');
}

afterEach(() => {
  vi.doUnmock('node:os');
  protectedPids = [];
});

describe('exec kill guard process-group kills', () => {
  it('blocks group and all-process kills while a protected process exists', async () => {
    protectedPids = [5555];
    const { checkExecKillCommand } = await loadGuard();
    const blocked = async (args: string[]) => (await checkExecKillCommand('kill', args)).blocked;

    expect(await blocked(['-9', '-1234'])).toBe(true);
    expect(await blocked(['-TERM', '-1'])).toBe(true);
    expect(await blocked(['--', '-1234'])).toBe(true);
    expect(await blocked(['-s', 'TERM', '-1234'])).toBe(true);
    expect(await blocked(['-9', '-5555'])).toBe(true);
  });

  it('keeps ordinary PID checks intact', async () => {
    protectedPids = [5555];
    const { checkExecKillCommand } = await loadGuard();
    const blocked = async (args: string[]) => (await checkExecKillCommand('kill', args)).blocked;

    expect(await blocked(['-9', '5555'])).toBe(true);
    expect(await blocked(['-9', '1234'])).toBe(false);
    expect(await blocked(['-9', '1234', '5555'])).toBe(true);
    expect(await blocked(['-9', 'not-a-pid'])).toBe(false);
  });

  it('allows a group kill when there is no protected process to hit', async () => {
    protectedPids = [];
    const { checkExecKillCommand } = await loadGuard();
    expect((await checkExecKillCommand('kill', ['-9', '-1234'])).blocked).toBe(false);
  });
});
