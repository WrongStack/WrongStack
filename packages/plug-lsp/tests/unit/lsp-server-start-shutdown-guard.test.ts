import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
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

  it('does not spawn when a shutdown lands while the command is resolving', async () => {
    const events = new EventBus();
    const server = new LSPServer(
      'probe',
      { command: process.execPath, languages: ['typescript'] },
      { cwd: process.cwd(), rootPath: process.cwd(), log, events },
    );

    // start() runs synchronously up to the command-resolution await.
    const started = server.start();
    expect(server.state).toBe('starting');
    server.state = 'shutting_down';
    await started;

    expect(server.state).toBe('shutting_down');
    expect((server as unknown as { child: unknown }).child).toBeNull();
  });

  it('coalesces concurrent start() calls onto the in-flight startup promise', async () => {
    const events = new EventBus();
    const server = new LSPServer(
      'probe',
      { command: process.execPath, languages: ['typescript'] },
      { cwd: process.cwd(), rootPath: process.cwd(), log, events },
    );

    let releaseDoStart!: () => void;
    const doStartGate = new Promise<void>((resolve) => {
      releaseDoStart = resolve;
    });
    const doStartSpy = vi
      .spyOn(server as unknown as { startOnce: () => Promise<void> }, 'startOnce')
      .mockImplementation(async () => {
        server.state = 'starting';
        await doStartGate;
        server.state = 'ready';
      });

    const first = server.start();
    const second = server.start();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });

    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(doStartSpy).toHaveBeenCalledTimes(1);

    releaseDoStart();
    await Promise.all([first, second]);
    expect(secondSettled).toBe(true);
    expect(server.state).toBe('ready');
  });

  it('a start() re-entered from the starting event neither relaunches nor waits on itself', async () => {
    const events = new EventBus();
    const server = new LSPServer(
      'probe',
      { command: process.execPath, languages: ['typescript'] },
      { cwd: process.cwd(), rootPath: process.cwd(), log, events },
    );
    const startOnce = vi.spyOn(
      server as unknown as { startOnce: () => Promise<void> },
      'startOnce',
    );

    // `lsp.server.starting` is emitted synchronously from inside the launch,
    // before the in-flight promise is recorded. A listener that calls start()
    // again sees `starting` with no promise to join yet.
    const reentrant: Promise<void>[] = [];
    events.on('lsp.server.starting', () => {
      reentrant.push(server.start());
    });

    const settled: string[] = [];
    const outer = server.start().then(() => settled.push('outer'));
    expect(reentrant).toHaveLength(1);
    expect(server.state).toBe('starting');
    void reentrant[0]!.then(() => settled.push('reentrant'));
    // Falling through would recurse launch -> event -> start -> launch.
    expect(startOnce).toHaveBeenCalledTimes(1);

    // Stop the outer launch before it spawns anything (it is parked on the
    // command-resolution await).
    await server.shutdown();
    await outer;
    // The re-entrant call returned on its own instead of joining the launch
    // that is still running underneath the listener.
    expect(settled).toEqual(['reentrant', 'outer']);
    expect(startOnce).toHaveBeenCalledTimes(1);
    expect(server.state).toBe('exited');
    expect((server as unknown as { child: unknown }).child).toBeNull();
  });
});
