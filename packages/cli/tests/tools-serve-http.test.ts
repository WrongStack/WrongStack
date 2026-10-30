import * as fs from 'node:fs/promises';
import { createServer, type IncomingMessage, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRegistry } from '@wrongstack/core/registry';
import { builtinToolsPack } from '@wrongstack/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/arg-parser.js';
import type { ToolsCliIo } from '../src/subcommands/handlers/tools-cli.js';
import { serveToolsCommand } from '../src/subcommands/handlers/tools-serve.js';
import { createToolGateway } from '../src/tool-gateway.js';
import { serveToolGatewayHttp, type ToolGatewayHttpHandle } from '../src/tool-gateway-http.js';

const TOKEN = 'test-token-0123456789abcdef';

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.registerAllOrThrow([...(builtinToolsPack.tools ?? [])], builtinToolsPack.name);
  return r;
}

let root: string;
let handle: ToolGatewayHttpHandle | undefined;
let closeGateway: (() => Promise<void>) | undefined;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tools-serve-')));
  await fs.writeFile(path.join(root, 'hello.txt'), 'hello over http\n');
});

afterEach(async () => {
  await handle?.close();
  await closeGateway?.();
  handle = undefined;
  closeGateway = undefined;
  await fs.rm(root, { recursive: true, force: true });
});

async function start(
  extra: { allow?: string[]; maxConcurrentCalls?: number; catchUpIndex?: () => Promise<void> } = {},
) {
  const reg = registry();
  const gateway = await createToolGateway({
    registry: reg,
    config: { tools: {} },
    cwd: root,
    projectRoot: root,
    yolo: false,
    allow: extra.allow,
    whitelist: null,
    remoteAgent: true,
    catchUpIndex: extra.catchUpIndex ?? (async () => {}),
  });
  closeGateway = () => gateway.close();
  handle = await serveToolGatewayHttp({
    gateway,
    registry: reg,
    token: TOKEN,
    maxConcurrentCalls: extra.maxConcurrentCalls,
  });
  return handle;
}

function req(
  url: string,
  init: {
    method?: string;
    body?: unknown;
    token?: string | null;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token !== null) headers['authorization'] = `Bearer ${init.token ?? TOKEN}`;
  if (init.body !== undefined) headers['content-type'] ??= 'application/json';
  return fetch(url, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body:
      init.body === undefined
        ? null
        : typeof init.body === 'string'
          ? init.body
          : JSON.stringify(init.body),
  });
}

function rawGet(
  url: string,
  pathname: string,
  token: string | null = TOKEN,
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const client = request(
      {
        host: target.hostname,
        port: target.port,
        method: 'GET',
        path: pathname,
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    client.on('error', reject);
    client.end();
  });
}

