import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { EventBus, type Logger } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import { DocumentTracker } from '../../src/document-tracker.js';
import { LSPRegistry } from '../../src/registry.js';
import {
  supportsCodeAction,
  supportsDefinition,
  supportsDocumentSymbol,
  supportsHover,
  supportsPrepareRename,
  supportsPullDiagnostics,
  supportsReferences,
  supportsRename,
  supportsWorkspaceSymbol,
} from '../../src/server/capabilities.js';
import { Connection } from '../../src/server/connection.js';
import { canTransition, nextReconnectDelay } from '../../src/server/lifecycle.js';
import { LSPError, LSPErrorCode, type PlugLSPConfig } from '../../src/types.js';
import { promiseWithTimeout } from '../../src/utils/timeout.js';
import { displayPath, pathToUri, uriToPath } from '../../src/utils/uri.js';
import { findWorkspaceRoot } from '../../src/workspace-root.js';

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

const fixtureServer = fileURLToPath(
  new URL('../integration/fixtures/mock-lsp-server.mjs', import.meta.url),
);

describe('runtime helpers', () => {
  it('checks capabilities and lifecycle transitions', () => {
    const cap = {
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      renameProvider: { prepareProvider: true },
      codeActionProvider: true,
      diagnosticProvider: {},
    };
    expect(supportsHover(cap)).toBe(true);
    expect(supportsDefinition(cap)).toBe(true);
    expect(supportsReferences(cap)).toBe(true);
    expect(supportsDocumentSymbol(cap)).toBe(true);
    expect(supportsWorkspaceSymbol(cap)).toBe(true);
    expect(supportsRename(cap)).toBe(true);
    expect(supportsPrepareRename(cap)).toBe(true);
    expect(supportsCodeAction(cap)).toBe(true);
    expect(supportsPullDiagnostics(cap)).toBe(true);
    expect(supportsPrepareRename({ renameProvider: true })).toBe(false);
    expect(canTransition('ready', 'failed')).toBe(true);
    expect(canTransition('ready', 'disabled')).toBe(false);
    expect(canTransition('ready', 'ready')).toBe(true);
    expect(nextReconnectDelay(-1)).toBe(1000);
    expect(nextReconnectDelay(1)).toBe(4000);
    expect(nextReconnectDelay(99)).toBe(16_000);
  });

  it('handles timeout success, timeout, rejection, and abort', async () => {
    await expect(promiseWithTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok');
    await expect(promiseWithTimeout(Promise.reject(new Error('bad')), 50)).rejects.toThrow('bad');
    await expect(promiseWithTimeout(new Promise(() => undefined), 1)).rejects.toMatchObject({
      code: LSPErrorCode.RequestTimeout,
    });
    const aborted = new AbortController();
    aborted.abort(new Error('stop'));
    await expect(promiseWithTimeout(Promise.resolve('x'), 50, aborted.signal)).rejects.toThrow(
      'stop',
    );
    const ctrl = new AbortController();
    const pending = promiseWithTimeout(new Promise(() => undefined), 50, ctrl.signal);
    ctrl.abort();
    await expect(pending).rejects.toThrow('aborted');
  });

  it('resolves workspace roots and URI display paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-root-'));
    const nested = path.join(root, 'a', 'b');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), '{}');
    await fs.writeFile(path.join(root, 'tsconfig.app.json'), '{}');
    const file = path.join(nested, 'x.ts');
    expect(findWorkspaceRoot(file, ['package.json'], os.tmpdir())).toBe(root);
    expect(findWorkspaceRoot(file, ['tsconfig.*.json'], os.tmpdir())).toBe(root);
    expect(findWorkspaceRoot(file, undefined, root)).toBe(path.resolve(root));
    expect(findWorkspaceRoot(file, ['missing'], root)).toBe(path.resolve(root));
    expect(findWorkspaceRoot(path.join(root, 'missing', 'x.ts'), ['*.json'], root)).toBe(
      path.resolve(root),
    );
    expect(displayPath(path.join(root, 'x.ts'), root)).toBe('x.ts');
    expect(displayPath(path.join(os.tmpdir(), 'outside.ts'), root)).toContain('outside.ts');
    expect(uriToPath(pathToUri(file))).toBe(file);
  });

  it('tracks document open, changes, closes, and ignored events', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-docs-'));
    const source = path.join(root, 'a.ts');
    await fs.writeFile(source, 'const a = 1;');
    const opened = vi.fn();
    const changed = vi.fn();
    const closed = vi.fn();
    const server = {
      name: 'ts',
      state: 'ready',
      config: { languages: ['typescript'] },
      notifyDidOpen: opened,
      notifyDidChange: changed,
      notifyDidClose: closed,
    };
    const registry = { list: () => [server] };
    const events = new EventBus();
    const tracker = new DocumentTracker(() => registry as never, log, root, events);
    await tracker.handleToolExecuted({ name: 'read', ok: false, input: { path: source } } as never);
    await tracker.handleToolExecuted({ name: 'other', ok: true, input: { path: source } } as never);
    await tracker.handleToolExecuted({ name: 'read', ok: true, input: {} } as never);
    tracker.setCwd(root);
    await tracker.open(path.join(root, 'README.md'));
    await tracker.fileWritten(path.join(root, 'missing.ts'));
    // #91: a tracked read whose path is missing from the tracker cwd must not
    // crash the process — handleToolExecuted resolves cleanly instead.
    await expect(
      tracker.handleToolExecuted({ name: 'read', ok: true, input: { path: 'missing.ts' } } as never),
    ).resolves.toBeUndefined();
    await tracker.handleToolExecuted({ name: 'read', ok: true, input: { path: 'a.ts' } } as never);
    expect(opened).toHaveBeenCalledOnce();
    const fresh = path.join(root, 'fresh.ts');
    await fs.writeFile(fresh, 'const fresh = 1;');
    await tracker.fileWritten(fresh);
    await fs.writeFile(source, 'const a = 2;');
    await tracker.handleToolExecuted({ name: 'write', ok: true, input: { path: source } } as never);
    expect(changed).toHaveBeenCalledOnce();
    expect(tracker.get(source)?.version).toBe(2);
    await tracker.reopenForServer(server as never);
    await tracker.reopenForServer({ ...server, state: 'failed' } as never);
    await tracker.forceCloseAll();
    expect(closed).toHaveBeenCalledTimes(2);
    expect(tracker.list()).toEqual([]);
  });

  it('keeps registry behavior predictable for missing and disabled servers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-reg-'));
    const tracker = { reopenForServer: vi.fn() };
    const cfg: PlugLSPConfig = {
      servers: {
        disabled: { command: 'missing', languages: ['typescript'], enabled: false },
      },
      autoStart: 'lazy',
      diagnosticsAfterEdit: 'background',
      diagnosticsWaitMs: 1,
      severityFilter: ['error'],
      maxDiagnosticsPerFile: 1,
      maxDiagnosticsTotal: 1,
      autoDiscover: false,
      logServerOutput: false,
    };
    const registry = new LSPRegistry(cfg, tracker as never, {
      cwd: root,
      log,
      events: new EventBus(),
    });
    await registry.bind(root, 'lazy');
    expect(registry.list()).toEqual([]);
    await expect(registry.start('missing')).rejects.toMatchObject({
      code: LSPErrorCode.ServerNotFound,
    });
    expect(await registry.findForPath(path.join(root, 'readme.md'))).toBeNull();
    await registry.shutdown();
  });

  it('starts, stops, restarts, and eagerly detects registry servers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-reg-'));
    await fs.writeFile(path.join(root, 'package.json'), '{}');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    const source = path.join(root, 'src', 'a.ts');
    await fs.writeFile(source, 'const answer = 1;');
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'ignored.ts'), 'const ignored = 1;');
    const tracker = { reopenForServer: vi.fn(async () => undefined) };
    const warn = vi.fn();
    const duplicateCfg: PlugLSPConfig = {
      servers: {
        one: {
          command: process.execPath,
          args: [fixtureServer],
          languages: ['typescript'],
          rootPatterns: ['package.json'],
          startupTimeoutMs: 5000,
        },
        two: {
          command: process.execPath,
          args: [fixtureServer],
          languages: ['typescript'],
          rootPatterns: ['package.json'],
          startupTimeoutMs: 5000,
        },
      },
      autoStart: 'lazy',
      diagnosticsAfterEdit: 'background',
      diagnosticsWaitMs: 1,
      severityFilter: ['error'],
      maxDiagnosticsPerFile: 1,
      maxDiagnosticsTotal: 1,
      autoDiscover: false,
      logServerOutput: false,
    };
    const duplicateRegistry = new LSPRegistry(duplicateCfg, tracker as never, {
      cwd: root,
      log: { ...log, warn },
      events: new EventBus(),
    });
    await duplicateRegistry.bind(root, 'lazy');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('claimed by multiple servers'));
    expect(duplicateRegistry.list()).toHaveLength(2);
    await duplicateRegistry.shutdown();

    const cfg: PlugLSPConfig = {
      ...duplicateCfg,
      servers: {
        one: {
          command: process.execPath,
          args: [fixtureServer],
          languages: ['typescript'],
          rootPatterns: ['package.json'],
          startupTimeoutMs: 5000,
        },
      },
    };
    const registry = new LSPRegistry(cfg, tracker as never, {
      cwd: root,
      log,
      events: new EventBus(),
    });
    await registry.bind(root, 'eager');
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('one')?.rootPath).toBe(root);
    expect(await registry.findForPath(source, new AbortController().signal)).toBeTruthy();
    await registry.shutdown();
  });
});

