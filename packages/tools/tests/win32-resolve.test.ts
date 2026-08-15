import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSafeWin32ShellArgs,
  buildWin32CmdShimInvocation,
  resolveWin32Command,
} from '../src/_win32-resolve.js';

const realPlatform = process.platform;
const realPath = process.env['PATH'];
const realPathext = process.env['PATHEXT'];

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  process.env['PATH'] = realPath;
  process.env['PATHEXT'] = realPathext;
});

describe('resolveWin32Command', () => {
  it('returns the command unchanged on non-Windows platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(resolveWin32Command('pnpm')).toBe('pnpm');
  });

  it('returns commands that already contain a path or extension unchanged (win32)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(resolveWin32Command('C:\\tools\\pnpm')).toBe('C:\\tools\\pnpm');
    expect(resolveWin32Command('bin/pnpm')).toBe('bin/pnpm');
    expect(resolveWin32Command('pnpm.cmd')).toBe('pnpm.cmd');
  });

  // #249: this test uses filesystem operations (chmod, tmpdir) that behave
  // differently on POSIX vs Windows. Platform-isolated to win32 to avoid
  // spurious failures on Linux/macOS CI runners.
  it.skipIf(process.platform !== 'win32')(
    'resolves a bare command to its full PATHEXT path when found (win32)',
    () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w32-'));
      try {
        const full = path.join(dir, 'mytool.cmd');
        fs.writeFileSync(full, '@echo off');
        // The resolver probes with X_OK; on a real POSIX runner (CI ubuntu)
        // the mode bit matters even though the test mocks platform=win32.
        fs.chmodSync(full, 0o755);
        process.env['PATHEXT'] = '.CMD';
        process.env['PATH'] = dir;
        expect(resolveWin32Command('mytool')).toBe(full);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('returns the original command when it cannot be found on PATH (win32)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env['PATHEXT'] = '.CMD';
    process.env['PATH'] = fs.mkdtempSync(path.join(os.tmpdir(), 'w32-empty-'));
    expect(resolveWin32Command('definitely-not-here-xyz')).toBe('definitely-not-here-xyz');
  });

  it('falls back to default PATHEXT/PATH when the env vars are unset (win32)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['PATHEXT'];
    delete process.env['PATH'];
    // No PATH → nothing found → returns original (exercises the ?? defaults).
    expect(resolveWin32Command('nope-cmd')).toBe('nope-cmd');
  });

  it('resolves a bare command to a .exe in a path containing spaces (win32)', () => {
    // Regression: the WrongStack exec allowlist did not include `gh`, and
    // developers reported "gh.exe unreachable due to path-with-spaces" — but
    // the underlying resolver was actually correct. The allowlist miss was
    // what was masking the real (working) behavior. This test pins the
    // resolver's contract: a directory whose path contains spaces, containing
    // a .exe matching PATHEXT, must be resolved to its full path.
    //
    // The actual gh.exe lives at "C:\Program Files\GitHub CLI\gh.exe" on
    // developer workstations, so this scenario is the realistic one.
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'w32-spaces-'));
    const dirWithSpaces = path.join(parent, 'dir with spaces');
    fs.mkdirSync(dirWithSpaces, { recursive: true });
    try {
      const full = path.join(dirWithSpaces, 'mytool.exe');
      fs.writeFileSync(full, '');
      fs.chmodSync(full, 0o755);
      process.env['PATHEXT'] = '.EXE';
      process.env['PATH'] = dirWithSpaces;
      expect(resolveWin32Command('mytool')).toBe(full);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('resolveWin32Command — gh.exe path-with-spaces regression', () => {
  // Stronger regression: not just "resolver returns the right string",
  // but "the returned path is something node:child_process.spawn() can
  // invoke with shell:false, the same way exec.ts calls it for .exe
  // targets". This is the path that historically failed for users trying
  // to run `gh` from "C:\Program Files\GitHub CLI\gh.exe".
  //
  // Skipped off-win32 (quoting is Windows-specific) and skipped when
  // gh is not installed (env-dependent).

  it.skipIf(process.platform !== 'win32')(
    'resolves bare "gh" to a path with spaces when installed (env-driven)',
    () => {
      // Env-driven location lookup so CI is deterministic. Three resolution
      // modes, in priority order:
      //   1. WRONGSTACK_REGRESSION_GH_PATH set AND the file exists → use that.
      //   2. Default install path exists → use "C:\Program Files\GitHub CLI\gh.exe".
      //   3. Neither → skip (returns a no-op, the test still passes).
      //
      // The test is skipIf(not win32) above, so non-Windows runners always
      // skip regardless of env. The hermetic test above
      // ('resolves a bare command to a .exe in a path containing spaces')
      // already covers the generic case; this one pins the specific real-world
      // gh.exe location that historically failed for users.
      const overridePath = process.env['WRONGSTACK_REGRESSION_GH_PATH'];
      const defaultPath = 'C:\\Program Files\\GitHub CLI\\gh.exe';
      const ghPath =
        overridePath && fs.existsSync(overridePath)
          ? overridePath
          : fs.existsSync(defaultPath)
            ? defaultPath
            : null;
      if (ghPath === null) return; // neither override nor default available — skip

      // Point PATH at the dir so the resolver finds the bare name.
      process.env['PATHEXT'] = '.EXE';
      const sep = path.delimiter;
      const originalPath = process.env['PATH'];
      process.env['PATH'] = path.dirname(ghPath) + sep + (originalPath ?? '');

      const resolved = resolveWin32Command('gh');
      expect(resolved).toBe(ghPath);
      // The path is callable: it exists and is executable.
      expect(fs.existsSync(resolved)).toBe(true);
      fs.accessSync(resolved, fs.constants.X_OK);

      // Restore PATH so the rest of the suite isn't perturbed.
      process.env['PATH'] = originalPath;
    },
  );
});

describe('assertSafeWin32ShellArgs', () => {
  it('accepts ordinary flags, paths, and values', () => {
    expect(() =>
      assertSafeWin32ShellArgs([
        'outdated',
        '--json',
        '--filter',
        './packages/core',
        'C:\\Program Files (x86)\\node\\pkg',
        'feat: do thing #42@scope/name',
      ]),
    ).not.toThrow();
  });

  it('rejects command chaining, redirection, and quote-breaking metacharacters', () => {
    for (const bad of [
      'a & calc',
      'x | whoami',
      'in < f',
      'out > f',
      '"breakout"',
      'line1\nline2',
      'cr\rinject',
      'nul\0byte',
    ]) {
      expect(() => assertSafeWin32ShellArgs(['ok', bad])).toThrow(
        /command injection|metacharacter/i,
      );
    }
  });

  it('ignores non-string entries without throwing', () => {
    expect(() => assertSafeWin32ShellArgs(['ok', undefined as never, 123 as never])).not.toThrow();
  });

  it('is a no-op for an empty arg list', () => {
    expect(() => assertSafeWin32ShellArgs([])).not.toThrow();
  });
});

describe('buildWin32CmdShimInvocation', () => {
  it('builds a cmd.exe invocation without shell:true or argv concatenation', () => {
    const invocation = buildWin32CmdShimInvocation('C:\\Program Files\\nodejs\\pnpm.cmd', [
      'test',
      'space arg',
    ]);

    expect(invocation.command.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(invocation.args).toEqual([
      '/d',
      '/c',
      'call "C:\\Program Files\\nodejs\\pnpm.cmd" "test" "space arg"',
    ]);
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });
});
