import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleDeadCodeRequest } from '../src/server/deadcode-handlers.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function makeMockHttp(method: string, chunks: Buffer[]) {
  const emitter = new EventEmitter();
  let destroyedBeforeResponse = false;
  let status = 0;
  let body = '';
  const req = Object.assign(emitter, {
    method,
    destroy() {
      if (status === 0) destroyedBeforeResponse = true;
    },
  }) as unknown as http.IncomingMessage;
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(payload?: string) {
      body = payload ?? '';
    },
  } as unknown as http.ServerResponse;
  const dispatch = () => {
    for (const chunk of chunks) emitter.emit('data', chunk);
    emitter.emit('end');
  };
  return { req, res, dispatch, getResult: () => ({ status, body, destroyedBeforeResponse }) };
}

describe('handleDeadCodeRequest body validation and oversize handling', () => {
  it('returns 413 without early socket destroy on >1 MiB bodies and 400 on non-object JSON', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deadcode-body-val-'));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture', private: true, main: 'src/index.ts' }),
    );
    await fs.writeFile(path.join(dir, 'src/index.ts'), 'export const x = 1;\n');

    const oversize = makeMockHttp('POST', [
      Buffer.alloc(600 * 1024, 0x20),
      Buffer.alloc(600 * 1024, 0x20),
    ]);
    const oversizeDone = handleDeadCodeRequest('/api/deadcode/scan', oversize.req, oversize.res, {
      projectRoot: dir,
    });
    oversize.dispatch();
    await oversizeDone;
    expect(oversize.getResult().status).toBe(413);
    expect(oversize.getResult().destroyedBeforeResponse).toBe(false);

    for (const raw of ['null', '["../outside"]', '"hello"', '42']) {
      const m = makeMockHttp('POST', [Buffer.from(raw, 'utf8')]);
      const done = handleDeadCodeRequest('/api/deadcode/scan', m.req, m.res, { projectRoot: dir });
      m.dispatch();
      await done;
      expect(m.getResult().status).toBe(400);
      expect(JSON.parse(m.getResult().body)).toMatchObject({
        error: 'Request body must be a JSON object',
      });
    }
  });
});
