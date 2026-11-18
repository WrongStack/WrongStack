import * as fs from 'node:fs/promises';
import type * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutomationServer } from '../src/automation/http.js';
import { handleAutomationManagement } from '../src/automation/management.js';
import { AutomationPullRequests } from '../src/automation/pull-request.js';
import { AutomationService } from '../src/automation/service.js';
import { AutomationStore } from '../src/automation/store.js';

const dirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function makeMockReq(method: string, headers: Record<string, string>, chunks: Buffer[]) {
  let destroyedMidStream = false;
  let index = 0;
  const stream = new Readable({
    read() {
      if (index < chunks.length) this.push(chunks[index++]!);
      else this.push(null);
    },
    destroy(err, cb) {
      if (index < chunks.length || this.readableLength > 0) destroyedMidStream = true;
      cb(err);
    },
  });
  return {
    req: Object.assign(stream, { method, headers }) as unknown as http.IncomingMessage,
    wasDestroyedMidStream: () => destroyedMidStream,
  };
}

function makeMockRes() {
  const out = { status: 0, body: '' };
  const res = {
    headersSent: false,
    writeHead(code: number) {
      out.status = code;
      (res as { headersSent: boolean }).headersSent = true;
    },
    end(payload?: string) {
      out.body = payload ?? '';
    },
  } as unknown as http.ServerResponse;
  return { res, out };
}

describe('automation HTTP optional-body POSTs and 413 oversize handling', () => {
  it('accepts bodyless pr/check and chunked-empty job run POSTs and returns 413 on >128 KiB bodies', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'automation-body-val-'));
    dirs.push(dir);
    const projectDir = path.join(dir, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    const realProject = await fs.realpath(projectDir);
    const store = new AutomationStore(path.join(dir, 'automation'));

    const job = await store.add({
      name: 'nightly-audit',
      projectRoot: realProject,
      image: 'trusted:1',
      prompt: 'Audit repo',
      envNames: [],
      yolo: false,
      enabled: true,
      timeoutMs: 60_000,
    });
    const run = await store.enqueue(
      job.id,
      'manual',
      'seed-1',
      'default',
      '',
      Date.now(),
      undefined,
      realProject,
    );

    vi.spyOn(AutomationPullRequests.prototype, 'check').mockResolvedValue({
      status: 'clean',
      checks: [],
    } as never);

    const prCheck = makeMockReq('POST', {}, []);
    const prCheckRes = makeMockRes();
    await handleAutomationManagement(
      prCheck.req,
      prCheckRes.res,
      new URL(`http://127.0.0.1/v1/runs/${run.id}/pr/check`),
      store,
      async () => {},
      realProject,
    );
    expect(prCheckRes.out.status).toBe(200);

    const chunkedRun = makeMockReq(
      'POST',
      { 'transfer-encoding': 'chunked', 'idempotency-key': 'chunked-empty' },
      [],
    );
    const chunkedRunRes = makeMockRes();
    await handleAutomationManagement(
      chunkedRun.req,
      chunkedRunRes.res,
      new URL(`http://127.0.0.1/v1/jobs/${job.id}/run`),
      store,
      async () => {},
      realProject,
    );
    expect(chunkedRunRes.out.status).toBe(202);

    const oversize = makeMockReq('POST', { 'content-type': 'application/json' }, [
      Buffer.alloc(100 * 1024, 0x20),
      Buffer.alloc(40 * 1024, 0x20),
    ]);
    const oversizeRes = makeMockRes();
    await handleAutomationManagement(
      oversize.req,
      oversizeRes.res,
      new URL('http://127.0.0.1/v1/jobs'),
      store,
      async () => {},
      realProject,
    );
    expect(oversizeRes.out.status).toBe(413);
    expect(oversize.wasDestroyedMidStream()).toBe(false);

    const server = createAutomationServer(new AutomationService(store), 'a'.repeat(64));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const hookResp = await fetch(`http://127.0.0.1:${port}/hooks/${job.id}/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.alloc(140 * 1024, 0x20),
    });
    expect(hookResp.status).toBe(413);
  });
});
