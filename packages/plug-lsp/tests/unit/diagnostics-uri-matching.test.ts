import { describe, expect, it, vi } from 'vitest';
import { LSPServer } from '../../src/server/lsp-server.js';
import { pathToUri, uriKey } from '../../src/utils/uri.js';

const WIN = process.platform === 'win32';

describe('uriKey', () => {
  it('folds Windows spellings together but never POSIX ones', () => {
    // typescript-language-server answers a didOpen for file:///C:/... with
    // diagnostics for file:///c%3A/... — the raw strings never compare equal.
    expect(uriKey('file:///C:/dir/index.ts', 'win32')).toBe(
      uriKey('file:///c%3A/dir/index.ts', 'win32'),
    );
    expect(uriKey('file:///C:/dir/index.ts', 'win32')).toBe(
      uriKey('file:///C:/DIR/Index.ts', 'win32'),
    );
    // POSIX paths are case-sensitive and must not be folded. (The URI shape
    // stays Windows-parsable so this runs on both CI platforms; only the
    // case-folding differs between the two arms.)
    expect(uriKey('file:///C:/dir/index.ts', 'linux')).not.toBe(
      uriKey('file:///C:/dir/Index.ts', 'linux'),
    );
    expect(uriKey('file:///C:/dir/index.ts', 'linux')).not.toBe(
      uriKey('file:///C:/dir/index.ts', 'win32'),
    );
  });

  it('passes through anything it cannot turn into a path', () => {
    expect(uriKey('untitled:Untitled-1')).toBe('untitled:Untitled-1');
    expect(uriKey('file://')).toBe('file://');
  });

  it('uses the running platform by default', () => {
    expect(uriKey('file:///dir/index.ts')).toBe(uriKey('file:///dir/index.ts', process.platform));
  });
});

describe('LSPServer.waitForDiagnostics', () => {
  const makeServer = (): LSPServer =>
    new LSPServer(
      'fake',
      { command: 'noop', languages: ['typescript'] },
      {
        cwd: process.cwd(),
        rootPath: process.cwd(),
        log: {
          debug() {},
          info() {},
          warn() {},
          error() {},
          trace() {},
          level: 'error',
          child() {
            return this;
          },
        } as never,
        events: { emit() {}, on: () => () => {} } as never,
      },
    );

  const publish = (server: LSPServer, uri: string, message: string): void => {
    (server as unknown as { setDiagnostics(uri: string, d: unknown[]): void }).setDiagnostics(uri, [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message },
    ]);
  };

  it('resolves when the server publishes for a differently-spelled URI', async () => {
    const server = makeServer();
    server.state = 'ready';
    const file = WIN ? 'C:' + '\\' + 'dir' + '\\' + 'index.ts' : '/dir/index.ts';
    const ours = pathToUri(file);
    const pending = server.waitForDiagnostics(ours, 5_000);
    publish(server, WIN ? 'file:///c%3A/dir/index.ts' : ours, 'boom');
    await expect(pending).resolves.toEqual([expect.objectContaining({ message: 'boom' })]);
  });

  it('returns the buffer immediately once a publish has landed', async () => {
    const server = makeServer();
    server.state = 'ready';
    const ours = pathToUri(WIN ? 'C:' + '\\' + 'dir' + '\\' + 'a.ts' : '/dir/a.ts');
    publish(server, ours, 'first');
    // No timers involved: a fresh buffer short-circuits the wait entirely.
    await expect(server.waitForDiagnostics(ours, 60_000)).resolves.toHaveLength(1);
  });

  it('gives up quietly when the server stays silent', async () => {
    const server = makeServer();
    server.state = 'ready';
    const ours = pathToUri(WIN ? 'C:' + '\\' + 'dir' + '\\' + 'b.ts' : '/dir/b.ts');
    await expect(server.waitForDiagnostics(ours, 10)).resolves.toEqual([]);
  });

  it('does not wait when the server is not ready or the budget is zero', async () => {
    const server = makeServer();
    const ours = pathToUri(WIN ? 'C:' + '\\' + 'dir' + '\\' + 'c.ts' : '/dir/c.ts');
    await expect(server.waitForDiagnostics(ours, 60_000)).resolves.toEqual([]);
    server.state = 'ready';
    await expect(server.waitForDiagnostics(ours, 0)).resolves.toEqual([]);
  });

  it('stops waiting when the caller aborts', async () => {
    const server = makeServer();
    server.state = 'ready';
    const ac = new AbortController();
    const ours = pathToUri(WIN ? 'C:' + '\\' + 'dir' + '\\' + 'd.ts' : '/dir/d.ts');
    const pending = server.waitForDiagnostics(ours, 60_000, ac.signal);
    ac.abort();
    await expect(pending).resolves.toEqual([]);
  });

  it('re-arms the wait after the document changes', async () => {
    const server = makeServer();
    server.state = 'ready';
    const file = WIN ? 'C:' + '\\' + 'dir' + '\\' + 'e.ts' : '/dir/e.ts';
    const ours = pathToUri(file);
    publish(server, ours, 'stale');
    server.notifyDidChange({ uri: ours, version: 2 }, 'x');
    // The buffered entry is stale now, so the next read must wait again.
    await expect(server.waitForDiagnostics(ours, 10)).resolves.toEqual([
      expect.objectContaining({ message: 'stale' }),
    ]);
    const fresh = server.waitForDiagnostics(ours, 5_000);
    publish(server, ours, 'fresh');
    await expect(fresh).resolves.toEqual([expect.objectContaining({ message: 'fresh' })]);
  });
});

describe('client capabilities', () => {
  it('asks for push diagnostics', async () => {
    const { initializeServer } = await import('../../src/server/initialize.js');
    let sent: Record<string, unknown> | undefined;
    const connection = {
      sendRequest: vi.fn(async (_method: string, params: unknown) => {
        sent = params as Record<string, unknown>;
        return { capabilities: {} };
      }),
      sendNotification: vi.fn(),
    };
    await initializeServer(
      connection as never,
      { command: 'noop', languages: ['typescript'] },
      process.cwd(),
      1_000,
      new AbortController().signal,
    );
    // Push-only servers stay silent unless the client declares this.
    const caps = sent?.['capabilities'] as { textDocument?: Record<string, unknown> };
    expect(caps.textDocument?.['publishDiagnostics']).toBeDefined();
  });
});
