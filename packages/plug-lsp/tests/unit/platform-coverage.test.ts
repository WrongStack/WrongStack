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

  it('formats numeric and signal-based process exits', () => {
    expect(setupCoverage.formatExitCode(7)).toBe('7');
    expect(setupCoverage.formatExitCode(null)).toBe('null');
  });
});
