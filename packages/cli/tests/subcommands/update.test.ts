import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock update-check module — use vi.hoisted so mockCheckForUpdate is available when the factory runs
const { mockCheckForUpdate } = vi.hoisted(() => ({ mockCheckForUpdate: vi.fn() }));
vi.mock('../../src/update-check.js', () => ({
  checkForUpdate: mockCheckForUpdate,
}));

// Import after mock — hoisting means the mock is applied before subcommands/index.js evaluates
import { type SubcommandDeps, subcommands } from '../../src/subcommands/index.js';

class CapStream extends Writable {
  buf = '';
  override _write(c: Buffer | string, _e: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.buf += typeof c === 'string' ? c : c.toString('utf8');
    cb();
  }
}

function mkRig() {
  const out = new CapStream();
  const err = new CapStream();
  return { out, err };
}

function fakeRegistry() {
  return {
    load: async () => ({}),
    refresh: async () => ({}),
    listProviders: async () => [],
    getProvider: async () => undefined,
    getModel: async () => undefined,
    suggestModel: async () => undefined,
    ageSeconds: async () => 60,
  };
}

function mkDeps(rig: ReturnType<typeof mkRig>) {
  return {
    config: { providers: {}, log: { level: 'error' } } as never,
    renderer: {
      writeInfo: (msg: string) => { rig.out.buf += msg + '\n'; },
      write: (msg: string) => { rig.out.buf += msg; },
    },
    reader: { readLine: vi.fn(async () => ''), readKey: vi.fn(async () => ''), close: vi.fn(async () => {}) } as never,
    modelsRegistry: fakeRegistry() as never,
    paths: { globalRoot: '/tmp/g' } as never,
    cwd: '/tmp',
    projectRoot: '/tmp',
    userHome: '/tmp',
  } as never as SubcommandDeps;
}

describe('update subcommand', () => {
  beforeEach(() => {
    mockCheckForUpdate.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 0 and reports up-to-date when on latest', async () => {
    mockCheckForUpdate.mockResolvedValue({
      current: '0.5.2',
      latest: '0.5.2',
      outdated: false,
      checkFailed: false,
    });

    const rig = mkRig();
    const code = await subcommands['update']!([], mkDeps(rig));

    expect(code).toBe(0);
    expect(rig.out.buf).toContain('latest version');
  });

  it('--check-only prints available update without installing', async () => {
    mockCheckForUpdate.mockResolvedValue({
      current: '0.5.2',
      latest: '999.0.0',
      outdated: true,
      checkFailed: false,
    });

    const rig = mkRig();
    const code = await subcommands['update']?.(['--check-only'], mkDeps(rig));

    expect(code).toBe(0);
    expect(rig.out.buf).toContain('Update available:');
    expect(rig.out.buf).toContain('v999.0.0');
    expect(rig.out.buf).not.toContain('Updating');
  });

  it('--check-only prints up-to-date when already latest', async () => {
    mockCheckForUpdate.mockResolvedValue({
      current: '0.5.2',
      latest: '0.5.2',
      outdated: false,
      checkFailed: false,
    });

    const rig = mkRig();
    const code = await subcommands['update']?.(['--check-only'], mkDeps(rig));

    expect(code).toBe(0);
    expect(rig.out.buf).toContain('latest version');
  });

  it('-c is an alias for --check-only', async () => {
    mockCheckForUpdate.mockResolvedValue({
      current: '0.5.2',
      latest: '999.0.0',
      outdated: true,
      checkFailed: false,
    });

    const rig = mkRig();
    const code = await subcommands['update']?.(['-c'], mkDeps(rig));

    expect(code).toBe(0);
    expect(rig.out.buf).toContain('Update available:');
    expect(rig.out.buf).toContain('v999.0.0');
  });

  it('fails closed when the registry check fails', async () => {
    mockCheckForUpdate.mockResolvedValue({
      current: '0.5.2',
      latest: '0.5.2',
      outdated: false,
      checkFailed: true,
    });

    const rig = mkRig();
    const code = await subcommands['update']!([], mkDeps(rig));

    expect(code).toBe(1);
    expect(rig.out.buf).toContain('Update check failed');
    expect(rig.out.buf).not.toContain('latest version');
  });

  it('skips update when not outdated', async () => {
    mockCheckForUpdate.mockResolvedValue({
      current: '0.5.2',
      latest: '0.5.2',
      outdated: false,
      checkFailed: false,
    });

    const rig = mkRig();
    const code = await subcommands['update']!([], mkDeps(rig));

    expect(code).toBe(0);
    expect(rig.out.buf).not.toContain('Updating');
    expect(rig.out.buf).toContain('already on');
  });
});