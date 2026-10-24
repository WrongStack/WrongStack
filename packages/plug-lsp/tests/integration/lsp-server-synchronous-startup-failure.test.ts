import { fileURLToPath } from 'node:url';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import { LSPServer } from '../../src/server/lsp-server.js';

const fixture = fileURLToPath(new URL('./fixtures/mock-lsp-server.mjs', import.meta.url));
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

function context(events = new EventBus()) {
  return { cwd: process.cwd(), rootPath: process.cwd(), log, events };
}

describe('LSP synchronous startup failure', () => {
  it('reports failed and retries successfully after an invalid argument is corrected', async () => {
    const config = { command: process.execPath, args: ['\0'], languages: ['typescript'] };
    const events = new EventBus();
    const crashed = vi.fn();
    events.on('lsp.server.crashed', crashed);
    const server = new LSPServer('invalid-argument', config, context(events));
    try {
      await expect(server.start()).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' });
      expect(server.state).toBe('failed');
      expect(crashed).toHaveBeenCalledTimes(1);
      expect(crashed).toHaveBeenCalledWith({
        name: 'invalid-argument',
        error: expect.stringContaining('null bytes'),
      });
      config.args = [fixture];
      await server.start();
      expect(server.state).toBe('ready');
      expect(crashed).toHaveBeenCalledTimes(1);
    } finally {
      await server.shutdown();
    }
  });

  it('remains retryable across repeated synchronous failures', async () => {
    const config = { command: process.execPath, args: ['\0'], languages: ['typescript'] };
    const events = new EventBus();
    const crashed = vi.fn();
    events.on('lsp.server.crashed', crashed);
    const server = new LSPServer('repeated', config, context(events));
    try {
      for (let i = 0; i < 3; i++) {
        await expect(server.start()).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' });
        expect(server.state).toBe('failed');
      }
      expect(crashed).toHaveBeenCalledTimes(3);
      config.args = [fixture];
      await server.start();
      expect(server.state).toBe('ready');
    } finally {
      await server.shutdown();
    }
  });

  it('keeps a disabled server disabled without attempting its invalid command', async () => {
    const events = new EventBus();
    const crashed = vi.fn();
    const starting = vi.fn();
    events.on('lsp.server.crashed', crashed);
    events.on('lsp.server.starting', starting);
    const server = new LSPServer(
      'disabled',
      { command: process.execPath, args: ['\0'], languages: ['typescript'], enabled: false },
      context(events),
    );
    await server.start();
    expect(server.state).toBe('disabled');
    expect(crashed).not.toHaveBeenCalled();
    expect(starting).not.toHaveBeenCalled();
  });

  it('starts and stops a valid local server without reporting a crash', async () => {
    const events = new EventBus();
    const crashed = vi.fn();
    events.on('lsp.server.crashed', crashed);
    const server = new LSPServer(
      'valid',
      { command: process.execPath, args: [fixture], languages: ['typescript'] },
      context(events),
    );
    try {
      await server.start();
      expect(server.state).toBe('ready');
    } finally {
      await server.shutdown();
    }
    expect(server.state).toBe('exited');
    expect(crashed).not.toHaveBeenCalled();
  });
});
