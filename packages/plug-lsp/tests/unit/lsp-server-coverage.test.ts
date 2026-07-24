import { EventEmitter } from 'node:events';
import { EventBus } from '@wrongstack/core/kernel';
import { describe, expect, it, vi } from 'vitest';
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
});
