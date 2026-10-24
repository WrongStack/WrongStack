import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';

const spawnError = new Error('spawn intercepted');
const safeSpawn = vi.fn(() => {
  throw spawnError;
});

vi.mock('../../src/utils/safe-spawn.js', () => ({
  resolveSpawnCommand: vi.fn(async () => 'C:\\tools\\typescript-language-server.cmd'),
  safeSpawn,
}));

const { LSPServer } = await import('../../src/server/lsp-server.js');

const log: Logger = {
  level: 'error',
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child() {
    return this;
  },
};

// A bare command that resolves to a different executable (Windows PATHEXT)
// must be spawned by its resolved path, keeping the rest of the config.
describe('LSPServer.start with a resolved command', () => {
  it('spawns the resolved command instead of the configured one', async () => {
    const config = {
      command: 'typescript-language-server',
      args: ['--stdio'],
      languages: ['typescript'],
    };
    const server = new LSPServer('ts', config, {
      cwd: process.cwd(),
      rootPath: process.cwd(),
      log,
      events: new EventBus(),
    });

    await server.start().catch(() => undefined);

    expect(safeSpawn).toHaveBeenCalledTimes(1);
    expect(safeSpawn).toHaveBeenCalledWith(
      { ...config, command: 'C:\\tools\\typescript-language-server.cmd' },
      process.cwd(),
    );
    expect(config.command).toBe('typescript-language-server');
  });
});
