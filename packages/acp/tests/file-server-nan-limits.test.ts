import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileServer, FsError } from '../src/client/file-server.js';

describe('FileServer NaN constructor limits (F1833)', () => {
  it('falls back to safe defaults when timeoutMs or byte limits are NaN', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-file-server-nan-'));
    try {
      const file = path.join(dir, 'sample.txt');
      await fs.writeFile(file, 'hello world', 'utf8');

      const server = new FileServer({
        projectRoot: dir,
        timeoutMs: Number.NaN,
        maxReadBytes: Number.NaN,
        maxWriteBytes: Number.NaN,
      });

      const read = await server.readTextFile({ sessionId: 's1', path: file });
      expect(read.content).toBe('hello world');

      await expect(
        server.writeTextFile({
          sessionId: 's1',
          path: file,
          content: 'x'.repeat(5 * 1024 * 1024 + 10),
        }),
      ).rejects.toSatisfy((err: unknown) => err instanceof FsError && err.code === 'TOO_LARGE');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
