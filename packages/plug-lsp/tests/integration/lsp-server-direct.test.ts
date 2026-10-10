import type { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from '@wrongstack/core/kernel';
import type { Logger } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { LSPServer } from '../../src/server/lsp-server.js';
import { LSPErrorCode } from '../../src/types.js';
import { pathToUri } from '../../src/utils/uri.js';

const fixtureServer = fileURLToPath(new URL('./fixtures/mock-lsp-server.mjs', import.meta.url));

const log: Logger = {
  level: 'debug',
  error() {},
  warn() {},
  info() {},
  debug: vi.fn(),
  trace() {},
  child() {
    return this;
  },
};

describe('LSPServer direct API', () => {
  it('covers lifecycle, notifications, request wrappers, and shutdown idempotency', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-server-'));
    const file = path.join(root, 'a.ts');
    const uri = pathToUri(file);
    const events = new EventBus();
    const ready = vi.fn();
    const diagnostics = vi.fn();
    const onCrash = vi.fn();
    events.on('lsp.server.ready', ready);
    events.on('lsp.diagnostics.updated', diagnostics);
    const server = new LSPServer(
      'mock',
      {
        command: process.execPath,
        args: [fixtureServer],
        languages: ['typescript'],
        startupTimeoutMs: 5000,
      },
      { cwd: root, rootPath: root, log, events, onCrash },
    );

    expect(server.rootPath).toBe(root);
    expect(server.getDiagnostics(uri)).toEqual([]);
    await expect(
      server.hover(
        { textDocument: { uri }, position: { line: 0, character: 0 } },
        1,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: LSPErrorCode.ServerNotReady });
    await server.start();
    await server.start();
    expect(ready).toHaveBeenCalledOnce();
    server.notifyDidOpen({ uri, languageId: 'typescript', version: 1, text: 'const answer = 1;' });
    await waitFor(() => server.getDiagnostics(uri)[0]?.message === 'mock diagnostic');
    expect(diagnostics).toHaveBeenCalled();
    expect(server.getDiagnostics(uri)[0]?.message).toBe('mock diagnostic');
    server.notifyDidChange({ uri, version: 2 }, 'const answer = 2;');
    // Wire-level regression: do not discard publishDiagnostics.version in the
    // notification handler and let an older empty result mark this edit clean.
    (
      server as unknown as { connection: { handleMessage(message: unknown): void } }
    ).connection.handleMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, version: 1, diagnostics: [] },
    });
    expect(server.getDiagnostics(uri)[0]?.message).toBe('mock diagnostic');

    // Stale-child guards: a restart swaps `child`, but the previous child's
    // connection can still deliver a queued notification or its close. Both
    // handlers close over the child they were registered for and must no-op
    // when it is no longer the live one, or a dead process gets to wipe the
    // running server's diagnostics and flip its state to `failed`.
    const stale = server as unknown as {
      child: unknown;
      state: string;
      connection: { handleMessage(message: unknown): void; events: EventEmitter };
    };
    const liveChild = stale.child;
    stale.child = { pid: -1 };
    stale.connection.handleMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, version: 99, diagnostics: [] },
    });
    stale.connection.events.emit('close');
    expect(server.getDiagnostics(uri)[0]?.message).toBe('mock diagnostic');
    expect(stale.state).toBe('ready');
    stale.child = liveChild;

    server.notifyDidClose(uri);

    expect(
      await server.definition(
        { textDocument: { uri }, position: { line: 0, character: 0 } },
        5000,
        new AbortController().signal,
      ),
    ).toHaveLength(1);
    expect(
      await server.references(
        {
          textDocument: { uri },
          position: { line: 0, character: 0 },
          context: { includeDeclaration: true },
        },
        5000,
        new AbortController().signal,
      ),
    ).toHaveLength(2);
    expect(
      await server.hover(
        { textDocument: { uri }, position: { line: 0, character: 0 } },
        5000,
        new AbortController().signal,
      ),
    ).toBeTruthy();
    const completion = await server.completion(
      { textDocument: { uri }, position: { line: 0, character: 0 } },
      5000,
      new AbortController().signal,
    );
    expect(Array.isArray(completion) ? completion : completion?.items).toHaveLength(1);
    expect(
      await server.documentSymbol({ textDocument: { uri } }, 5000, new AbortController().signal),
    ).toHaveLength(1);
    expect(
      await server.workspaceSymbol({ query: 'answer' }, 5000, new AbortController().signal),
    ).toHaveLength(1);
    await expect(
      server.prepareRename(
        { textDocument: { uri }, position: { line: 0, character: 0 } },
        5,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: LSPErrorCode.RequestTimeout });
    expect(
      await server.rename(
        { textDocument: { uri }, position: { line: 0, character: 0 }, newName: 'renamed' },
        5000,
        new AbortController().signal,
      ),
    ).toBeTruthy();
    expect(
      await server.codeAction(
        { textDocument: { uri }, range: r(0, 0), context: { diagnostics: [] } },
        5000,
        new AbortController().signal,
      ),
    ).toHaveLength(1);
    expect(
      await server.executeCommand({ command: 'mock.command' }, 5000, new AbortController().signal),
    ).toBeNull();
    expect(await server.pullDiagnostics(uri, 5000, new AbortController().signal)).toHaveLength(1);
    expect(server.textDocumentIdentifier(file)).toEqual({ uri });
    const internal = server as unknown as {
      child: NodeJS.EventEmitter;
      connection: { handleMessage(message: unknown): void };
      state: string;
    };
    internal.connection.handleMessage({
      jsonrpc: '2.0',
      method: 'window/logMessage',
      params: null,
    });
    const child = internal.child;
    child.emit('error', new Error('late transport failure'));
    expect(onCrash).toHaveBeenCalledWith(server);
    internal.connection.handleMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics: [{ message: 'late diagnostic' }] },
    });
    expect(server.getDiagnostics(uri)).toEqual([]);
    // The OS may deliver exit while shutdown is in progress, before the
    // shutdown continuation clears the child. Assert that it is expected.
    const fixtureClosed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    internal.state = 'shutting_down';
    child.emit('exit', null, 'SIGTERM');
    expect(onCrash).toHaveBeenCalledTimes(1);
    // The injected exit exercises the callback, so reap the real fixture too.
    (child as unknown as { kill(): void }).kill();
    await fixtureClosed;
    await server.shutdown();
    await server.shutdown();
  });

  it('handles disabled and startup-failure servers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-server-'));
    const disabled = new LSPServer(
      'off',
      {
        command: process.execPath,
        languages: ['typescript'],
        enabled: false,
      },
      { cwd: root, rootPath: root, log, events: new EventBus() },
    );
    await disabled.start();
    await disabled.shutdown();
    expect(disabled.state).toBe('disabled');

    const failed = new LSPServer(
      'fail',
      {
        command: process.execPath,
        args: ['-e', 'process.stderr.write("boom\\n"); process.exit(42)'],
        languages: ['typescript'],
        startupTimeoutMs: 5000,
      },
      { cwd: root, rootPath: root, log, events: new EventBus() },
    );
    await expect(failed.start()).rejects.toHaveProperty('code');
    expect(failed.lastStderr).toContain('boom');
  });
});

function r(line: number, character: number) {
  return { start: { line, character }, end: { line, character: character + 1 } };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}
