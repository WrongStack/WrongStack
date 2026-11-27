import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LSPRegistry } from '../src/registry.js';
import { LSPServer } from '../src/server/lsp-server.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const cfg = {
  autoStart: 'eager' as const,
  servers: {
    ts: {
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      languages: ['typescript'],
      enabled: true,
    },
  },
};
const tracker = { reopenForServer: async () => {} } as never;
const events = { emit: () => {}, on: () => () => {} } as never;
const origStart = LSPServer.prototype.start;
const origShutdown = LSPServer.prototype.shutdown;
let tmpDir = '';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-bind-fence-'));
  await fs.writeFile(path.join(tmpDir, 'index.ts'), 'export const x = 1;\n', 'utf8');
});
afterEach(async () => {
  LSPServer.prototype.start = origStart;
  LSPServer.prototype.shutdown = origShutdown;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function registry(warn = vi.fn()) {
  const log = { debug: () => {}, info: () => {}, warn, error: () => {} } as never;
  return new LSPRegistry(cfg as never, tracker, { cwd: tmpDir, log, events });
}

it('a rebind superseded while the old servers stop starts nothing', async () => {
  const reg = registry();
  await reg.bind(tmpDir, 'never');
  const stopGate = deferred<void>();
  let starts = 0;
  LSPServer.prototype.shutdown = async () => {
    await stopGate.promise;
  };
  LSPServer.prototype.start = async () => {
    starts += 1;
  };

  const rebind = reg.bind(tmpDir, 'eager');
  const shut = reg.shutdown();
  stopGate.resolve();
  await Promise.all([rebind, shut]);

  expect(starts).toBe(0);
});

it('logs a failed shutdown of a server that finished starting after the bind was superseded', async () => {
  const warn = vi.fn();
  const reg = registry(warn);
  const startEntered = deferred<void>();
  const startGate = deferred<void>();
  LSPServer.prototype.start = async () => {
    startEntered.resolve();
    await startGate.promise;
  };
  LSPServer.prototype.shutdown = async () => {
    throw new Error('stop failed');
  };

  const bind = reg.bind(tmpDir, 'eager');
  await startEntered.promise;
  const shut = reg.shutdown();
  startGate.resolve();
  await Promise.all([bind, shut]);

  // Once from shutdown() itself and once for the late-started server.
  expect(warn).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenLastCalledWith('LSP ts shutdown failed', expect.any(Error));
});
