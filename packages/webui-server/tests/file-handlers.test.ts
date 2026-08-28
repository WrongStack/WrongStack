import { randomBytes } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {
  handleFilesCreate,
  handleFilesDelete,
  handleFilesList,
  handleFilesMove,
  handleFilesRead,
  handleFilesRename,
  handleFilesSkeleton,
  handleFilesTree,
  handleFilesWrite,
} from '@wrongstack/webui-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

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

    it('echoes sessionId on read responses', async () => {
      fsSync.writeFileSync(path.join(tempDir, 'test.txt'), 'Hello World');
      const ws = createMockWs();

      await handleFilesRead(
        ws,
        { type: 'files.read', payload: { filePath: 'test.txt', sessionId: 'sess-files' } },
        tempDir,
      );

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { sessionId?: string } };
      expect(response.payload.sessionId).toBe('sess-files');
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

    it('flags binary files instead of returning content', async () => {
      const testFile = path.join(tempDir, 'logo.png');
      fsSync.writeFileSync(testFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a]));

      const ws = createMockWs();

      await handleFilesRead(ws, { type: 'files.read', payload: { filePath: 'logo.png' } }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as {
        payload: { content: string; binary?: boolean; tooLarge?: boolean };
      };
      expect(response.payload.binary).toBe(true);
      expect(response.payload.tooLarge).toBeUndefined();
      expect(response.payload.content).toBe('');
    });

    it('flags oversized files instead of reading them', async () => {
      const testFile = path.join(tempDir, 'big.txt');
      // 3 MB of text — over the 2 MB MAX_READ_BYTES cap; never read to the client.
      fsSync.writeFileSync(testFile, 'a'.repeat(3 * 1024 * 1024));

      const ws = createMockWs();

      await handleFilesRead(ws, { type: 'files.read', payload: { filePath: 'big.txt' } }, tempDir);

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as {
        payload: { content: string; binary?: boolean; tooLarge?: boolean };
      };
      expect(response.payload.tooLarge).toBe(true);
      expect(response.payload.binary).toBeUndefined();
      expect(response.payload.content).toBe('');
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
      // onWritten receives the realpath'd resolved path, which may differ
      // from path.join on platforms with symlinked temp dirs (e.g. macOS).
      // Verify it was called once with a path ending in the filename.
      expect(onWritten).toHaveBeenCalledTimes(1);
      const calledPath = onWritten.mock.calls[0]![0] as string;
      expect(calledPath).toMatch(/[\\/]new-file\.txt$/);
    });

    it('echoes sessionId on write responses', async () => {
      const ws = createMockWs();

      await handleFilesWrite(
        ws,
        {
          type: 'files.write',
          payload: { filePath: 'new-file.txt', content: 'test content', sessionId: 'sess-files' },
        },
        tempDir,
      );

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { success: boolean; sessionId?: string } };
      expect(response.payload.success).toBe(true);
      expect(response.payload.sessionId).toBe('sess-files');
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

    // Create a file-type symlink at <projectDir>/<name> pointing at
    // `targetFile`. Unlike `makeEscapeLink` (directory symlinks), this
    // exercises the final path component: resolveFileInsideProject
    // realpaths only the parent directory, so a file-level link is caught
    // only if the implementation also canonicalizes the last component.
    // Skips on platforms that disallow file symlinks.
    async function makeEscapeFileLink(name: string, targetFile: string): Promise<string | null> {
      const linkPath = path.join(projectDir, name);
      try {
        await fsPromises.symlink(targetFile, linkPath, 'file');
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

    it('handleFilesRead refuses to read through a file-level symlink to outside', async () => {
      // A file symlink (not a directory symlink) at the FINAL path
      // component. The parent-directory realpath stays inside the project,
      // so only a final-component lstat/realpath catches this escape.
      const secret = path.join(outsideDir, 'secret.txt');
      await fsPromises.writeFile(secret, 'TOP SECRET');
      const link = await makeEscapeFileLink('evil-link.txt', secret);
      if (!link) return;
      const ws = createMockWs();

      await handleFilesRead(
        ws,
        { type: 'files.read', payload: { filePath: 'evil-link.txt' } },
        projectDir,
      );

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { content?: string; error?: string } };
      expect(response.payload.error).toBe('Forbidden');
      expect(response.payload.content).toBe('');
      expect(JSON.stringify(ws.sent)).not.toContain('TOP SECRET');
    });

    it('handleFilesWrite refuses to write through a file-level symlink to outside', async () => {
      const target = path.join(outsideDir, 'target.txt');
      await fsPromises.writeFile(target, 'original');
      const link = await makeEscapeFileLink('evil-link.txt', target);
      if (!link) return;
      const ws = createMockWs();

      await handleFilesWrite(
        ws,
        { type: 'files.write', payload: { filePath: 'evil-link.txt', content: 'overwritten' } },
        projectDir,
      );

      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { success: boolean; error?: string } };
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toBe('Forbidden');
      // The external file must NOT have been clobbered through the link.
      const content = await fsPromises.readFile(target, 'utf8');
      expect(content).toBe('original');
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

  describe('handleFilesCreate', () => {
    it('creates a new file successfully', async () => {
      const ws = createMockWs();
      await handleFilesCreate(
        ws,
        { type: 'files.create', payload: { filePath: 'new-file.ts', type: 'file' } },
        tempDir,
      );
      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as {
        type: string;
        payload: { filePath: string; success: boolean; error?: string };
      };
      expect(response.type).toBe('files.created');
      expect(response.payload.success).toBe(true);
      expect(response.payload.filePath).toBe('new-file.ts');
      expect(fsSync.existsSync(path.join(tempDir, 'new-file.ts'))).toBe(true);
    });

    it('creates a new directory successfully', async () => {
      const ws = createMockWs();
      await handleFilesCreate(
        ws,
        { type: 'files.create', payload: { filePath: 'new-dir', type: 'directory' } },
        tempDir,
      );
      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as {
        type: string;
        payload: { success: boolean };
      };
      expect(response.type).toBe('files.created');
      expect(response.payload.success).toBe(true);
      expect(fsSync.existsSync(path.join(tempDir, 'new-dir'))).toBe(true);
      expect(fsSync.statSync(path.join(tempDir, 'new-dir')).isDirectory()).toBe(true);
    });

    it('rejects path traversal attempts', async () => {
      const ws = createMockWs();
      await handleFilesCreate(
        ws,
        { type: 'files.create', payload: { filePath: '../../../etc/evil', type: 'file' } },
        tempDir,
      );
      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as {
        payload: { success: boolean; error?: string };
      };
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toBe('Forbidden');
    });

    it('rejects creation when file already exists', async () => {
      fsSync.writeFileSync(path.join(tempDir, 'existing.ts'), 'content');
      const ws = createMockWs();
      await handleFilesCreate(
        ws,
        { type: 'files.create', payload: { filePath: 'existing.ts', type: 'file' } },
        tempDir,
      );
      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as {
        payload: { success: boolean; error?: string };
      };
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toMatch(/already exists/);
    });

    it('rejects malformed requests', async () => {
      const ws = createMockWs();
      await handleFilesCreate(ws, { type: 'files.create', payload: {} }, tempDir);
      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as {
        payload: { success: boolean; error?: string };
      };
      expect(response.payload.success).toBe(false);
      // Empty payload passes validatedPayload but fails type validation
      // (type is undefined, not 'file' or 'directory').
      expect(response.payload.error).toBeDefined();
    });

    it('creates parent directories when needed', async () => {
      const ws = createMockWs();
      await handleFilesCreate(
        ws,
        {
          type: 'files.create',
          payload: { filePath: 'deep/nested/path/file.ts', type: 'file' },
        },
        tempDir,
      );
      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { success: boolean } };
      expect(response.payload.success).toBe(true);
      expect(fsSync.existsSync(path.join(tempDir, 'deep/nested/path/file.ts'))).toBe(true);
    });
  });

  describe('handleFilesDelete', () => {
    it('deletes a file successfully', async () => {
      fsSync.writeFileSync(path.join(tempDir, 'to-delete.ts'), 'content');
      const ws = createMockWs();
      await handleFilesDelete(
        ws,
        { type: 'files.delete', payload: { filePath: 'to-delete.ts' } },
        tempDir,
      );
      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as {
        type: string;
        payload: { filePath: string; success: boolean };
      };
      expect(response.type).toBe('files.deleted');
      expect(response.payload.success).toBe(true);
      expect(fsSync.existsSync(path.join(tempDir, 'to-delete.ts'))).toBe(false);
    });

    it('deletes a directory with recursive flag', async () => {
      fsSync.mkdirSync(path.join(tempDir, 'dir-to-delete', 'sub'), { recursive: true });
      fsSync.writeFileSync(path.join(tempDir, 'dir-to-delete', 'sub', 'file.ts'), 'x');
      const ws = createMockWs();
      await handleFilesDelete(
        ws,
        {
          type: 'files.delete',
          payload: { filePath: 'dir-to-delete', recursive: true },
        },
        tempDir,
      );
      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as { payload: { success: boolean } };
      expect(response.payload.success).toBe(true);
      expect(fsSync.existsSync(path.join(tempDir, 'dir-to-delete'))).toBe(false);
    });

    it('rejects path traversal attempts', async () => {
      const ws = createMockWs();
      await handleFilesDelete(
        ws,
        { type: 'files.delete', payload: { filePath: '../../../etc/passwd' } },
        tempDir,
      );
      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as {
        payload: { success: boolean; error?: string };
      };
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toBe('Forbidden');
    });

    it('guards against project root deletion', async () => {
      const ws = createMockWs();
      // Send filePath as "." which resolves to projectRoot
      await handleFilesDelete(
        ws,
        { type: 'files.delete', payload: { filePath: '.', recursive: true } },
        tempDir,
      );
      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as {
        payload: { success: boolean; error?: string };
      };
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toMatch(/project root/i);
      // Verify the directory still exists
      expect(fsSync.existsSync(tempDir)).toBe(true);
    });

    it('rejects malformed requests', async () => {
      const ws = createMockWs();
      await handleFilesDelete(ws, { type: 'files.delete', payload: {} }, tempDir);
      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as {
        payload: { success: boolean; error?: string };
      };
      expect(response.payload.success).toBe(false);
      // Empty payload passes validatedPayload (it is an object) but
      // filePath is undefined, which fails the containment check.
      expect(response.payload.error).toBeDefined();
    });

    it('returns error for non-existent file', async () => {
      const ws = createMockWs();
      await handleFilesDelete(
        ws,
        { type: 'files.delete', payload: { filePath: 'no-such-file.ts' } },
        tempDir,
      );
      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as {
        payload: { success: boolean; error?: string };
      };
      expect(response.payload.success).toBe(false);
    });
  });

  describe('handleFilesRename', () => {
    it('renames a file successfully', async () => {
      fsSync.writeFileSync(path.join(tempDir, 'old-name.ts'), 'content');
      const ws = createMockWs();
      await handleFilesRename(
        ws,
        {
          type: 'files.rename',
          payload: { oldPath: 'old-name.ts', newPath: 'new-name.ts' },
        },
        tempDir,
      );
      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as {
        type: string;
        payload: { oldPath: string; newPath: string; success: boolean };
      };
      expect(response.type).toBe('files.renamed');
      expect(response.payload.success).toBe(true);
      expect(fsSync.existsSync(path.join(tempDir, 'old-name.ts'))).toBe(false);
      expect(fsSync.existsSync(path.join(tempDir, 'new-name.ts'))).toBe(true);
    });

    it('renames a directory successfully', async () => {
      fsSync.mkdirSync(path.join(tempDir, 'old-dir'), { recursive: true });
      fsSync.writeFileSync(path.join(tempDir, 'old-dir', 'file.ts'), 'x');
      const ws = createMockWs();
      await handleFilesRename(
        ws,
        {
          type: 'files.rename',
          payload: { oldPath: 'old-dir', newPath: 'new-dir' },
        },
        tempDir,
      );
      const response = ws.sent[0] as { payload: { success: boolean } };
      expect(response.payload.success).toBe(true);
      expect(fsSync.existsSync(path.join(tempDir, 'old-dir'))).toBe(false);
      expect(fsSync.existsSync(path.join(tempDir, 'new-dir', 'file.ts'))).toBe(true);
    });

    it('rejects path traversal on source', async () => {
      const ws = createMockWs();
      await handleFilesRename(
        ws,
        {
          type: 'files.rename',
          payload: { oldPath: '../../../etc/passwd', newPath: 'stolen.txt' },
        },
        tempDir,
      );
      const response = ws.sent[0] as {
        payload: { success: boolean; error?: string };
      };
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toBe('Forbidden');
    });

    it('rejects path traversal on destination', async () => {
      fsSync.writeFileSync(path.join(tempDir, 'src.ts'), 'x');
      const ws = createMockWs();
      await handleFilesRename(
        ws,
        {
          type: 'files.rename',
          payload: { oldPath: 'src.ts', newPath: '../../../etc/evil.txt' },
        },
        tempDir,
      );
      const response = ws.sent[0] as {
        payload: { success: boolean; error?: string };
      };
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toBe('Forbidden');
    });

    it('rejects when destination already exists', async () => {
      fsSync.writeFileSync(path.join(tempDir, 'src.ts'), 'a');
      fsSync.writeFileSync(path.join(tempDir, 'dst.ts'), 'b');
      const ws = createMockWs();
      await handleFilesRename(
        ws,
        {
          type: 'files.rename',
          payload: { oldPath: 'src.ts', newPath: 'dst.ts' },
        },
        tempDir,
      );
      const response = ws.sent[0] as {
        payload: { success: boolean; error?: string };
      };
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toMatch(/already exists/);
    });

    it('guards against renaming the project root', async () => {
      const ws = createMockWs();
      await handleFilesRename(
        ws,
        {
          type: 'files.rename',
          payload: { oldPath: '.', newPath: 'renamed-root' },
        },
        tempDir,
      );
      const response = ws.sent[0] as {
        payload: { success: boolean; error?: string };
      };
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toMatch(/project root/i);
    });

    it('rejects when source does not exist', async () => {
      const ws = createMockWs();
      await handleFilesRename(
        ws,
        {
          type: 'files.rename',
          payload: { oldPath: 'nonexistent.ts', newPath: 'target.ts' },
        },
        tempDir,
      );
      const response = ws.sent[0] as {
        payload: { success: boolean; error?: string };
      };
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toMatch(/does not exist/);
    });

    it('creates parent directories at the destination', async () => {
      fsSync.writeFileSync(path.join(tempDir, 'move-me.ts'), 'x');
      const ws = createMockWs();
      await handleFilesRename(
        ws,
        {
          type: 'files.rename',
          payload: { oldPath: 'move-me.ts', newPath: 'nested/deep/moved.ts' },
        },
        tempDir,
      );
      const response = ws.sent[0] as { payload: { success: boolean } };
      expect(response.payload.success).toBe(true);
      expect(fsSync.existsSync(path.join(tempDir, 'nested/deep/moved.ts'))).toBe(true);
    });
  });

  describe('handleFilesMove', () => {
    it('moves a file into a directory successfully', async () => {
      fsSync.writeFileSync(path.join(tempDir, 'file.ts'), 'content');
      fsSync.mkdirSync(path.join(tempDir, 'target-dir'));
      const ws = createMockWs();
      await handleFilesMove(
        ws,
        {
          type: 'files.move',
          payload: { srcPath: 'file.ts', destDir: 'target-dir' },
        },
        tempDir,
      );
      expect(ws.sent).toHaveLength(1);
      const response = ws.sent[0] as {
        type: string;
        payload: { srcPath: string; destPath: string; success: boolean };
      };
      expect(response.type).toBe('files.moved');
      expect(response.payload.success).toBe(true);
      expect(response.payload.destPath).toBe('target-dir/file.ts');
      expect(fsSync.existsSync(path.join(tempDir, 'file.ts'))).toBe(false);
      expect(fsSync.existsSync(path.join(tempDir, 'target-dir', 'file.ts'))).toBe(true);
    });

    it('moves a directory into another directory', async () => {
      fsSync.mkdirSync(path.join(tempDir, 'src-dir', 'sub'), { recursive: true });
      fsSync.writeFileSync(path.join(tempDir, 'src-dir', 'sub', 'f.ts'), 'x');
      fsSync.mkdirSync(path.join(tempDir, 'dest-dir'));
      const ws = createMockWs();
      await handleFilesMove(
        ws,
        {
          type: 'files.move',
          payload: { srcPath: 'src-dir', destDir: 'dest-dir' },
        },
        tempDir,
      );
      const response = ws.sent[0] as { payload: { success: boolean } };
      expect(response.payload.success).toBe(true);
      expect(fsSync.existsSync(path.join(tempDir, 'src-dir'))).toBe(false);
      expect(fsSync.existsSync(path.join(tempDir, 'dest-dir', 'src-dir', 'sub', 'f.ts'))).toBe(
        true,
      );
    });

    it('rejects path traversal on source', async () => {
      const ws = createMockWs();
      await handleFilesMove(
        ws,
        {
          type: 'files.move',
          payload: { srcPath: '../../../etc/passwd', destDir: 'dest' },
        },
        tempDir,
      );
      const response = ws.sent[0] as {
        payload: { success: boolean; error?: string };
      };
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toBe('Forbidden');
    });

    it('rejects path traversal on destination', async () => {
      fsSync.writeFileSync(path.join(tempDir, 'file.ts'), 'x');
      const ws = createMockWs();
      await handleFilesMove(
        ws,
        {
          type: 'files.move',
          payload: { srcPath: 'file.ts', destDir: '../../../etc' },
        },
        tempDir,
      );
      const response = ws.sent[0] as {
        payload: { success: boolean; error?: string };
      };
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toBe('Forbidden');
    });

    it('rejects when destination is not a directory', async () => {
      fsSync.writeFileSync(path.join(tempDir, 'file.ts'), 'x');
      fsSync.writeFileSync(path.join(tempDir, 'not-a-dir'), 'y');
      const ws = createMockWs();
      await handleFilesMove(
        ws,
        {
          type: 'files.move',
          payload: { srcPath: 'file.ts', destDir: 'not-a-dir' },
        },
        tempDir,
      );
      const response = ws.sent[0] as {
        payload: { success: boolean; error?: string };
      };
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toMatch(/not a directory/);
    });

    it('rejects when a same-named file exists in the destination', async () => {
      fsSync.writeFileSync(path.join(tempDir, 'file.ts'), 'x');
      fsSync.mkdirSync(path.join(tempDir, 'dest'));
      fsSync.writeFileSync(path.join(tempDir, 'dest', 'file.ts'), 'y');
      const ws = createMockWs();
      await handleFilesMove(
        ws,
        {
          type: 'files.move',
          payload: { srcPath: 'file.ts', destDir: 'dest' },
        },
        tempDir,
      );
      const response = ws.sent[0] as {
        payload: { success: boolean; error?: string };
      };
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toMatch(/already exists/);
    });

    it('guards against moving the project root', async () => {
      fsSync.mkdirSync(path.join(tempDir, 'dest'));
      const ws = createMockWs();
      await handleFilesMove(
        ws,
        {
          type: 'files.move',
          payload: { srcPath: '.', destDir: 'dest' },
        },
        tempDir,
      );
      const response = ws.sent[0] as {
        payload: { success: boolean; error?: string };
      };
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toMatch(/project root/i);
    });
  });

  describe('handleFilesSkeleton', () => {
    it('extracts skeleton from disk file', async () => {
      const code = `
export interface Config {
  port: number;
}

export function startServer(cfg: Config): void {
  const msg = "Server on port " + cfg.port;
  console.log(msg);
}
`;
      fsSync.writeFileSync(path.join(tempDir, 'server.ts'), code, 'utf8');
      const ws = createMockWs();

      await handleFilesSkeleton(
        ws,
        {
          type: 'files.skeleton',
          payload: { filePath: 'server.ts' },
        },
        tempDir,
      );

      expect(ws.sent.length).toBe(1);
      const res = ws.sent[0] as {
        type: string;
        payload: {
          filePath: string;
          lang: string;
          skeleton: string;
          stats: { originalLines: number; skeletonLines: number; tokenSavingsPercent: number };
          error?: string;
        };
      };

      expect(res.type).toBe('files.skeleton_result');
      expect(res.payload.filePath).toBe('server.ts');
      expect(res.payload.lang).toBe('ts');
      expect(res.payload.skeleton).toContain('export interface Config');
      expect(res.payload.skeleton).toContain(
        'export function startServer(cfg: Config): void { /* L6-L9 */ }',
      );
      expect(res.payload.skeleton).not.toContain('const msg =');
      expect(res.payload.stats.tokenSavingsPercent).toBeGreaterThan(0);
    });

    it('handles malformed or non-existent requests safely', async () => {
      const ws = createMockWs();
      await handleFilesSkeleton(
        ws,
        {
          type: 'files.skeleton',
          payload: { filePath: 'nonexistent.ts' },
        },
        tempDir,
      );

      expect(ws.sent.length).toBe(1);
      const res = ws.sent[0] as {
        type: string;
        payload: { filePath: string; error?: string };
      };
      expect(res.type).toBe('files.skeleton_result');
      expect(res.payload.error).toBeDefined();
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
