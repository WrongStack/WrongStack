import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleStaticFileRequest } from '../src/server/http-server/static-file-handler.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('handleStaticFileRequest symlink containment', () => {
  it('blocks symlinks escaping distDir while serving regular files inside distDir', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-static-sym-'));
    tempRoots.push(root);
    const distDir = path.join(root, 'dist');
    const outsideFile = path.join(root, 'secret.txt');
    fs.mkdirSync(distDir);
    fs.writeFileSync(outsideFile, 'SECRET_DATA');
    fs.writeFileSync(path.join(distDir, 'ok.txt'), 'PUBLIC_DATA');
    fs.symlinkSync(outsideFile, path.join(distDir, 'leak.txt'));

    const send = async (pathname: string) => {
      let status = 0;
      let body = '';
      const res = {
        setHeader() {},
        writeHead(code: number) {
          status = code;
        },
        end(chunk?: unknown) {
          body = chunk ? String(chunk) : '';
        },
      };
      await handleStaticFileRequest(
        {} as never,
        res as never,
        distDir,
        new URL(`http://localhost${pathname}`),
        { host: '127.0.0.1' } as never,
        3456,
        false,
      );
      return { status, body };
    };

    const blocked = await send('/leak.txt');
    const allowed = await send('/ok.txt');
    expect(blocked.status).toBe(403);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toBe('PUBLIC_DATA');
  });
});
