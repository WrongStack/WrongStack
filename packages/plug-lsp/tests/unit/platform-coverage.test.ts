import { buildWin32CmdShimInvocation } from '@wrongstack/core/utils';
import { describe, expect, it } from 'vitest';
import { setupCoverage } from '../../src/setup.js';
import { safeSpawnCoverage } from '../../src/utils/safe-spawn.js';

describe('platform helper coverage', () => {
  it('selects shell usage for Windows command wrappers only', () => {
    expect(safeSpawnCoverage.shouldUseShell('server.cmd', 'win32')).toBe(true);
    expect(safeSpawnCoverage.shouldUseShell('server.BAT', 'win32')).toBe(true);
    expect(safeSpawnCoverage.shouldUseShell('server.exe', 'win32')).toBe(false);
    expect(safeSpawnCoverage.shouldUseShell('server.cmd', 'linux')).toBe(false);
    expect(safeSpawnCoverage.serverArgs(undefined)).toEqual([]);
    expect(safeSpawnCoverage.serverArgs(['--stdio'])).toEqual(['--stdio']);
  });

  // The local `quoteForShell` was removed with WS-SEC-11: quoting the command
  // while passing `args` through `shell: true` is the BatBadBut hazard. Windows
  // shim construction now goes through the repo's canonical
  // `buildWin32CmdShimInvocation`, which quotes every token and refuses
  // metacharacters outright. Its behaviour is covered where it lives.
  it('spawns a Windows .cmd shim through the canonical builder', () => {
    const shim = buildWin32CmdShimInvocation('C:\\Program Files\\ls.cmd', ['--stdio']);
    expect(shim.command).toBe(process.env['COMSPEC'] ?? 'cmd.exe');
    expect(shim.args).toEqual(['/d', '/c', 'call "C:\\Program Files\\ls.cmd" "--stdio"']);
    expect(shim.windowsVerbatimArguments).toBe(true);
  });

  it('refuses a server argument carrying a cmd.exe metacharacter', () => {
    // The hole WS-SEC-11 closed: `shell: true` + an args array let this run
    // a second program off the back of the .cmd wrapper.
    expect(() => buildWin32CmdShimInvocation('ls.cmd', ['--flag=x&calc.exe'])).toThrow(
      /metacharacter/,
    );
  });

  it('formats numeric and signal-based process exits', () => {
    expect(setupCoverage.formatExitCode(7)).toBe('7');
    expect(setupCoverage.formatExitCode(null)).toBe('null');
  });
});
