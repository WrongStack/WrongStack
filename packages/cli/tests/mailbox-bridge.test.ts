import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GlobalMailbox, resolveProjectDir, wstackGlobalRoot } from '@wrongstack/core';
import { mailboxServeCmd } from '../src/subcommands/handlers/mailbox-serve.js';

/**
 * Integration tests for the mailbox HTTP bridge.
 *
 * Each test boots a fresh `wstack mailbox serve` against a per-suite
 * temp project dir, then exercises the route table end-to-end over HTTP.
 * The server is stopped via SIGINT after the suite, and the temp dir is
 * removed. We pin the port to 0 so the OS assigns a free port — the
 * `address()` callback captures the actual port.
 */

let tmpProject: string;
let serverPromise: Promise<number>; // resolves to the bound port
let token: string;
let baseUrl: string;
let serverChild: { kill: (sig: NodeJS.Signals) => void } | null = null;

async function readToken(projectDir: string): Promise<string> {
  const tokenPath = path.join(projectDir, '.mailbox.token');
  // Token is written synchronously at startup; retry briefly to handle
  // any FS race in the test runner.
  for (let i = 0; i < 20; i++) {
    try {
      return (await fs.readFile(tokenPath, 'utf8')).trim();
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`timed out waiting for token file at ${tokenPath}`);
}

async function http(
  method: 'GET' | 'POST',
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5_000),
  });
  let parsed: unknown = null;
  const text = await res.text();
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

beforeAll(async () => {
  // Per-suite project dir under WRONGSTACK_HOME so resolveProjectDir lands
  // somewhere we control. WRONGSTACK_HOME is read by wstackGlobalRoot(); we
  // set it before the handler imports its deps.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-mailbox-test-home-'));
  process.env['WRONGSTACK_HOME'] = home;
  // Per-suite project dir under that home.
  tmpProject = await fs.mkdtemp(path.join(home, 'project-'));
  // Construct GlobalMailbox against the same project dir so we can
  // observe writes through the same file the HTTP server reads.
  const projectDir = resolveProjectDir(tmpProject, wstackGlobalRoot());
  // Pre-create the project mailbox file by issuing a no-op read; the
  // server's `unreadCount` etc. would still work without it, but writing
  // a sentinel message ensures the JSONL exists.
  const mb = new GlobalMailbox(projectDir);
  await mb.send({
    from: 'test-bootstrap',
    to: 'test-bootstrap',
    type: 'note',
    subject: 'bootstrap',
    body: 'pre-suite',
  });
  await mb.close();

  // Boot the server via the same handler the CLI uses. We pass
  // --port 0 so the OS picks a free port, and capture it from a side
  // channel: spawn the server in a child process so we can read its
  // listening port from stdout. The handler is async and blocks until
  // SIGINT, so we can't call it directly from the test — instead we
  // spawn `wstack mailbox serve` as a subprocess (mirroring how a real
  // user runs it).
  const { spawn } = await import('node:child_process');
  const cliEntry = process.argv[1];
  const child = spawn(
    cliEntry,
    ['mailbox', 'serve', '--host', '127.0.0.1', '--port', '0'],
    { cwd: tmpProject, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  serverChild = child;
  let stdout = '';
  child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
  child.stderr?.on('data', () => { /* swallow */ });

  // Wait for the structured startup event so we know the port.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server didn't start within 10s; stdout so far:\n${stdout}`)),
      10_000,
    );
    const check = setInterval(() => {
      if (stdout.includes('"mailbox_serve_started"')) {
        clearInterval(check);
        clearTimeout(timer);
        resolve();
      }
    }, 50);
    child.once('exit', (code) => {
      clearInterval(check);
      clearTimeout(timer);
      reject(new Error(`server exited early (code=${code}); stdout:\n${stdout}`));
    });
  });

  // Parse the bind URL from the structured log line.
  const m = /"port":\s*(\d+)/.exec(stdout);
  if (!m) throw new Error(`could not parse port from startup log:\n${stdout}`);
  const port = Number(m[1]);
  baseUrl = `http://127.0.0.1:${port}`;
  token = await readToken(projectDir);
  // Suppress unused-warning: serverPromise is referenced in afterAll.
  serverPromise = Promise.resolve(port);
}, 30_000);

