import { EventBus } from '@wrongstack/core/kernel';
import type { Logger } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { LSPServer } from '../../src/server/lsp-server.js';

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

// Regression: start() did not guard the `shutting_down` state, so a start
// issued while a shutdown was in flight spawned a replacement child that the
// in-flight shutdown then closed and killed through the shared slots.
describe('LSPServer.start during shutdown', () => {
  it('is a no-op while the server is shutting down', async () => {
    const events = new EventBus();
    const starting = vi.fn();
    events.on('lsp.server.starting', starting);

    const server = new LSPServer(
      'probe',
      { command: process.execPath, languages: ['typescript'] },
      { cwd: process.cwd(), rootPath: process.cwd(), log, events },
    );
    server.state = 'shutting_down';

    await server.start();

    expect(server.state).toBe('shutting_down');
    expect(starting).not.toHaveBeenCalled();
  });
});
