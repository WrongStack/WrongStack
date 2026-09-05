import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMocks.spawn(...args),
  };
});

const fsMocks = vi.hoisted(() => ({
  stat: vi.fn<() => Promise<{ isFile: () => boolean }>>(),
  statSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  stat: fsMocks.stat,
}));

vi.mock('node:fs', () => ({
  statSync: fsMocks.statSync,
}));

import { outdatedTool } from '../src/outdated.js';

const makeCtx = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' }) as any;
const makeOpts = () => ({ signal: new AbortController().signal });

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function childWithStdout(text: string, code = 0): FakeChild {
  const c = new FakeChild();
  setImmediate(() => {
    if (text) c.stdout.emit('data', Buffer.from(text));
    c.emit('close', code);
  });
  return c;
}

beforeEach(() => {
  spawnMocks.spawn.mockReset();
  // Default: empty output, exit 0 — keeps the metadata-only tests above passing
  spawnMocks.spawn.mockImplementation(() => childWithStdout('', 0));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('outdatedTool', () => {
  it('has correct metadata', () => {
    expect(outdatedTool.name).toBe('outdated');
    // Network side-effecting (registry HTTP) — routes through the
    // confirmation gate (M-1 contract: M-1 originally fixed four
    // sibling tools — mcp_control, shellcheck, shellcheck (scan mode),
    // search — but missed outdated; the audit's permission
    // policy at permission-policy.ts:188-195 special-cases
    // `mutating: true` tools into the confirm_needed flow regardless
    // of `permission`).
    expect(outdatedTool.permission).toBe('confirm');
    expect(outdatedTool.mutating).toBe(true);
    // H7 invariant: mutating tools must declare capabilities.
    // Canonical `net.outbound` (not the legacy `network` string) so the
    // subagent capability allowlist recognises read-only registry lookups.
    expect(outdatedTool.capabilities).toEqual(['net.outbound']);
  });

  it('handles default params', async () => {
    const ctx = makeCtx();
    const result = await outdatedTool.execute({}, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
    expect(result).toHaveProperty('packages');
  });

  it('passes only real flags to the package manager (no --table / --include)', async () => {
    let capturedArgs: string[] = [];
    spawnMocks.spawn.mockImplementation((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return childWithStdout('', 0);
    });
    await outdatedTool.execute({}, makeCtx(), makeOpts());
    expect(capturedArgs).toEqual(['outdated', '--json']);
  });

  it('parses JSON output from npm outdated into structured packages', async () => {
    const payload = JSON.stringify({
      vitest: {
        current: '1.0.0',
        latest: '2.0.0',
        wanted: '1.5.0',
        type: 'devDependencies',
        location: '/proj/node_modules/vitest',
      },
      prettier: {
        current: '3.0.0',
        latest: '3.2.0',
        wanted: '3.2.0',
        type: 'devDependencies',
      },
    });
    spawnMocks.spawn.mockImplementation(() => childWithStdout(payload, 1));
    const result = await outdatedTool.execute({}, makeCtx(), makeOpts());
    expect(result.total).toBe(2);
    expect(result.packages.map((p) => p.name).sort()).toEqual(['prettier', 'vitest']);
    expect(result.packages.find((p) => p.name === 'vitest')?.latest).toBe('2.0.0');
    // Missing `location` falls back to the package name
    expect(result.packages.find((p) => p.name === 'prettier')?.location).toBe('prettier');
    // Exit code 1 with valid JSON = "outdated packages found", not a failure.
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain('treated as success');
  });

  it('parses the pnpm outdated JSON shape (dependencyType, no location)', async () => {
    const payload = JSON.stringify({
      vitest: {
        current: '1.0.0',
        latest: '2.0.0',
        wanted: '1.5.0',
        isDeprecated: false,
        dependencyType: 'devDependencies',
      },
    });
    spawnMocks.spawn.mockImplementation(() => childWithStdout(payload, 1));
    const result = await outdatedTool.execute({}, makeCtx(), makeOpts());
    expect(result.total).toBe(1);
    const pkg = result.packages[0];
    expect(pkg?.current).toBe('1.0.0');
    expect(pkg?.latest).toBe('2.0.0');
    expect(pkg?.wanted).toBe('1.5.0');
    expect(pkg?.type).toBe('devDependencies');
    expect(pkg?.location).toBe('vitest');
    expect(result.exit_code).toBe(0);
  });

  it('returns "All packages up to date" when stdout is empty and exit code is 0', async () => {
    spawnMocks.spawn.mockImplementation(() => childWithStdout('', 0));
    const result = await outdatedTool.execute({}, makeCtx(), makeOpts());
    expect(result.output).toContain('up to date');
    expect(result.total).toBe(0);
  });

  it('returns "Could not check outdated packages" when stdout is empty and exit code is non-zero', async () => {
    spawnMocks.spawn.mockImplementation(() => childWithStdout('', 1));
    const result = await outdatedTool.execute({}, makeCtx(), makeOpts());
    expect(result.output).toContain('Could not check');
    expect(result.exit_code).toBe(1);
  });

  it('returns empty packages array when JSON is malformed but stdout has content', async () => {
    spawnMocks.spawn.mockImplementation(() => childWithStdout('not-json{', 0));
    const result = await outdatedTool.execute({}, makeCtx(), makeOpts());
    expect(result.packages).toEqual([]);
    expect(result.output).toBe('not-json{');
  });

  it('reports an error result when spawn emits error', async () => {
    spawnMocks.spawn.mockImplementation(() => {
      const c = new FakeChild();
      setImmediate(() => c.emit('error', new Error('spawn ENOENT')));
      return c;
    });
    const result = await outdatedTool.execute({}, makeCtx(), makeOpts());
    expect(result.exit_code).toBe(1);
    expect(result.output).toContain('ENOENT');
    expect(result.total).toBe(0);
  });

  it('marks output as truncated when stdout reaches the 100 KB cap', async () => {
    // Build a >= 100 KB payload that's still valid JSON
    const big = JSON.stringify({
      bigpkg: {
        current: '1',
        latest: '2',
        wanted: '1',
        type: 'd',
        location: 'x',
        desc: 'a'.repeat(100_000),
      },
    });
    spawnMocks.spawn.mockImplementation(() => childWithStdout(big, 1));
    const result = await outdatedTool.execute({}, makeCtx(), makeOpts());
    expect(result.truncated).toBe(true);
  });
});

describe('detectManager via fs stat mocks', () => {
  beforeEach(() => {
    spawnMocks.spawn.mockImplementation(() => childWithStdout('', 0));
    fsMocks.stat.mockReset();
  });

  it('detects pnpm when pnpm-lock.yaml stat succeeds', async () => {
    // stat for pnpm-lock.yaml succeeds → returns 'pnpm'
    // stat for yarn.lock throws → falls through
    fsMocks.stat
      .mockImplementationOnce(async (path: string) => {
        if (String(path).endsWith('pnpm-lock.yaml')) return { isFile: () => true } as any;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      })
      .mockImplementationOnce(async (_path: string) => {
        // Second call is for yarn.lock — should throw
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
    const _result = await outdatedTool.execute({}, makeCtx(), makeOpts());
    expect(spawnMocks.spawn).toHaveBeenCalledWith('pnpm', expect.any(Array), expect.any(Object));
  });

  it('detects yarn when yarn.lock stat succeeds', async () => {
    // stat for pnpm-lock.yaml throws → falls through
    // stat for yarn.lock succeeds → returns 'yarn'
    fsMocks.stat
      .mockImplementationOnce(async (path: string) => {
        if (String(path).endsWith('pnpm-lock.yaml'))
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      })
      .mockImplementationOnce(async (path: string) => {
        if (String(path).endsWith('yarn.lock')) return { isFile: () => true } as any;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
    const _result = await outdatedTool.execute({}, makeCtx(), makeOpts());
    expect(spawnMocks.spawn).toHaveBeenCalledWith('yarn', expect.any(Array), expect.any(Object));
  });
});

describe('runOutdated stderr collection', () => {
  it('collects stderr data via child.stderr.on("data")', async () => {
    class ChildWithBoth extends EventEmitter {
      stdout = new EventEmitter();
      stderr = new EventEmitter();
    }
    const child = new ChildWithBoth();
    spawnMocks.spawn.mockImplementationOnce(() => child);
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('{}'));
      child.stderr.emit('data', Buffer.from('npm warn something'));
      child.emit('close', 0);
    });
    const result = await outdatedTool.execute({}, makeCtx(), makeOpts());
    expect(result).toHaveProperty('exit_code');
  });

  it('executes cleanly when opts parameter is omitted', async () => {
    class ChildSimple extends EventEmitter {
      stdout = new EventEmitter();
      stderr = new EventEmitter();
    }
    const child = new ChildSimple();
    spawnMocks.spawn.mockImplementationOnce(() => child);
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('{}'));
      child.emit('close', 0);
    });
    const result = await (outdatedTool.execute as any)({}, makeCtx());
    expect(result.exit_code).toBe(0);
    expect(result.packages).toEqual([]);
  });
});