describe('Connection', () => {
  it('round-trips requests, notifications, errors, malformed output, and close state', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new Connection(stdin, stdout);
    const writes: string[] = [];
    stdin.on('data', (chunk) => writes.push(chunk.toString('utf8')));
    const seen = vi.fn();
    const off = conn.onNotification('server/notice', seen);
    conn.sendNotification('client/notice', { ok: true });
    expect(writes.join('')).toContain('client/notice');

    const req = conn.sendRequest('method', { a: 1 }, 50, new AbortController().signal);
    stdout.write(frame({ jsonrpc: '2.0', method: 'server/notice', params: { x: 1 } }));
    stdout.write('bad\r\n\r\n');
    stdout.write(frame({ jsonrpc: '2.0', id: 99, result: 'ignored' }));
    stdout.write(frame({ jsonrpc: '2.0', id: 1, result: 'ok' }));
    await expect(req).resolves.toBe('ok');
    expect(seen).toHaveBeenCalledWith({ x: 1 });
    off();

    const errReq = conn.sendRequest('bad', null, 50, new AbortController().signal);
    stdout.write(frame({ jsonrpc: '2.0', id: 2, error: { code: -1, message: 'nope' } }));
    await expect(errReq).rejects.toMatchObject({ code: LSPErrorCode.ProtocolError });

    const ctrl = new AbortController();
    const abortReq = conn.sendRequest('slow', null, 50, ctrl.signal);
    ctrl.abort();
    await expect(abortReq).rejects.toThrow('aborted');
    expect(writes.join('')).toContain('$/cancelRequest');

    const closeSpy = vi.fn();
    conn.onClose(closeSpy);
    conn.close();
    conn.close();
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(() => conn.sendNotification('x', null)).toThrow(LSPError);
  });
});

function frame(message: object): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}
