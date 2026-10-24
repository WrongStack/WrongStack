import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import { LSPServer } from '../../src/server/lsp-server.js';

const uri = 'file:///probe.ts';
function fixture() {
  const log = { debug() {}, warn() {} } as unknown as Logger;
  const server = new LSPServer(
    'probe',
    { command: 'unused', languages: ['typescript'] },
    {
      cwd: process.cwd(),
      rootPath: process.cwd(),
      log,
      events: new EventBus(),
    },
  );
  const connection = {
    sendRequest: vi.fn(async (): Promise<unknown> => ({ kind: 'full', items: [] })),
    sendNotification() {},
    close() {},
  };
  const internal = server as unknown as {
    connection: typeof connection;
    setDiagnostics(uri: string, diagnostics: unknown[], version?: number): void;
    diagnosticsWaiters: Map<string, Set<() => void>>;
  };
  internal.connection = connection;
  server.state = 'ready';
  server.notifyDidOpen({ uri, languageId: 'typescript', version: 1, text: 'const a = 1;' });
  return { server, connection, internal };
}

describe('diagnostics lifecycle integrity', () => {
  it.each([null, {}, { kind: 'unchanged', resultId: 'unknown' }, { kind: 'full', items: null }])(
    'does not turn a malformed or unsolicited unchanged pull report into a clean result: %j',
    async (report) => {
      const { server, connection } = fixture();
      connection.sendRequest.mockResolvedValue(report);
      await expect(server.pullDiagnostics(uri, 100, new AbortController().signal)).rejects.toThrow(
        /diagnostic report/,
      );
    },
  );

  it('rejects an in-flight pull response after the file changes', async () => {
    const { server, connection } = fixture();
    let respond!: (result: unknown) => void;
    connection.sendRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const pending = server.pullDiagnostics(uri, 100, new AbortController().signal);
    server.notifyDidChange({ uri, version: 2 }, 'const a: number = "bad";');
    respond({ kind: 'full', items: [] });
    await expect(pending).rejects.toThrow(/changed/);
  });

  it('ignores versioned publications for an older document version', async () => {
    const { server, internal } = fixture();
    server.notifyDidChange({ uri, version: 2 }, 'const a: number = "bad";');
    internal.setDiagnostics(uri, [], 1);
    await expect(server.waitForDiagnostics(uri, 0, undefined, true)).rejects.toThrow(
      /not been verified/,
    );
    internal.setDiagnostics(uri, [], 2);
    await expect(server.waitForDiagnostics(uri, 0, undefined, true)).resolves.toEqual([]);
  });

  it('clears retained diagnostics on shutdown', async () => {
    const { server, internal } = fixture();
    internal.setDiagnostics(uri, [], 1);
    await server.shutdown();
    expect(server.diagnostics.size).toBe(0);
  });

  it('releases diagnostics waiters on shutdown rather than waiting out the timeout', async () => {
    const { server, internal } = fixture();
    const controller = new AbortController();
    const pending = server.waitForDiagnostics(uri, 60_000, controller.signal, true);
    const rejection = expect(pending).rejects.toThrow();
    try {
      await server.shutdown();
      expect(internal.diagnosticsWaiters.size).toBe(0);
    } finally {
      controller.abort();
      await rejection;
    }
  });

  it('removes waiter map entries after timeout and cancellation', async () => {
    const { server, internal } = fixture();
    await expect(server.waitForDiagnostics(uri, 1, undefined, true)).rejects.toThrow();
    expect(internal.diagnosticsWaiters.size).toBe(0);
    const controller = new AbortController();
    const pending = server.waitForDiagnostics(uri, 60_000, controller.signal, true);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(internal.diagnosticsWaiters.size).toBe(0);
  });

  it('rejects a pull result from a replaced connection', async () => {
    const { server, connection, internal } = fixture();
    let respond!: (result: unknown) => void;
    connection.sendRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const pending = server.pullDiagnostics(uri, 100, new AbortController().signal);
    internal.connection = { ...connection };
    respond({ kind: 'full', items: [] });
    await expect(pending).rejects.toThrow(/Server.*changed/);
  });

  it('does not accept a pull result after cancellation', async () => {
    const { server, connection } = fixture();
    let respond!: (result: unknown) => void;
    connection.sendRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = server.pullDiagnostics(uri, 100, controller.signal);
    controller.abort();
    respond({ kind: 'full', items: [] });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
