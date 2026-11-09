import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import { canTransition } from '../../src/server/lifecycle.js';
import { LSPServer } from '../../src/server/lsp-server.js';

function makeServer() {
  const warn = vi.fn();
  const log: Logger = {
    level: 'error',
    error() {},
    warn,
    info() {},
    debug() {},
    trace() {},
    child() {
      return this;
    },
  };
  const server = new LSPServer(
    'probe',
    { command: process.execPath, languages: ['typescript'] },
    { cwd: process.cwd(), rootPath: process.cwd(), log, events: new EventBus() },
  );
  return { server, warn };
}

// Regression: `lifecycle.ts` declared the allowed edges but nothing enforced
// them — the server and the registry wrote `state` directly, and the table had
// drifted (no shutdown during startup, no error during shutdown). Writes now go
// through `LSPServer.transition`, so the table is the machine.
describe('LSPServer lifecycle table', () => {
  it('lets a shutdown that lands mid-startup finish in exited without a refused move', async () => {
    const { server, warn } = makeServer();

    const started = server.start();
    expect(server.state).toBe('starting');
    await server.shutdown();
    await started;

    expect(server.state).toBe('exited');
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses an edge the table does not declare and leaves the state untouched', () => {
    const { server, warn } = makeServer();
    expect(server.state).toBe('exited');

    expect(server.transition('ready')).toBe(false);

    expect(server.state).toBe('exited');
    expect(warn).toHaveBeenCalledWith('LSP probe refused lifecycle move exited -> ready');
  });

  it('declares the edges the server and registry actually take', () => {
    expect(canTransition('starting', 'shutting_down')).toBe(true);
    expect(canTransition('initializing', 'shutting_down')).toBe(true);
    expect(canTransition('reconnecting', 'shutting_down')).toBe(true);
    expect(canTransition('shutting_down', 'failed')).toBe(true);
    expect(canTransition('failed', 'exited')).toBe(true);
    expect(canTransition('ready', 'reconnecting')).toBe(false);
    expect(canTransition('disabled', 'ready')).toBe(false);
  });
});
