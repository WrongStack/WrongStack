import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ParserWorkerRequest,
  ParserWorkerResponse,
} from '../src/codebase-index/parser-worker-protocol.js';

const workerPath = path.resolve(import.meta.dirname, '../dist/codebase-index/parser-worker.js');
const distReady = fsSync.existsSync(workerPath);
let dir = '';
let worker: Worker | undefined;
let nextId = 1;

function request(file: string): Promise<ParserWorkerResponse> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (response: ParserWorkerResponse) => {
      if (response.id !== id) return;
      worker?.off('error', onError);
      resolve(response);
    };
    const onError = (error: Error) => {
      worker?.off('message', onMessage);
      reject(error);
    };
    worker?.once('message', onMessage);
    worker?.once('error', onError);
    const message: ParserWorkerRequest = { id, file, lang: 'ts' };
    worker?.postMessage(message);
  });
}

describe.skipIf(!distReady)('codebase-index parser worker (built dist)', () => {
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-parser-worker-'));
    worker = new Worker(workerPath);
  });

  afterAll(async () => {
    await worker?.terminate();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads and parses TypeScript without retaining source in the owner', async () => {
    const file = path.join(dir, 'service.ts');
    await fs.writeFile(file, 'export class WorkerParsedService {}');

    const response = await request(file);

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.parsed.symbols.some((symbol) => symbol.name === 'WorkerParsedService')).toBe(
        true,
      );
    }
  });

  it('returns a staged read error and remains usable', async () => {
    const response = await request(path.join(dir, 'missing.ts'));
    expect(response).toMatchObject({ ok: false, stage: 'read' });
  });
});
