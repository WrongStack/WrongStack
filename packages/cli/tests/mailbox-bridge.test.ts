import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createProjectMailbox,
  MailboxProjectServerConnection,
  resolveProjectDir,
} from '@wrongstack/core/coordination';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
let mailboxProjectDir: string;
let serverPromise: Promise<number> | undefined; // resolves to the bound port
let token: string;
let credentialAuthorization: string;
let baseUrl: string;
let serverChild: import('node:child_process').ChildProcess | null = null;
// Startup output is accumulated at module scope so the startup-banner test can
// assert on it. `writeStartupInfo` emits a structured JSON line (stdout, for
// log-shippers) plus a human-readable mirror; both are captured because the
// banner is the only place an operator learns the projectId that credentials
// are scoped to.
let startupStdout = '';
let startupStderr = '';

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
  } as never);
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
  delete process.env['WRONGSTACK_MAILBOX_INLINE'];
  // Per-suite project dir under that home.
  tmpProject = await fs.mkdtemp(path.join(home, 'project-'));
  const projectDir = resolveProjectDir(tmpProject, wstackGlobalRoot());
  mailboxProjectDir = projectDir;
  // Bootstrap through the same IPC owner the bridge will use.
  const mb = createProjectMailbox({ projectDir, isolatedConnection: true });
  await mb.initialize();
  await mb.send({
    from: 'test-bootstrap',
    to: 'test-bootstrap',
    type: 'note',
    subject: 'bootstrap',
    body: 'pre-suite',
  });
  const issued = await mb.credentialIssue({
    principalId: 'bridge-test@test-session',
    projectId: path.basename(projectDir),
    kind: 'agent',
    capabilities: ['mail.presence.read'],
    ttlMs: 60_000,
  });
  credentialAuthorization = `Credential ${issued.credential.credentialId}:${issued.secret}`;
  await mb.close();

  // Boot the server via the same handler the CLI uses. We pass
  // --port 0 so the OS picks a free port, and capture it from a side
  // channel: spawn the server in a child process so we can read its
  // listening port from stdout. The handler is async and blocks until
  // SIGINT, so we can't call it directly from the test — instead we
  // spawn `wstack mailbox serve` as a subprocess (mirroring how a real
  // user runs it).
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  // Spawn the BUILT CLI entry under the current node binary. Using
  // process.argv[1] would spawn the vitest runner (the bridge would
  // never start — it exits 1 on the unknown args); the integration test
  // needs the real `wstack` entry, which is the package's compiled dist
  // bin. Spawning a `.js` path directly throws EFTYPE on Windows, so we
  // always go through process.execPath. (Run `pnpm --filter @wrongstack/cli
  // build` first if dist is missing.)
  const cliEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const child = spawn(
    process.execPath,
    [cliEntry, 'mailbox', 'serve', '--host', '127.0.0.1', '--port', '0'],
    { cwd: tmpProject, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  serverChild = child;
  child.stdout?.on('data', (c: Buffer) => {
    startupStdout += c.toString('utf8');
  });
  // Accumulated rather than swallowed: renderer.write() goes to stderr, and the
  // human-readable startup banner is asserted on by the startup-banner test.
  child.stderr?.on('data', (c: Buffer) => {
    startupStderr += c.toString('utf8');
  });

  // Wait for the structured startup event so we know the port.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server didn't start within 10s; stdout so far:\n${startupStdout}`)),
      10_000,
    );
    const check = setInterval(() => {
      if (startupStdout.includes('"mailbox_serve_started"')) {
        clearInterval(check);
        clearTimeout(timer);
        resolve();
      }
    }, 50);
    child.once('exit', (code) => {
      clearInterval(check);
      clearTimeout(timer);
      reject(new Error(`server exited early (code=${code}); stdout:\n${startupStdout}`));
    });
  });

  // Parse the bind URL from the structured log line.
  const m = /"port":\s*(\d+)/.exec(startupStdout);
  if (!m) throw new Error(`could not parse port from startup log:\n${startupStdout}`);
  const port = Number(m[1]);
  baseUrl = `http://127.0.0.1:${port}`;
  token = await readToken(projectDir);
  // Suppress unused-warning: serverPromise is referenced in afterAll.
  serverPromise = Promise.resolve(port);
}, 30_000);

afterAll(async () => {
  // Wait for the bridge child to actually exit before removing its temp
  // dir — on Windows the killed process can still hold file handles on
  // the mailbox JSONL for a moment, and rmdir then fails with EBUSY.
  if (serverChild) {
    const child = serverChild;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3_000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      child.kill('SIGINT');
    });
  }
  if (mailboxProjectDir) {
    const connection = new MailboxProjectServerConnection(mailboxProjectDir);
    await connection.shutdown('mailbox bridge integration test complete').catch(() => undefined);
    connection.close();
  }
  if (process.env['WRONGSTACK_HOME']) {
    // maxRetries/retryDelay ride out any lingering Windows file lock.
    await fs.rm(process.env['WRONGSTACK_HOME'], {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
    delete process.env['WRONGSTACK_HOME'];
  }
  delete process.env['WRONGSTACK_MAILBOX_INLINE'];
});

