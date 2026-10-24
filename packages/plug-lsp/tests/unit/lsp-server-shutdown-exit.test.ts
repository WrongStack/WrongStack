import { expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => ({ child: undefined as unknown }));
vi.mock('../../src/utils/safe-spawn.js', () => ({
  resolveSpawnCommand: async (command: string) => command,
  safeSpawn: () => spawn.child,
}));

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { EventBus } from '@wrongstack/contracts/kernel';
import { LSPServer } from '../../src/server/lsp-server.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function shutdownCase(exitDuringShutdown: boolean) {
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
  const shutdownReceived = deferred<void>();
  let shutdownId = 0;
  const methods: string[] = [];
  const reply = (id: number, result: unknown) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id, result });
    child.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  child.stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString().split('\r\n\r\n')[1]!);
    methods.push(request.method);
    if (request.method === 'initialize') reply(request.id, { capabilities: {} });
    if (request.method === 'shutdown') {
      shutdownId = request.id;
      shutdownReceived.resolve();
    }
  });
  const log = { debug() {}, error() {}, warn() {}, info() {}, trace() {} };
  const server = new LSPServer(
    'shutdown-proof',
    { command: 'fake', languages: ['typescript'] },
    {
      cwd: process.cwd(),
      rootPath: process.cwd(),
      events: new EventBus(),
      log: log as never,
    },
  );
  return {
    child,
    server,
    methods,
    shutdownReceived: shutdownReceived.promise,
    release() {
      if (exitDuringShutdown) child.emit('exit', 0, null);
      else reply(shutdownId, null);
    },
  };
}

it('completes shutdown after child exit or stdout closure and tolerates repeated shutdown', async () => {
  for (const mode of ['exit', 'close', 'normal'] as const) {
    const value = await shutdownCase(mode === 'exit');
    spawn.child = value.child;
    await value.server.start();
    const stopped = value.server.shutdown();
    await value.shutdownReceived;
    if (mode === 'close') value.child.stdout.emit('close');
    else value.release();
    await stopped;
    expect(value.server.state).toBe('exited');
    await value.server.shutdown();
    expect(value.server.state).toBe('exited');
    if (mode === 'normal') expect(value.methods).toContain('exit');
  }
});
