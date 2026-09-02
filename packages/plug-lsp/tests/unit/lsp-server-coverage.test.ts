import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from '@wrongstack/core/kernel';
import { describe, expect, it, vi } from 'vitest';
import { DocumentTracker } from '../../src/document-tracker.js';
import { LSPRegistry } from '../../src/registry.js';
import type { PlugLSPConfig } from '../../src/types.js';
import { LSPServer, lspServerCoverage } from '../../src/server/lsp-server.js';
import { LSPErrorCode } from '../../src/types.js';

const log = {
  level: 'error',
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child() {
    return this;
  },
};

function server() {
  return new LSPServer(
    'coverage',
    { command: process.execPath, languages: ['typescript'] },
    { cwd: process.cwd(), rootPath: process.cwd(), log: log as never, events: new EventBus() },
  );
}

describe('LSP server completion coverage', () => {
  it('normalizes startup process errors and exits', async () => {
    const errored = new EventEmitter();
    const errorFailure = lspServerCoverage.startupFailure(errored as never);
    errored.emit('error', new Error('spawn failed'));
    await expect(errorFailure.promise).rejects.toMatchObject({
      code: LSPErrorCode.ServerFailed,
      message: expect.stringContaining('spawn failed'),
    });
    errorFailure.cancel();

    const exited = new EventEmitter();
    const exitFailure = lspServerCoverage.startupFailure(exited as never);
    exited.emit('exit', null, null);
    await expect(exitFailure.promise).rejects.toMatchObject({
      code: LSPErrorCode.ServerFailed,
      message: expect.stringContaining('code=null signal=null'),
    });
    exitFailure.cancel();

    const signaled = new EventEmitter();
    const signalFailure = lspServerCoverage.startupFailure(signaled as never);
    signaled.emit('exit', 2, 'SIGTERM');
    await expect(signalFailure.promise).rejects.toMatchObject({
      message: expect.stringContaining('code=2 signal=SIGTERM'),
    });
  });

  it('covers request fallbacks, notification guards, stderr bounds, and shutdown failures', async () => {
    const value = server();
    const internal = value as unknown as {
      state: 'stopped' | 'ready';
      connection: {
        sendRequest: ReturnType<typeof vi.fn>;
        sendNotification: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
      } | null;
      child: { killed: boolean } | null;
      captureStderr(chunk: Buffer): void;
    };

    value.notifyDidClose('file:///ignored.ts');
    internal.state = 'stopped';
    await value.shutdown();

    internal.state = 'ready';
    internal.connection = {
      sendRequest: vi.fn(async () => null),
      sendNotification: vi.fn(),
      close: vi.fn(),
    };
    expect(
      await value.codeAction(
        {
          textDocument: { uri: 'file:///a.ts' },
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          context: { diagnostics: [] },
        },
        1,
        new AbortController().signal,
      ),
    ).toEqual([]);
    expect(await value.pullDiagnostics('file:///a.ts', 1, new AbortController().signal)).toEqual(
      [],
    );
    value.notifyDidClose('file:///a.ts');
    expect(internal.connection.sendNotification).toHaveBeenCalled();

    internal.captureStderr(Buffer.from(`${Array.from({ length: 101 }, (_, i) => i).join('\n')}\n`));
    expect(value.lastStderr.split('\n')).toHaveLength(20);

    internal.connection.sendRequest.mockRejectedValueOnce(new Error('shutdown failed'));
    internal.child = { killed: true };
    await value.shutdown();
    expect(internal.connection).toBeNull();
  });

  it('handles an executable that fails to spawn', async () => {
    const value = new LSPServer(
      'missing',
      { command: 'definitely-missing-wrongstack-lsp-command', languages: ['typescript'] },
      { cwd: process.cwd(), rootPath: process.cwd(), log: log as never, events: new EventBus() },
    );
    await expect(value.start()).rejects.toMatchObject({ code: LSPErrorCode.ServerFailed });
  });

  it('skips the crash path when the child exits after shutdown', async () => {
    const fixtureServer = fileURLToPath(
      new URL('../integration/fixtures/crash-once-lsp-server.mjs', import.meta.url),
    );
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-cov-shutdown-'));
    try {
      await fs.writeFile(path.join(root, 'package.json'), '{}');

      const events = new EventBus();
      const crashed = vi.fn();
      events.on('lsp.server.crashed', crashed);
      const holder: { registry?: LSPRegistry } = {};
      const tracker = new DocumentTracker(() => holder.registry!, log as never, root);
      const cfg: PlugLSPConfig = {
        servers: {
          shutdownTest: {
            command: process.execPath,
            args: [fixtureServer, path.join(root, 'no-marker')],
            languages: ['typescript'],
            rootPatterns: ['package.json'],
            startupTimeoutMs: 5000,
            enabled: true,
          },
        },
        autoStart: 'lazy',
        diagnosticsAfterEdit: 'background',
        diagnosticsWaitMs: 100,
        severityFilter: ['error', 'warning'],
        maxDiagnosticsPerFile: 10,
        maxDiagnosticsTotal: 20,
        autoDiscover: false,
        logServerOutput: false,
      };
      const registry = new LSPRegistry(cfg, tracker, { cwd: root, log: log as never, events });
      holder.registry = registry;
      await registry.bind(root, 'lazy');

      const source = path.join(root, 'sample.ts');
      await fs.writeFile(source, 'const x = 1;\n');
      await registry.findForPath(source, new AbortController().signal);
      await tracker.open(source);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Wait for server to become ready
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          if (registry.get('shutdownTest')?.state === 'ready') return resolve();
          if (Date.now() > deadline) return reject(new Error('timed out waiting for ready'));
          setTimeout(poll, 50);
        };
        poll();
      });
      expect(registry.get('shutdownTest')?.state).toBe('ready');

      // Shut down — the exit event fires asynchronously after the child is killed
      await registry.shutdown();

      // Yield to the event loop so the child 'exit' handler runs
      await new Promise((resolve) => setTimeout(resolve, 200));

      // The server state ended as 'exited' (crash-skip guard at lsp-server.ts:88
      // prevented overwriting 'shutting_down'/'exited' to 'failed')
      expect(registry.get('shutdownTest')?.state).toBe('exited');
      expect(crashed).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('caps diagnostics retention at MAX_DIAGNOSTICS_ENTRIES (oldest-first)', () => {
    const value = server();
    const withSet = value as unknown as {
      setDiagnostics(uri: string, diagnostics: unknown[]): void;
    };
    for (let i = 0; i < LSPServer.MAX_DIAGNOSTICS_ENTRIES + 10; i += 1) {
      withSet.setDiagnostics(`file:///doc-${i}.ts`, []);
    }
    expect(value.diagnostics.size).toBe(LSPServer.MAX_DIAGNOSTICS_ENTRIES);
    expect(value.diagnostics.has('file:///doc-0.ts')).toBe(false);
    expect(value.diagnostics.has(`file:///doc-${LSPServer.MAX_DIAGNOSTICS_ENTRIES + 9}.ts`)).toBe(
      true,
    );
  });

  it('eviction loop tolerates a broken map iterator (defensive guard at lsp-server.ts:332)', () => {
    const value = server();
    const withSet = value as unknown as {
      setDiagnostics(uri: string, diagnostics: unknown[]): void;
    };
    // Fill past the cap so the eviction loop is entered.
    for (let i = 0; i < LSPServer.MAX_DIAGNOSTICS_ENTRIES + 2; i += 1) {
      withSet.setDiagnostics(`file:///doc-${i}.ts`, []);
    }
    // Break the iterator: keys().next().value is undefined, so the loop must
    // stop via the `oldest === undefined` guard instead of deleting an entry.
    const brokenKeys = () => ({ next: () => ({ value: undefined, done: false }) });
    const originalKeys = value.diagnostics.keys;
    value.diagnostics.keys = brokenKeys as unknown as typeof originalKeys;
    try {
      withSet.setDiagnostics('file:///broken-iterator.ts', []);
      // Nothing was evicted — the guard exited the loop without deleting.
      expect(value.diagnostics.size).toBeGreaterThan(LSPServer.MAX_DIAGNOSTICS_ENTRIES);
      expect(value.diagnostics.has('file:///broken-iterator.ts')).toBe(true);
    } finally {
      value.diagnostics.keys = originalKeys;
    }
  });

  it('notifyDidClose drops the diagnostics entry for the closed document', () => {
    const value = server();
    (
      value as unknown as { setDiagnostics(uri: string, diagnostics: unknown[]): void }
    ).setDiagnostics('file:///a.ts', [{ severity: 1 }]);
    expect(value.getDiagnostics('file:///a.ts')).toHaveLength(1);
    value.notifyDidClose('file:///a.ts');
    expect(value.getDiagnostics('file:///a.ts')).toEqual([]);
  });
});
