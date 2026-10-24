import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { EventBus } from '@wrongstack/contracts/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => ({
  child: undefined as unknown,
  resolve: undefined as ((command: string) => Promise<string>) | undefined,
  calls: 0,
}));
vi.mock('../../src/utils/safe-spawn.js', () => ({
  resolveSpawnCommand: (command: string) => spawn.resolve?.(command) ?? Promise.resolve(command),
  safeSpawn: () => {
    spawn.calls++;
    return spawn.child;
  },
}));
const { LSPServer } = await import('../../src/server/lsp-server.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill() {
      this.killed = true;
      return true;
    },
  });
  const initializing = deferred<void>();
  let initializeId = 0;
  let onInitialized: (() => void) | undefined;
  const reply = (id: number, result: unknown) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id, result });
    child.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  child.stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString().split('\r\n\r\n')[1]!);
    if (request.method === 'initialize') {
      initializeId = request.id;
      initializing.resolve();
    }
    if (request.method === 'shutdown') reply(request.id, null);
    if (request.method === 'initialized') onInitialized?.();
  });
  spawn.child = child;
  const log = {
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
  const events = new EventBus();
  const server = new LSPServer(
    'startup',
    { command: 'fake-lsp', languages: ['typescript'] },
    {
      cwd: process.cwd(),
      rootPath: process.cwd(),
      log: log as never,
      events,
    },
  );
  return {
    server,
    events,
    initializing: initializing.promise,
    release: () => reply(initializeId, { capabilities: { hoverProvider: true } }),
    onInitialized: (callback: () => void) => {
      onInitialized = callback;
    },
  };
}

afterEach(() => {
  spawn.resolve = undefined;
  spawn.calls = 0;
});

describe('LSP startup retains only its own lifecycle', () => {
  it('keeps exited after shutdown rejects an older initialization', async () => {
    const { server, initializing } = harness();
    const started = server.start().catch((error: unknown) => error);
    await initializing;
    await server.shutdown();
    await started;
    expect(server.state).toBe('exited');
  });

  it('does not publish ready if shutdown starts before initialize completion is accepted', async () => {
    const value = harness();
    const ready = vi.fn();
    value.events.on('lsp.server.ready', ready);
    let stopped: Promise<void> | undefined;
    value.onInitialized(() => {
      stopped = value.server.shutdown();
    });
    const started = value.server.start().catch((error: unknown) => error);
    await value.initializing;
    value.release();
    await started;
    await stopped;
    expect(value.server.state).toBe('exited');
    expect(ready).not.toHaveBeenCalled();
    expect(value.server.capabilities).toBeNull();
  });

  it('drops stale command resolution after stop and restart, then starts the new generation', async () => {
    const oldCommand = deferred<string>();
    const newCommand = deferred<string>();
    let resolutions = 0;
    spawn.resolve = () => (++resolutions === 1 ? oldCommand.promise : newCommand.promise);
    const value = harness();
    const oldStart = value.server.start();
    await value.server.shutdown();
    const newStart = value.server.start();
    expect(value.server.state).toBe('starting');
    oldCommand.resolve('fake-lsp');
    await oldCommand.promise;
    expect(spawn.calls).toBe(0);
    await oldStart;
    newCommand.resolve('fake-lsp');
    await value.initializing;
    value.release();
    await newStart;
    expect(spawn.calls).toBe(1);
    expect(value.server.state).toBe('ready');
    await value.server.shutdown();
  });

  it('still starts a live child and shuts it down normally', async () => {
    const value = harness();
    const started = value.server.start();
    await value.initializing;
    value.release();
    await started;
    expect(value.server.state).toBe('ready');
    expect(value.server.capabilities).toMatchObject({ hoverProvider: true });
    await value.server.shutdown();
    expect(value.server.state).toBe('exited');
  });
});
