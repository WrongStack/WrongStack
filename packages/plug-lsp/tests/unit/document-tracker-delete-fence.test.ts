import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { DocumentTracker } from '../../src/document-tracker.js';
import type { LSPServer } from '../../src/server/lsp-server.js';

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('DocumentTracker delete fencing (F1826)', () => {
  it('fences in-flight open and fileWritten reads when workspace materialization deletes the file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-delete-fence-'));
    try {
      const deletedFile = path.join(dir, 'deleted.ts');
      const rewrittenFile = path.join(dir, 'rewritten.ts');
      await fs.writeFile(deletedFile, 'export const stale = 1;\n', 'utf8');
      await fs.writeFile(rewrittenFile, 'export const stale2 = 2;\n', 'utf8');

      const openedUris: string[] = [];
      const fakeServer = {
        name: 'ts-server',
        state: 'ready',
        config: { languages: ['typescript'] },
        hasOpenDocument: () => false,
        notifyDidOpen: (doc: { uri: string }) => {
          openedUris.push(doc.uri);
        },
        notifyDidChange: () => {},
        notifyDidClose: () => {},
        notifyDidChangeWatchedFiles: () => {},
      } as unknown as LSPServer;

      const tracker = new DocumentTracker(() => ({ list: () => [fakeServer] }), noopLog, dir);

      const openPromise = tracker.open(deletedFile);
      await tracker.handleWorkspaceFilesMaterialized({
        deletedFiles: [deletedFile],
        writtenFiles: [],
        targetRoot: dir,
      });

      expect(await openPromise).toBe(false);
      expect(tracker.get(deletedFile)).toBeNull();
      expect(openedUris).toHaveLength(0);

      // Fresh open after recreation succeeds.
      expect(await tracker.open(deletedFile)).toBe(true);
      expect(tracker.get(deletedFile)).not.toBeNull();

      openedUris.length = 0;
      const writePromise = tracker.fileWritten(rewrittenFile);
      await tracker.handleWorkspaceFilesMaterialized({
        deletedFiles: [rewrittenFile],
        writtenFiles: [],
        targetRoot: dir,
      });
      await writePromise;

      expect(tracker.get(rewrittenFile)).toBeNull();
      expect(openedUris).toHaveLength(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
