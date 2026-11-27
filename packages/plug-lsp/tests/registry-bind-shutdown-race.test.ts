import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LSPRegistry } from '../src/registry.js';
import { LSPServer } from '../src/server/lsp-server.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('LSPRegistry bind/shutdown race (F2703)', () => {
  it('fences eager bind() when shutdown() or a newer bind() arrives during language detection', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-bind-race-'));
    await fs.writeFile(path.join(tmpDir, 'index.ts'), 'export const x = 1;\n', 'utf8');

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
    const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
    const tracker = { reopenForServer: async () => {} } as never;
    const fakeEvents = { emit: () => {}, on: () => () => {} } as never;

    const origStart = LSPServer.prototype.start;
    const origShutdown = LSPServer.prototype.shutdown;
    try {
      let startCallsAfterShutdown = 0;
      let isShutdown = false;
      LSPServer.prototype.start = async () => {
        if (isShutdown) startCallsAfterShutdown += 1;
      };
      const reg = new LSPRegistry(cfg as never, tracker, {
        cwd: tmpDir,
        log: silentLog,
        events: fakeEvents,
      });
      const bindP = reg.bind(tmpDir, 'eager');
      await reg.shutdown();
      isShutdown = true;
      await bindP;
      expect(startCallsAfterShutdown).toBe(0);

      // Overlapping bind('eager') followed by bind('never')
      let manualStartCalls = 0;
      LSPServer.prototype.start = async () => {
        manualStartCalls += 1;
      };
      const reg2 = new LSPRegistry(cfg as never, tracker, {
        cwd: tmpDir,
        log: silentLog,
        events: fakeEvents,
      });
      await Promise.all([reg2.bind(tmpDir, 'eager'), reg2.bind(tmpDir, 'never')]);
      expect(manualStartCalls).toBe(0);
      await reg2.shutdown();

      // shutdown() while server.start() is in flight shuts down the late-started server
      const startEntered = deferred<void>();
      const startGate = deferred<void>();
      let shutdownCalls = 0;
      LSPServer.prototype.start = async () => {
        startEntered.resolve();
        await startGate.promise;
      };
      LSPServer.prototype.shutdown = async () => {
        shutdownCalls += 1;
      };
      const reg3 = new LSPRegistry(cfg as never, tracker, {
        cwd: tmpDir,
        log: silentLog,
        events: fakeEvents,
      });
      const bind3 = reg3.bind(tmpDir, 'eager');
      await startEntered.promise;
      const shut3 = reg3.shutdown();
      startGate.resolve();
      await Promise.all([bind3, shut3]);
      expect(shutdownCalls).toBeGreaterThanOrEqual(2);
    } finally {
      LSPServer.prototype.start = origStart;
      LSPServer.prototype.shutdown = origShutdown;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
