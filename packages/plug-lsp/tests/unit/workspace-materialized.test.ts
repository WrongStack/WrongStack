import * as path from 'node:path';
import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => ({ stat: vi.fn(), readFile: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  ...files,
}));

import { DocumentTracker } from '../../src/document-tracker.js';
import { LSPServer } from '../../src/server/lsp-server.js';
import { pathToUri, uriKey } from '../../src/utils/uri.js';

describe('DocumentTracker & LSPServer workspace.files_materialized sync', () => {
  const cwd = process.cwd();
  const fileContents = new Map<string, string>();

  beforeEach(() => {
    fileContents.clear();
    files.stat.mockReset().mockImplementation(async (target: string) => {
      const normalized = path.normalize(target);
      const body = fileContents.get(normalized);
      if (body === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return { isFile: () => true, size: Buffer.byteLength(body, 'utf8') };
    });
    files.readFile.mockReset().mockImplementation(async (target: string) => {
      const normalized = path.normalize(target);
      const body = fileContents.get(normalized);
      if (body === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return body;
    });
  });

  it('refreshes open restored documents via didChange, evicts deleted documents via didClose, and broadcasts workspace/didChangeWatchedFiles', async () => {
    const keptAbs = path.resolve(cwd, 'src/kept.ts');
    const untrackedRestoredAbs = path.resolve(cwd, 'src/unopened.ts');
    const deletedAbs = path.resolve(cwd, 'src/removed.ts');

    fileContents.set(keptAbs, 'export const v = 1;\n');
    fileContents.set(deletedAbs, 'export const gone = true;\n');

    const mockServer = {
      name: 'tsserver',
      state: 'ready' as const,
      config: { command: 'tsserver', languages: ['typescript'] },
      hasOpenDocument: vi.fn(() => true),
      notifyDidOpen: vi.fn(),
      notifyDidChange: vi.fn(),
      notifyDidClose: vi.fn(),
      notifyDidChangeWatchedFiles: vi.fn(),
    } as unknown as LSPServer;

    const tracker = new DocumentTracker(
      () => ({ list: () => [mockServer] }),
      { debug: vi.fn() } as unknown as Logger,
      cwd,
    );

    expect(await tracker.open('src/kept.ts')).toBe(true);
    expect(await tracker.open('src/removed.ts')).toBe(true);
    expect(mockServer.notifyDidOpen).toHaveBeenCalledTimes(2);

    // Simulate CAS materialization on `/tree switch`: kept.ts changes content,
    // unopened.ts is restored without having been opened, removed.ts is deleted.
    fileContents.set(keptAbs, 'export const v = 2;\n');
    fileContents.set(untrackedRestoredAbs, 'export const extra = 42;\n');
    fileContents.delete(deletedAbs);

    await tracker.handleWorkspaceFilesMaterialized({
      targetRoot: cwd,
      writtenFiles: ['src/kept.ts', 'src/unopened.ts'],
      deletedFiles: ['src/removed.ts'],
    });

    expect(mockServer.notifyDidClose).toHaveBeenCalledWith(pathToUri(deletedAbs));
    expect(tracker.get('src/removed.ts')).toBeNull();

    expect(mockServer.notifyDidChange).toHaveBeenCalledWith(
      { uri: pathToUri(keptAbs), version: 2 },
      'export const v = 2;\n',
    );
    expect(tracker.get('src/kept.ts')?.text).toBe('export const v = 2;\n');
    // Unopened restored file is notified via workspace/didChangeWatchedFiles without eagerly opening it in RAM
    expect(tracker.get('src/unopened.ts')).toBeNull();

    expect(mockServer.notifyDidChangeWatchedFiles).toHaveBeenCalledTimes(1);
    expect(mockServer.notifyDidChangeWatchedFiles).toHaveBeenCalledWith([
      { uri: pathToUri(deletedAbs), type: 3 },
      { uri: pathToUri(keptAbs), type: 2 },
      { uri: pathToUri(untrackedRestoredAbs), type: 2 },
    ]);
  });

  it('invalidates cached diagnostics on LSPServer.notifyDidChangeWatchedFiles and drops deleted file entries', () => {
    const server = new LSPServer(
      'ts',
      { command: 'tsserver', languages: ['typescript'] },
      {
        cwd,
        rootPath: cwd,
        log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger,
        events: { emit: vi.fn() } as unknown as EventBus,
      },
    );
    const sendNotification = vi.fn();
    (server as unknown as { state: string }).state = 'ready';
    (
      server as unknown as { connection: { sendNotification: typeof sendNotification } }
    ).connection = { sendNotification };

    const changedUri = pathToUri(path.resolve(cwd, 'src/a.ts'));
    const deletedUri = pathToUri(path.resolve(cwd, 'src/b.ts'));
    server.diagnostics.set(uriKey(changedUri), [{ message: 'old err' } as never]);
    server.diagnostics.set(uriKey(deletedUri), [{ message: 'deleted err' } as never]);

    server.notifyDidChangeWatchedFiles([
      { uri: changedUri, type: 2 },
      { uri: deletedUri, type: 3 },
    ]);

    expect(server.diagnostics.has(uriKey(deletedUri))).toBe(false);
    expect(sendNotification).toHaveBeenCalledWith('workspace/didChangeWatchedFiles', {
      changes: [
        { uri: changedUri, type: 2 },
        { uri: deletedUri, type: 3 },
      ],
    });
  });
});