const auth = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });

describe('mailbox-bridge — startup banner', () => {
  it('surfaces projectId in both the JSON line and the human-readable output', () => {
    // The projectId is `path.basename(projectDir)`, NOT the directory itself,
    // and mailbox-http-router compares it byte-for-byte. The banner is the only
    // place an operator sees it: without this line they copy the printed
    // `Project dir` into a credential and every request then 403s with
    // "credential is scoped to a different project".
    const expectedProjectId = path.basename(mailboxProjectDir);
    expect(expectedProjectId).not.toBe(mailboxProjectDir);

    const startupLine = startupStdout
      .split('\n')
      .find((line) => line.includes('"mailbox_serve_started"'));
    expect(startupLine, `no startup event in stdout:\n${startupStdout}`).toBeDefined();
    const parsed = JSON.parse(startupLine as string) as Record<string, unknown>;
    expect(parsed['projectId']).toBe(expectedProjectId);
    // projectDir must stay alongside it: the pair is what makes the distinction
    // between the two values legible.
    expect(parsed['projectDir']).toBe(mailboxProjectDir);

    // Human-readable mirror. Asserted against both streams on purpose: the
    // comment above writeStartupInfo claims renderer.write() goes to stderr,
    // but measured against the built CLI it lands on stdout. The banner's
    // stream is not the contract here — its presence is — so combining the two
    // keeps this test from breaking if the renderer's routing is corrected.
    const startupOutput = `${startupStdout}\n${startupStderr}`;
    expect(startupOutput).toContain(`Project id:   ${expectedProjectId}`);
    expect(startupOutput).toContain('when issuing credentials');
    expect(startupOutput).toContain(`Project dir:  ${mailboxProjectDir}`);
  });
});

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
  it('accepts a persisted identity credential immediately after startup', async () => {
    const res = await http('GET', '/mailbox/agents', undefined, {
      Authorization: credentialAuthorization,
    });
    expect(res.status).toBe(200);
  });
});