describe('wstack tools serve — REST tool gateway', () => {
  it('refuses to start without a real token', async () => {
    const reg = registry();
    const gateway = await createToolGateway({
      registry: reg,
      config: { tools: {} },
      cwd: root,
      projectRoot: root,
      yolo: false,
      whitelist: null,
      remoteAgent: true,
    });
    await expect(serveToolGatewayHttp({ gateway, registry: reg, token: 'short' })).rejects.toThrow(
      /at least 16/,
    );
    await gateway.close();
  });

  it('answers /health without auth and everything else only with the bearer token', async () => {
    const { url } = await start();
    expect((await req(`${url}health`, { token: null })).status).toBe(200);
    expect((await req(`${url}v1/tools`, { token: null })).status).toBe(401);
    expect((await req(`${url}v1/tools`, { token: 'wrong-token-0123456789abc' })).status).toBe(401);
    expect((await req(`${url}v1/tools`)).status).toBe(200);
  });

  it('rejects malformed percent-encoding as a client error without breaking valid paths', async () => {
    const { url } = await start();
    expect((await rawGet(url, '/v1/unknown')).status).toBe(404);
    expect((await rawGet(url, '/v1/tools/%ZZ', null)).status).toBe(401);

    const malformed = await rawGet(url, '/v1/tools/%ZZ');
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)).toEqual({ ok: false, error: 'invalid_path_encoding' });
  });

  it('lists tools with schemas, keeps process-bound tools and withholds session-bound ones', async () => {
    const { url } = await start();
    const body = (await (await req(`${url}v1/tools`)).json()) as {
      mode: string;
      tools: { name: string; input_schema: { properties?: object } }[];
    };
    const names = new Set(body.tools.map((t) => t.name));
    expect(body.mode).toBe('safe');
    expect(names.has('read')).toBe(true);
    expect(names.has('browser_open')).toBe(true);
    expect(names.has('clarify')).toBe(false);
    expect(names.has('write')).toBe(false);
    expect(body.tools.find((t) => t.name === 'read')?.input_schema.properties).toHaveProperty(
      'path',
    );
  });

  it('runs a tool and returns its result as a 200 tool result', async () => {
    const { url } = await start();
    const res = await req(`${url}v1/tools/read/call`, {
      body: { call_id: 'c-1', input: { path: 'hello.txt' } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ call_id: 'c-1', ok: true, tool: 'read', settlement: 'completed' });
    expect(String(body['content'])).toContain('hello over http');
  });

  it('reports a tool-level failure as a result the model can read, not a transport error', async () => {
    const { url } = await start();
    const res = await req(`${url}v1/tools/read/call`, { body: { input: {} } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, settlement: 'invalid_input' });
  });

  it('a withheld tool is 404 with the grant it needs; --allow exposes it', async () => {
    const safe = await start();
    const refused = await req(`${safe.url}v1/tools/write/call`, {
      body: { input: { path: 'x.txt', content: 'x' } },
    });
    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { message: string }).message).toContain('--allow fs.write');
    await handle?.close();
    await closeGateway?.();

    const granted = await start({ allow: ['fs.write'] });
    const res = await req(`${granted.url}v1/tools/write/call`, {
      body: { input: { path: 'made.txt', content: 'made' } },
    });
    expect(await res.json()).toMatchObject({ ok: true });
    expect(await fs.readFile(path.join(root, 'made.txt'), 'utf8')).toBe('made');
  });

  it('rejects non-JSON, malformed bodies and foreign origins before running anything', async () => {
    const { url } = await start();
    const call = `${url}v1/tools/read/call`;
    expect(
      (await req(call, { body: '{}', headers: { 'content-type': 'text/plain' } })).status,
    ).toBe(415);
    expect((await req(call, { body: '{oops' })).status).toBe(400);
    expect((await req(call, { body: { input: [1] } })).status).toBe(400);
    expect(
      (await req(`${url}v1/tools`, { headers: { origin: 'https://evil.example' } })).status,
    ).toBe(403);
  });

  it('delivers a long call to a loopback callback and answers 202 at once', async () => {
    const received: { auth: string | undefined; body: Record<string, unknown> }[] = [];
    const sink = createServer((r: IncomingMessage, res) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => {
        received.push({ auth: r.headers.authorization, body: JSON.parse(data) });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((done) => sink.listen(0, '127.0.0.1', () => done()));
    const sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/done`;
    try {
      const { url } = await start();
      const res = await req(`${url}v1/tools/read/call`, {
        body: {
          call_id: 'async-1',
          input: { path: 'hello.txt' },
          callback: { url: sinkUrl, token: 'cb-secret' },
        },
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ call_id: 'async-1', status: 'accepted' });
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5000 });
      expect(received[0]?.auth).toBe('Bearer cb-secret');
      expect(received[0]?.body).toMatchObject({ call_id: 'async-1', ok: true, tool: 'read' });
    } finally {
      await new Promise<void>((done) => sink.close(() => done()));
    }
  });

  it('refuses a callback to a non-loopback host unless the operator allowed it', async () => {
    const { url } = await start();
    const res = await req(`${url}v1/tools/read/call`, {
      body: { input: { path: 'hello.txt' }, callback: { url: 'https://example.com/hook' } },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain('loopback');
  });

  it('catches the index up before index queries, sharing one catch-up across concurrent calls', async () => {
    let release: () => void = () => {};
    const catchUp = vi.fn(
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    const { url } = await start({ catchUpIndex: catchUp });
    const a = req(`${url}v1/tools/codebase-stats/call`, { body: {} });
    const b = req(`${url}v1/tools/codebase-stats/call`, { body: {} });
    await vi.waitFor(() => expect(catchUp).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([a, b]);
    expect(catchUp).toHaveBeenCalledTimes(1);
    // A plain file read never waits on the index.
    await req(`${url}v1/tools/read/call`, { body: { input: { path: 'hello.txt' } } });
    expect(catchUp).toHaveBeenCalledTimes(1);
  });

  it("serves WrongForge's tool-gateway request shape, resolving relative paths in its workdir", async () => {
    await fs.mkdir(path.join(root, 'pkg'));
    await fs.writeFile(path.join(root, 'pkg', 'inner.txt'), 'inside the task workdir\n');
    const { url } = await start();
    // Exactly what WrongForge's gateway client POSTs (src/tools/gateway.ts).
    const res = await req(`${url}v1/tools/read/call`, {
      headers: {
        accept: 'application/json',
        'x-wrongforge-task': 'task-1',
        'x-wrongforge-session': 'sess-1',
        'x-wrongforge-tool-call': 'toolu_01',
      },
      body: {
        tool: 'read',
        input: { path: 'inner.txt' },
        task_id: 'task-1',
        session_id: 'sess-1',
        call_id: 'toolu_01',
        workdir: path.join(root, 'pkg'),
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // WrongForge passes a body with a boolean `ok` to its model as-is.
    expect(body).toMatchObject({ call_id: 'toolu_01', ok: true, tool: 'read' });
    expect(String(body['content'])).toContain('inside the task workdir');
  });

  it('refuses a workdir outside the served project, or one that does not exist', async () => {
    const elsewhere = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'tools-serve-out-')),
    );
    try {
      const { url } = await start();
      for (const workdir of [elsewhere, path.join(root, 'missing'), '..']) {
        const res = await req(`${url}v1/tools/read/call`, {
          body: { input: { path: 'hello.txt' }, workdir },
        });
        expect(res.status, workdir).toBe(400);
        expect(await res.json()).toMatchObject({ ok: false, error: 'bad_workdir' });
      }
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('accepts an in-root workdir whose first segment merely begins with ".."', async () => {
    // Canonical escape test (shell-open-dotdot regression class): a directory
    // NAMED `..scratch` is inside the project; only `..` climbing or an
    // absolute relative result is a traversal. The loose startsWith('..')
    // predicate misread such workdirs as escapes and refused every tool call
    // for a task rooted there.
    await fs.mkdir(path.join(root, '..scratch', 'build'), { recursive: true });
    await fs.writeFile(path.join(root, '..scratch', 'build', 'inner.txt'), 'dotdot root\n');
    await fs.mkdir(path.join(root, 'plain', 'build'), { recursive: true });
    await fs.writeFile(path.join(root, 'plain', 'build', 'inner.txt'), 'plain root\n');
    const { url } = await start();
    for (const workdir of [
      path.join(root, '..scratch', 'build'),
      path.join('..scratch', 'build'),
      path.join(root, 'plain', 'build'),
    ]) {
      const res = await req(`${url}v1/tools/read/call`, {
        body: { input: { path: 'inner.txt' }, workdir },
      });
      expect(res.status, workdir).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body, workdir).toMatchObject({ ok: true, tool: 'read' });
      expect(String(body['content']), workdir).toContain('inner.txt');
    }
  });

  it('answers 429 instead of piling up calls past the concurrency cap', async () => {
    let release: () => void = () => {};
    const { url } = await start({
      maxConcurrentCalls: 1,
      catchUpIndex: () =>
        new Promise<void>((done) => {
          release = done;
        }),
    });
    const slow = req(`${url}v1/tools/codebase-stats/call`, { body: {} });
    await new Promise((r) => setTimeout(r, 50));
    expect(
      (await req(`${url}v1/tools/read/call`, { body: { input: { path: 'hello.txt' } } })).status,
    ).toBe(429);
    release();
    await slow;
  });
});

describe('serveToolsCommand', () => {
  it('prints one JSON ready line with the url and a generated token, then serves', async () => {
    const lines: string[] = [];
    const io: ToolsCliIo = {
      stdout: (t) => lines.push(t),
      stderr: () => {},
      readStdin: async () => '',
    };
    const parsed = parseArgs(['tools', 'serve', '--port', '0']);
    let served: Record<string, unknown> = {};
    const code = await serveToolsCommand(
      parsed.positional.slice(2),
      {
        config: { tools: {}, features: {} },
        toolRegistry: registry(),
        cwd: root,
        projectRoot: root,
        flags: parsed.flags,
      } as never,
      io,
      async () => {
        const ready = JSON.parse(lines[0] ?? '{}') as { url: string; token: string };
        const res = await req(`${ready.url}v1/tools/read/call`, {
          token: ready.token,
          body: { input: { path: 'hello.txt' } },
        });
        served = (await res.json()) as Record<string, unknown>;
      },
    );
    expect(code).toBe(0);
    const ready = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(ready['url']).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(String(ready['token'])).toHaveLength(48);
    expect(served).toMatchObject({ ok: true, tool: 'read' });
  });

  it('keeps the allow-remote-callbacks switch from swallowing the next word', () => {
    const parsed = parseArgs(['tools', 'serve', '--allow-remote-callbacks', 'extra']);
    expect(parsed.flags['allow-remote-callbacks']).toBe(true);
    expect(parsed.positional).toContain('extra');
  });
});