afterAll(async () => {
  if (serverChild) serverChild.kill('SIGINT');
  if (process.env['WRONGSTACK_HOME']) {
    await fs.rm(process.env['WRONGSTACK_HOME'], { recursive: true, force: true });
    delete process.env['WRONGSTACK_HOME'];
  }
});

const auth = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });

describe('mailbox-bridge — /healthz (no auth)', () => {
  it('returns 200 with { ok: true } without a token', async () => {
    const res = await http('GET', '/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('mailbox-bridge — auth gate', () => {
  it('returns 401 without a token', async () => {
    const res = await http('GET', '/mailbox/agents');
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });
  it('returns 401 with a wrong token', async () => {
    const res = await http('GET', '/mailbox/agents', undefined, {
      Authorization: 'Bearer not-the-real-token',
    });
    expect(res.status).toBe(401);
  });
  it('returns 200 with the right token', async () => {
    const res = await http('GET', '/mailbox/agents', undefined, auth());
    expect(res.status).toBe(200);
  });
});

describe('mailbox-bridge — POST /mailbox/send', () => {
  it('creates a message and returns 201 with the message', async () => {
    const res = await http('POST', '/mailbox/send', {
      from: 'test-sender',
      to: 'test-receiver',
      type: 'note',
      subject: 'hello',
      body: 'integration test message',
    }, auth());
    expect(res.status).toBe(201);
    const msg = res.body as { id: string; subject: string };
    expect(msg.subject).toBe('hello');
    expect(typeof msg.id).toBe('string');
  });

  it('returns 400 VALIDATION_ERROR when required fields are missing', async () => {
    const res = await http('POST', '/mailbox/send', {
      to: 'test-receiver',
      type: 'note',
      subject: 'missing-from',
      body: 'should fail',
    }, auth());
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when type is invalid', async () => {
    const res = await http('POST', '/mailbox/send', {
      from: 'a', to: 'b', type: 'not-a-real-type', subject: 's', body: 'b',
    }, auth());
    expect(res.status).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toContain('type');
  });
});

describe('mailbox-bridge — POST /mailbox/query', () => {
  it('returns messages matching the recipient filter', async () => {
    const res = await http('POST', '/mailbox/query', {
      to: 'test-receiver',
      limit: 10,
    }, auth());
    expect(res.status).toBe(200);
    const data = (res.body as { data: Array<{ subject: string }> }).data;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it('honors the `since` filter', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await http('POST', '/mailbox/query', { since: future }, auth());
    expect(res.status).toBe(200);
    expect((res.body as { data: unknown[] }).data.length).toBe(0);
  });
});

describe('mailbox-bridge — POST /mailbox/ack', () => {
  it('acks a single message and returns the updated message', async () => {
    // First, send a message directed at our test reader.
    const sent = await http('POST', '/mailbox/send', {
      from: 'test-ack-sender',
      to: 'test-ack-reader',
      type: 'note',
      subject: 'ack-me',
      body: 'ack test',
    }, auth());
    const msgId = (sent.body as { id: string }).id;

    const ack = await http('POST', '/mailbox/ack', {
      messageId: msgId,
      readerId: 'test-ack-reader',
      read: true,
    }, auth());
    expect(ack.status).toBe(200);
    expect((ack.body as { updated: { id: string } | null }).updated?.id).toBe(msgId);
  });
});

describe('mailbox-bridge — POST /mailbox/ack-many', () => {
  it('acks a batch of messages under one call', async () => {
    const sent1 = await http('POST', '/mailbox/send', {
      from: 'test-batch-sender',
      to: 'test-batch-reader',
      type: 'note', subject: 'batch-1', body: 'one',
    }, auth());
    const sent2 = await http('POST', '/mailbox/send', {
      from: 'test-batch-sender',
      to: 'test-batch-reader',
      type: 'note', subject: 'batch-2', body: 'two',
    }, auth());

    const res = await http('POST', '/mailbox/ack-many', {
      acks: [
        { messageId: (sent1.body as { id: string }).id, readerId: 'test-batch-reader', read: true },
        { messageId: (sent2.body as { id: string }).id, readerId: 'test-batch-reader', read: true },
      ],
    }, auth());
    expect(res.status).toBe(200);
    expect((res.body as { count: number }).count).toBe(2);
  });
});

describe('mailbox-bridge — POST /mailbox/unread-count', () => {
  it('returns the unread count for an agent', async () => {
    const res = await http('POST', '/mailbox/unread-count', {
      forAgentId: 'some-agent',
    }, auth());
    expect(res.status).toBe(200);
    expect(typeof (res.body as { count: number }).count).toBe('number');
  });
});

describe('mailbox-bridge — agent & client registry', () => {
  it('registers an external agent with source=http', async () => {
    const res = await http('POST', '/mailbox/agents/register', {
      agentId: 'ext-claude-code-test',
      sessionId: 'external',
      name: 'Claude Code (test)',
      role: 'external',
      pid: 99999,
    }, auth());
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });

  it('appears in /mailbox/agents with source: http', async () => {
    const res = await http('GET', '/mailbox/agents', undefined, auth());
    expect(res.status).toBe(200);
    const data = (res.body as { data: Array<{ agentId: string; source?: string }> }).data;
    const found = data.find((a) => a.agentId === 'ext-claude-code-test');
    expect(found).toBeDefined();
    expect(found?.source).toBe('http');
  });

  it('updates the agent heartbeat', async () => {
    const res = await http('POST', '/mailbox/agents/heartbeat', {
      agentId: 'ext-claude-code-test',
      currentTask: 'integration test running',
    }, auth());
    expect(res.status).toBe(200);
  });

  it('registers an external client with source=http', async () => {
    const res = await http('POST', '/mailbox/register-client', {
      clientId: 'ext-client-test',
      name: 'External Client (test)',
      pid: 99999,
    }, auth());
    expect(res.status).toBe(200);
  });

  it('updates the client heartbeat', async () => {
    const res = await http('POST', '/mailbox/heartbeat', {
      clientId: 'ext-client-test',
    }, auth());
    expect(res.status).toBe(200);
  });
});

describe('mailbox-bridge — error shape', () => {
  it('returns the { error: { code, message } } shape on 404', async () => {
    const res = await http('GET', '/no-such-route', undefined, auth());
    expect(res.status).toBe(404);
    const err = (res.body as { error: { code: string; message: string } }).error;
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toContain('no route');
  });

  it('returns the error shape on validation failure', async () => {
    const res = await http('POST', '/mailbox/send', { to: 'x' }, auth());
    expect(res.status).toBe(400);
    const err = (res.body as { error: { code: string } }).error;
    expect(err.code).toBe('VALIDATION_ERROR');
  });
});

describe('mailbox-bridge — body cap', () => {
  it('returns 400 VALIDATION_ERROR for a body larger than 256 KB', async () => {
    const huge = 'x'.repeat(300 * 1024); // 300 KB > 256 KB cap
    const res = await http('POST', '/mailbox/send', {
      from: 'oversized-sender',
      to: 'oversized-receiver',
      type: 'note',
      subject: 'too big',
      body: huge,
    }, auth());
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string; message: string } }).error.code).toBe('VALIDATION_ERROR');
    expect((res.body as { error: { message: string } }).error.message).toMatch(/too large|body/i);
  });
});

// Suppress unused-var warnings; the project mailbox was constructed in
// beforeAll to ensure the JSONL exists and to give GlobalMailbox a real
// shared state with the server.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
void resolveProjectDir;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
void mailboxServeCmd;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
void serverPromise;