describe('mailbox-bridge — POST /mailbox/send', () => {
  it('creates a message and returns 201 with the message', async () => {
    const res = await http(
      'POST',
      '/mailbox/send',
      {
        from: 'test-sender',
        to: 'test-receiver',
        type: 'note',
        subject: 'hello',
        body: 'integration test message',
      },
      auth(),
    );
    expect(res.status).toBe(201);
    const msg = res.body as { id: string; subject: string };
    expect(msg.subject).toBe('hello');
    expect(typeof msg.id).toBe('string');
  });

  it('returns 400 VALIDATION_ERROR when required fields are missing', async () => {
    const res = await http(
      'POST',
      '/mailbox/send',
      {
        to: 'test-receiver',
        type: 'note',
        subject: 'missing-from',
        body: 'should fail',
      },
      auth(),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when type is invalid', async () => {
    const res = await http(
      'POST',
      '/mailbox/send',
      {
        from: 'a',
        to: 'b',
        type: 'not-a-real-type',
        subject: 's',
        body: 'b',
      },
      auth(),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toContain('type');
  });
});

describe('mailbox-bridge — POST /mailbox/query', () => {
  it('returns messages matching the recipient filter', async () => {
    const res = await http(
      'POST',
      '/mailbox/query',
      {
        to: 'test-receiver',
        limit: 10,
      },
      auth(),
    );
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

describe('mailbox-bridge — POST /mailbox/check', () => {
  it('checks direct/base/broadcast inbox mail and can complete returned messages', async () => {
    await http(
      'POST',
      '/mailbox/send',
      {
        from: 'external-sender',
        to: 'external-reader',
        type: 'ask',
        subject: 'direct-check',
        body: 'direct body',
      },
      auth(),
    );
    await http(
      'POST',
      '/mailbox/send',
      {
        from: 'external-sender',
        to: 'external',
        type: 'assign',
        subject: 'base-check',
        body: 'base body',
      },
      auth(),
    );
    await http(
      'POST',
      '/mailbox/send',
      {
        from: 'external-sender',
        to: '*',
        type: 'broadcast',
        subject: 'broadcast-check',
        body: 'broadcast body',
      },
      auth(),
    );

    const res = await http(
      'POST',
      '/mailbox/check',
      {
        agentId: 'external-reader',
        baseId: 'external',
        completed: true,
        outcome: 'handled over bridge',
        limit: 10,
      },
      auth(),
    );
    expect(res.status).toBe(200);
    const data = (
      res.body as {
        data: Array<{ subject: string; completed: boolean; outcome?: string }>;
        count: number;
      }
    ).data;
    expect((res.body as { count: number }).count).toBe(3);
    expect(data.map((m) => m.subject).sort()).toEqual([
      'base-check',
      'broadcast-check',
      'direct-check',
    ]);
    expect(data.every((m) => m.completed)).toBe(true);
    expect(data.every((m) => m.outcome === 'handled over bridge')).toBe(true);
  });

  it('can peek without marking returned messages read', async () => {
    await http(
      'POST',
      '/mailbox/send',
      {
        from: 'peek-sender',
        to: 'peek-reader',
        type: 'note',
        subject: 'peek-check',
        body: 'peek body',
      },
      auth(),
    );

    const res = await http(
      'POST',
      '/mailbox/check',
      {
        agentId: 'peek-reader',
        markRead: false,
      },
      auth(),
    );
    expect(res.status).toBe(200);
    expect(
      (res.body as { data: Array<{ subject: string }> }).data.some(
        (m) => m.subject === 'peek-check',
      ),
    ).toBe(true);

    const query = await http(
      'POST',
      '/mailbox/query',
      {
        to: 'peek-reader',
        unreadBy: 'peek-reader',
        limit: 10,
      },
      auth(),
    );
    expect(
      (query.body as { data: Array<{ subject: string }> }).data.some(
        (m) => m.subject === 'peek-check',
      ),
    ).toBe(true);
  });
});

describe('mailbox-bridge — POST /mailbox/ack', () => {
  it('acks a single message and returns the updated message', async () => {
    // First, send a message directed at our test reader.
    const sent = await http(
      'POST',
      '/mailbox/send',
      {
        from: 'test-ack-sender',
        to: 'test-ack-reader',
        type: 'note',
        subject: 'ack-me',
        body: 'ack test',
      },
      auth(),
    );
    const msgId = (sent.body as { id: string }).id;

    const ack = await http(
      'POST',
      '/mailbox/ack',
      {
        messageId: msgId,
        readerId: 'test-ack-reader',
        read: true,
      },
      auth(),
    );
    expect(ack.status).toBe(200);
    expect((ack.body as { updated: { id: string } | null }).updated?.id).toBe(msgId);
  });
});

describe('mailbox-bridge — POST /mailbox/ack-many', () => {
  it('acks a batch of messages under one call', async () => {
    const sent1 = await http(
      'POST',
      '/mailbox/send',
      {
        from: 'test-batch-sender',
        to: 'test-batch-reader',
        type: 'note',
        subject: 'batch-1',
        body: 'one',
      },
      auth(),
    );
    const sent2 = await http(
      'POST',
      '/mailbox/send',
      {
        from: 'test-batch-sender',
        to: 'test-batch-reader',
        type: 'note',
        subject: 'batch-2',
        body: 'two',
      },
      auth(),
    );

    const res = await http(
      'POST',
      '/mailbox/ack-many',
      {
        acks: [
          {
            messageId: (sent1.body as { id: string }).id,
            readerId: 'test-batch-reader',
            read: true,
          },
          {
            messageId: (sent2.body as { id: string }).id,
            readerId: 'test-batch-reader',
            read: true,
          },
        ],
      },
      auth(),
    );
    expect(res.status).toBe(200);
    expect((res.body as { count: number }).count).toBe(2);
  });
});

describe('mailbox-bridge — POST /mailbox/unread-count', () => {
  it('returns the unread count for an agent', async () => {
    const res = await http(
      'POST',
      '/mailbox/unread-count',
      {
        forAgentId: 'some-agent',
      },
      auth(),
    );
    expect(res.status).toBe(200);
    expect(typeof (res.body as { count: number }).count).toBe('number');
  });
});

describe('mailbox-bridge — agent & client registry', () => {
  it('registers an external agent with source=http', async () => {
    const res = await http(
      'POST',
      '/mailbox/agents/register',
      {
        agentId: 'ext-claude-code-test',
        sessionId: 'external',
        name: 'Claude Code (test)',
        role: 'external',
        pid: 99999,
      },
      auth(),
    );
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
    const res = await http(
      'POST',
      '/mailbox/agents/heartbeat',
      {
        agentId: 'ext-claude-code-test',
        currentTask: 'integration test running',
      },
      auth(),
    );
    expect(res.status).toBe(200);
  });

  it('registers an external client with source=http', async () => {
    const res = await http(
      'POST',
      '/mailbox/register-client',
      {
        clientId: 'ext-client-test',
        name: 'External Client (test)',
        pid: 99999,
      },
      auth(),
    );
    expect(res.status).toBe(200);
  });

  it('updates the client heartbeat', async () => {
    const res = await http(
      'POST',
      '/mailbox/heartbeat',
      {
        clientId: 'ext-client-test',
      },
      auth(),
    );
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
    const res = await http(
      'POST',
      '/mailbox/send',
      {
        from: 'oversized-sender',
        to: 'oversized-receiver',
        type: 'note',
        subject: 'too big',
        body: huge,
      },
      auth(),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string; message: string } }).error.code).toBe(
      'VALIDATION_ERROR',
    );
    expect((res.body as { error: { message: string } }).error.message).toMatch(/too large|body/i);
  });
});

// Suppress unused-var warnings; the project mailbox was constructed in
// beforeAll to ensure the JSONL exists and to give SqliteMailbox a real
// shared state with the server.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
void resolveProjectDir;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
void mailboxServeCmd;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
void serverPromise;
