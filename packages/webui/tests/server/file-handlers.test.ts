import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import * as fsSync from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  handleFilesList,
  handleFilesRead,
  handleFilesTree,
  handleFilesWrite,
} from '@wrongstack/webui-server';

// We'll test the actual implementation by creating temp directories
// and checking the output

describe('file handlers integration', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temp directory for testing
    tempDir = path.join(process.env.TEMP || '/tmp', `test-${randomBytes(4).toString('hex')}`);
    fsSync.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      fsSync.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // Helper to create a mock WebSocket
  function createMockWs() {
    const ws = {
      readyState: 1,
      sent: [] as unknown[],
      send(data: string) {
        this.sent.push(JSON.parse(data));
      },
    } as never as WebSocket & { sent: unknown[] };
    return ws;
  }

  describe('handleFilesTree', () => {
    it('builds tree from project root', async () => {
      // Create some test files
      fsSync.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fsSync.writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'export const x = 1;');
      fsSync.writeFileSync(path.join(tempDir, 'package.json'), '{}');

      const ws = createMockWs();

      await handleFilesTree(ws, { type: 'files.tree', payload: {} }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { type: string; payload: { tree: unknown[]; root: string } };
      expect(response.type).toBe('files.tree');
      expect(response.payload.root).toBe(tempDir);
      expect(Array.isArray(response.payload.tree)).toBe(true);
    });

    it('handles path outside projectRoot', async () => {
      const ws = createMockWs();

      await handleFilesTree(ws, { type: 'files.tree', payload: { path: '../outside' } }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { type: string; payload: { error: string } };
      expect(response.payload.error).toBe('Path outside project root');
    });

    it('skips hidden files and directories', async () => {
      // Create hidden files
      fsSync.writeFileSync(path.join(tempDir, '.hidden'), 'hidden');
      fsSync.mkdirSync(path.join(tempDir, '.git'), { recursive: true });
      fsSync.writeFileSync(path.join(tempDir, 'visible.txt'), 'visible');

      const ws = createMockWs();

      await handleFilesTree(ws, { type: 'files.tree', payload: {} }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { tree: unknown[] } };
      const names = (response.payload.tree as { name: string }[]).map((n) => n.name);
      expect(names).not.toContain('.hidden');
      expect(names).toContain('visible.txt');
    });
  });

  describe('handleFilesRead', () => {
    it('reads file content', async () => {
      const testFile = path.join(tempDir, 'test.txt');
      fsSync.writeFileSync(testFile, 'Hello World');

      const ws = createMockWs();

      await handleFilesRead(ws, { type: 'files.read', payload: { filePath: 'test.txt' } }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { type: string; payload: { content: string } };
      expect(response.payload.content).toBe('Hello World');
    });

    it('returns error for path traversal', async () => {
      const ws = createMockWs();

      await handleFilesRead(
        ws,
        { type: 'files.read', payload: { filePath: '../etc/passwd' } },
        tempDir,
      );

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { error: string } };
      expect(response.payload.error).toBe('Forbidden');
    });

    it('returns error for non-existent file', async () => {
      const ws = createMockWs();

      await handleFilesRead(
        ws,
        { type: 'files.read', payload: { filePath: 'nonexistent.txt' } },
        tempDir,
      );

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { error: string } };
      expect(response.payload.error).toBeTruthy();
    });
  });

  describe('handleFilesList', () => {
    it('lists project files', async () => {
      fsSync.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fsSync.writeFileSync(path.join(tempDir, 'src', 'a.ts'), '');
      fsSync.writeFileSync(path.join(tempDir, 'src', 'b.ts'), '');

      const ws = createMockWs();

      await handleFilesList(ws, { type: 'files.list', payload: {} }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { type: string; payload: { files: string[] } };
      expect(response.payload.files).toContain('src/a.ts');
      expect(response.payload.files).toContain('src/b.ts');
    });

    it('respects limit parameter', async () => {
      // Create many files
      for (let i = 0; i < 10; i++) {
        fsSync.writeFileSync(path.join(tempDir, `file${i}.txt`), '');
      }

      const ws = createMockWs();

      await handleFilesList(ws, { type: 'files.list', payload: { limit: 3 } }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { files: string[] } };
      expect(response.payload.files.length).toBeLessThanOrEqual(3);
    });

    it('filters by query (fuzzy search)', async () => {
      fsSync.writeFileSync(path.join(tempDir, 'alpha.ts'), '');
      fsSync.writeFileSync(path.join(tempDir, 'beta.ts'), '');
      fsSync.writeFileSync(path.join(tempDir, 'gamma.ts'), '');

      const ws = createMockWs();

      await handleFilesList(ws, { type: 'files.list', payload: { query: 'al' } }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { files: string[] } };
      // alpha.ts should rank higher than others for 'al' query
      expect(response.payload.files[0]).toBe('alpha.ts');
    });

    it('returns empty for path outside projectRoot', async () => {
      const ws = createMockWs();

      await handleFilesList(ws, { type: 'files.list', payload: { path: '../outside' } }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { files: unknown[] } };
      expect(response.payload.files).toEqual([]);
    });
  });

  describe('handleFilesWrite', () => {
    it('writes file successfully', async () => {
      const ws = createMockWs();
      const onWritten = vi.fn();

      await handleFilesWrite(
        ws,
        { type: 'files.write', payload: { filePath: 'new-file.txt', content: 'test content' } },
        tempDir,
        { onWritten },
      );

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { success: boolean } };
      expect(response.payload.success).toBe(true);

      // Verify file was written
      const content = fsSync.readFileSync(path.join(tempDir, 'new-file.txt'), 'utf8');
      expect(content).toBe('test content');
      expect(onWritten).toHaveBeenCalledWith(path.join(tempDir, 'new-file.txt'));
    });

    it('returns error for path traversal', async () => {
      const ws = createMockWs();

      await handleFilesWrite(
        ws,
        { type: 'files.write', payload: { filePath: '../evil.txt', content: 'hack' } },
        tempDir,
      );

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { success: boolean; error: string } };
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toBe('Forbidden');
    });
  });

  // ── Symlink-escape regression tests (PATH-ESCAPE fix) ────────────
  // These guard against the WS-01 path-escape vulnerability: a handler
  // that does only a string-prefix check on a path.resolve() result
  // will follow an in-project symlink to an external target.
  describe('symlink-escape protection', () => {
    let projectDir: string;
    let outsideDir: string;

    beforeEach(async () => {
      projectDir = path.join(tempDir, 'project');
      outsideDir = path.join(tempDir, 'outside');
      await fsPromises.mkdir(projectDir, { recursive: true });
      await fsPromises.mkdir(outsideDir, { recursive: true });
    });

    // Create a symlink at <linkPath> in `projectDir` that points at
    // `outsideDir`. Skips the test on platforms that disallow symlinks.
    async function makeEscapeLink(name: string): Promise<string | null> {
      const linkPath = path.join(projectDir, name);
      try {
        await fsPromises.symlink(outsideDir, linkPath, 'dir');
        return linkPath;
      } catch (err) {
        if (
          (err as NodeJS.ErrnoException).code === 'EPERM' ||
          (err as NodeJS.ErrnoException).code === 'ENOSYS'
        ) {
          return null;
        }
        throw err;
      }
    }

    it('handleFilesRead refuses to read through an in-project symlink to outside', async () => {
      const link = await makeEscapeLink('outside-link');
      if (!link) return;
      // Place a real file at outsideDir/secret.txt that we must NOT be
      // able to read via the in-project symlink.
      const secret = path.join(outsideDir, 'secret.txt');
      await fsPromises.writeFile(secret, 'TOP SECRET');
      const ws = createMockWs();

      await handleFilesRead(
        ws,
        { type: 'files.read', payload: { filePath: 'outside-link/secret.txt' } },
        projectDir,
      );

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { content?: string; error?: string } };
      // The handler must reject with 'Forbidden', not return the secret.
      expect(response.payload.error).toBe('Forbidden');
      expect(response.payload.content).toBe('');
      // And the secret must not have been leaked via any other code path.
      expect(JSON.stringify(ws.sent)).not.toContain('TOP SECRET');
    });

    it('handleFilesWrite refuses to write through an in-project symlink to outside', async () => {
      const link = await makeEscapeLink('outside-link');
      if (!link) return;
      const ws = createMockWs();

      await handleFilesWrite(
        ws,
        {
          type: 'files.write',
          payload: { filePath: 'outside-link/pwned.txt', content: 'overwritten' },
        },
        projectDir,
      );

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { success: boolean; error?: string } };
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toBe('Forbidden');
      // The file must NOT have been created outside the project root.
      await expect(fsPromises.stat(path.join(outsideDir, 'pwned.txt'))).rejects.toThrow();
    });

    it('handleFilesTree skips in-project symlinked directories that escape the project', async () => {
      const link = await makeEscapeLink('outside-link');
      if (!link) return;
      // Drop a real file under outsideDir that must NOT appear in the tree.
      await fsPromises.writeFile(path.join(outsideDir, 'leaked.txt'), 'leaked');
      const ws = createMockWs();

      await handleFilesTree(ws, { type: 'files.tree', payload: {} }, projectDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as {
        payload: { tree: { name: string; children?: { name: string }[] }[] };
      };
      const names = collectNames(response.payload.tree);
      expect(names).not.toContain('outside-link');
      expect(names).not.toContain('leaked.txt');
    });

    it('handleFilesTree refuses a tree root that is itself a symlink to outside', async () => {
      // The user-supplied tree root is an in-project symlink to outside.
      // This must be rejected at the entry check, not silently followed.
      const link = await makeEscapeLink('outside-link');
      if (!link) return;
      const ws = createMockWs();

      await handleFilesTree(
        ws,
        { type: 'files.tree', payload: { path: 'outside-link' } },
        projectDir,
      );

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { error?: string; tree: unknown[] } };
      expect(response.payload.error).toBe('Path outside project root');
      expect(response.payload.tree).toEqual([]);
    });

    it('handleFilesList skips in-project symlinked directories that escape the project', async () => {
      const link = await makeEscapeLink('outside-link');
      if (!link) return;
      await fsPromises.writeFile(path.join(outsideDir, 'leaked.txt'), 'leaked');
      const ws = createMockWs();

      await handleFilesList(ws, { type: 'files.list', payload: {} }, projectDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { files: string[] } };
      expect(response.payload.files).not.toContain('outside-link/leaked.txt');
    });

    it('handleFilesList refuses a list root that is itself a symlink to outside', async () => {
      const link = await makeEscapeLink('outside-link');
      if (!link) return;
      const ws = createMockWs();

      await handleFilesList(
        ws,
        { type: 'files.list', payload: { path: 'outside-link' } },
        projectDir,
      );

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { files: unknown[] } };
      expect(response.payload.files).toEqual([]);
    });
  });
});

// Recursively collect the `name` field from a tree returned by
// handleFilesTree. Used by the symlink-escape regression tests to
// assert that no leaked filenames surface in the response.
function collectNames(
  tree: { name: string; children?: { name: string; children?: { name: string }[] }[] }[],
): string[] {
  const names: string[] = [];
  for (const node of tree) {
    names.push(node.name);
    if (node.children) names.push(...collectNames(node.children));
  }
  return names;
}
