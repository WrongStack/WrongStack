/**
 * @wrongstack/plugins — runtime/local-bin tests.
 *
 * These cover the two helpers that decide *how* a plugin launches an
 * external tool. Both exist because the obvious spelling —
 * `execFile('npx', ['biome', …])` — fails `ENOENT` on Windows (`npx` is a
 * `.cmd` shim and a shell-less spawn ignores `PATHEXT`), which every
 * plugin then misreads as "tool not installed". The result was a whole
 * class of plugins that silently did nothing on Windows.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearLocalBinCache,
  findOnPath,
  resolveExecInvocation,
  resolveFirstNodeBin,
  resolveNodeBin,
} from '../src/runtime/index.js';

const isWindows = process.platform === 'win32';
const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  clearLocalBinCache();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveNodeBin', () => {
  it('resolves an installed package to a node + bin-entry invocation', () => {
    clearLocalBinCache();
    const hit = resolveNodeBin('@biomejs/biome', 'biome', process.cwd());
    // biome is a dev dependency of this repo.
    expect(hit).not.toBeNull();
    expect(hit?.cmd).toBe(process.execPath);
    expect(hit?.args[0]).toBe(hit?.entry);
    expect(hit?.entry).toContain('biome');
  });

  it('appends extra args after the bin entry', () => {
    const hit = resolveNodeBin('@biomejs/biome', 'biome', process.cwd(), ['check', '--write']);
    expect(hit?.args.slice(1)).toEqual(['check', '--write']);
  });

  it('does not let extra args from one call leak into the next', () => {
    const first = resolveNodeBin('@biomejs/biome', 'biome', process.cwd(), ['check']);
    const second = resolveNodeBin('@biomejs/biome', 'biome', process.cwd());
    expect(first?.args).toEqual([first?.entry, 'check']);
    // The cached entry must not carry the previous call's arguments.
    expect(second?.args).toEqual([second?.entry]);
  });

  it('returns null for a package that is not installed', () => {
    expect(resolveNodeBin('definitely-not-a-real-package-xyz', 'nope', process.cwd())).toBeNull();
  });

  it('caches negative results so a missing tool is not re-probed on every call', () => {
    clearLocalBinCache();
    const a = resolveNodeBin('another-missing-package-abc', 'nope', process.cwd());
    const b = resolveNodeBin('another-missing-package-abc', 'nope', process.cwd());
    expect(a).toBeNull();
    expect(b).toBeNull();
  });

  it('expires negative results so a newly installed tool can be discovered', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const root = mkdtempSync(join(tmpdir(), 'local-bin-negative-cache-'));
    temporaryDirectories.push(root);
    writeFileSync(join(root, 'package.json'), '{}');

    expect(resolveNodeBin('later-installed-package-abc', 'bin', root)).toBeNull();

    const packageDirectory = join(root, 'node_modules', 'later-installed-package-abc');
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
      join(packageDirectory, 'package.json'),
      JSON.stringify({ name: 'later-installed-package-abc', bin: { bin: 'cli.js' } }),
    );
    writeFileSync(join(packageDirectory, 'cli.js'), '');

    // The fresh install remains hidden while the negative result is live.
    expect(resolveNodeBin('later-installed-package-abc', 'bin', root)).toBeNull();
    vi.advanceTimersByTime(5_001);
    expect(resolveNodeBin('later-installed-package-abc', 'bin', root)?.entry).toBe(
      join(packageDirectory, 'cli.js'),
    );
  });

  it('bounds the cache so a long session cannot grow it without limit', () => {
    clearLocalBinCache();
    // Far more distinct keys than the internal bound; must not throw or
    // retain everything.
    for (let i = 0; i < 200; i++) {
      resolveNodeBin(`missing-pkg-${i}`, 'bin', process.cwd());
    }
    // Still functional after heavy churn.
    expect(resolveNodeBin('@biomejs/biome', 'biome', process.cwd())).not.toBeNull();
  });
});

describe('resolveFirstNodeBin', () => {
  it('picks the first installed candidate and reports which it was', () => {
    const hit = resolveFirstNodeBin(
      [
        { packageName: 'not-installed-aaa', binName: 'aaa' },
        { packageName: '@biomejs/biome', binName: 'biome' },
      ],
      process.cwd(),
    );
    expect(hit?.packageName).toBe('@biomejs/biome');
  });

  it('returns null when no candidate is installed', () => {
    expect(
      resolveFirstNodeBin([{ packageName: 'not-installed-bbb', binName: 'bbb' }], process.cwd()),
    ).toBeNull();
  });
});

describe('resolveExecInvocation', () => {
  it('passes a plain executable through unchanged on POSIX', () => {
    const inv = resolveExecInvocation('git', ['status']);
    expect(inv.args).toEqual(['status']);
    if (!isWindows) {
      expect(inv.cmd).toBe('git');
      expect(inv.windowsVerbatimArguments).toBe(false);
    }
  });

  it('keeps process.execPath invocations shim-free on every platform', () => {
    // `node <entry>` is the preferred shape precisely because it never
    // needs the cmd.exe indirection.
    const inv = resolveExecInvocation(process.execPath, ['/tmp/entry.js', '--flag']);
    expect(inv.cmd).toBe(process.execPath);
    expect(inv.args).toEqual(['/tmp/entry.js', '--flag']);
    expect(inv.windowsVerbatimArguments).toBe(false);
  });

  it.runIf(isWindows)('routes a .cmd shim through cmd.exe with quoted args', () => {
    const inv = resolveExecInvocation('npx', ['biome', '--version']);
    expect(basename(inv.cmd).toLowerCase()).toBe('cmd.exe');
    expect(inv.windowsVerbatimArguments).toBe(true);
    expect(inv.args[0]).toBe('/d');
    expect(inv.args[1]).toBe('/c');
    // Every token is individually quoted, so a path with spaces stays one arg.
    expect(inv.args[2]).toContain('"biome"');
    expect(inv.args[2]).toContain('"--version"');
  });

  it.runIf(isWindows)('routes an uppercase .CMD shim through cmd.exe', () => {
    const inv = resolveExecInvocation('C:\\Tools\\NPM.CMD', ['--version']);
    expect(basename(inv.cmd).toLowerCase()).toBe('cmd.exe');
    expect(inv.windowsVerbatimArguments).toBe(true);
    expect(inv.args[2]).toContain('"C:\\Tools\\NPM.CMD"');
  });

  it.runIf(isWindows)('refuses arguments carrying cmd.exe metacharacters', () => {
    // The BatBadBut argument-injection class: without this guard a dynamic
    // path argument could chain a second command through the .cmd wrapper.
    expect(() => resolveExecInvocation('npx', ['biome', 'a & calc.exe'])).toThrow(/metacharacter/i);
  });

  it.runIf(!isWindows)('never rewrites the command on POSIX', () => {
    const inv = resolveExecInvocation('npx', ['biome', 'a & b']);
    expect(inv.cmd).toBe('npx');
    expect(inv.args).toEqual(['biome', 'a & b']);
  });
});

describe('findOnPath', () => {
  /**
   * `resolveWin32Command` returns its INPUT unchanged when nothing
   * matches, so callers cannot use it as an existence check. Treating
   * that passthrough as a hit made a missing tool look installed: the
   * caller spawned it, got ENOENT, silently did nothing, and still
   * reported itself healthy. `findOnPath` answers the question honestly.
   */
  it('returns null for a command that is not installed', () => {
    expect(findOnPath('definitely-not-a-real-binary-xyz123')).toBeNull();
  });

  it('finds the Node binary that is running this test', () => {
    const found = findOnPath(isWindows ? 'node.exe' : 'node');
    expect(found).not.toBeNull();
  });

  it('accepts an explicit path that exists', () => {
    expect(findOnPath(process.execPath)).not.toBeNull();
  });

  it('rejects an explicit path that does not exist', () => {
    expect(findOnPath('/no/such/dir/no-such-binary')).toBeNull();
  });

  it('returns null for an empty command', () => {
    expect(findOnPath('')).toBeNull();
  });
});
