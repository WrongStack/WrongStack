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

  it('quotes the shell command path exactly once', () => {
    // cmd.exe gets one string, so an unquoted "C:\\Program Files\\..." breaks
    // at the first space; quoting an already-quoted path breaks it differently.
    expect(safeSpawnCoverage.quoteForShell('C:\\Program Files\\ls.cmd')).toBe(
      '"C:\\Program Files\\ls.cmd"',
    );
    expect(safeSpawnCoverage.quoteForShell('"C:\\ls.cmd"')).toBe('"C:\\ls.cmd"');
  });

  it('formats numeric and signal-based process exits', () => {
    expect(setupCoverage.formatExitCode(7)).toBe('7');
    expect(setupCoverage.formatExitCode(null)).toBe('null');
  });
});
