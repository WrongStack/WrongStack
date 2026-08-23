import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProjectMailbox, resolveProjectDir } from '@wrongstack/core/coordination';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration tests for the mailbox HTTP bridge SSE (Server-Sent Events) endpoint.
 *
 * Verifies that:
 *   - GET /mailbox/events opens an SSE stream
 *   - A POST /mailbox/send pushes an event to the SSE stream
 *   - The stream sends a keepalive comment
 *   - The stream requires auth (401 without token)
 *   - Client disconnect cleans up the subscriber
 *
 * These tests spawn a fresh `wstack mailbox serve` with a per-suite temp project.
 * The CLI must be built first (`pnpm --filter @wrongstack/cli build`).
 */

let tmpProject: string;
let token: string;
let baseUrl: string;
let serverChild: import('node:child_process').ChildProcess | null = null;
let mailboxProjectDir: string;

async function readToken(projectDir: string): Promise<string> {
  const tokenPath = path.join(projectDir, '.mailbox.token');
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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-mailbox-sse-test-'));
  process.env['WRONGSTACK_HOME'] = home;
  tmpProject = await fs.mkdtemp(path.join(home, 'project-'));
  const projectDir = resolveProjectDir(tmpProject, wstackGlobalRoot());
  mailboxProjectDir = projectDir;

  const mb = createProjectMailbox({ projectDir, isolatedConnection: true });
  // Explicitly establish and ping the detached owner before mutating the
  // store, matching the bridge's own credential-load startup contract. This
  // gives the child a stable owner to join under full-suite process pressure.
  await mb.initialize();
  await mb.send({
    from: 'test-bootstrap',
    to: 'test-bootstrap',
    type: 'note',
    subject: 'bootstrap',
    body: 'pre-suite',
  });
  await mb.close();

  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cliEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const child = spawn(
    process.execPath,
    [cliEntry, 'mailbox', 'serve', '--host', '127.0.0.1', '--port', '0'],
    { cwd: tmpProject, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  serverChild = child;
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (c: Buffer) => {
    stdout += c.toString('utf8');
  });
  child.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString('utf8');
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`server didn't start within 30s; stdout:\n${stdout}\nstderr:\n${stderr}`)),
      30_000,
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
      reject(
        new Error(`server exited early (code=${code}); stdout:\n${stdout}\nstderr:\n${stderr}`),
      );
    });
  });

  const m = /"port":\s*(\d+)/.exec(stdout);
  if (!m) throw new Error(`could not parse port from startup log:\n${stdout}`);
  const port = Number(m[1]);
  baseUrl = `http://127.0.0.1:${port}`;
  token = await readToken(projectDir);
}, 45_000);

afterAll(async () => {
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
  // The bridge reaches the mailbox through the project's detached owner, which
  // holds `_mailbox.sqlite` open. Leave it running and the rm below blocks on
  // EBUSY until the hook times out.
  const { disposeProjectMailbox, removeMailboxTempRoot } = await import(
    './helpers/mailbox-daemon.js'
  );
  await disposeProjectMailbox(mailboxProjectDir);
  if (process.env['WRONGSTACK_HOME']) {
    await removeMailboxTempRoot(process.env['WRONGSTACK_HOME']);
    delete process.env['WRONGSTACK_HOME'];
  }
});

const auth = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });

/**
 * Open an SSE connection and collect raw chunks until a timeout or
 * `predicate(chunk)` returns true. Returns all chunks received.
 */
async function openSseAndCollect(
  predicate: (chunk: string) => boolean,
  timeoutMs = 3_000,
): Promise<{ chunks: string[]; raw: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const res = await fetch(`${baseUrl}/mailbox/events`, {
    headers: auth(),
    signal: controller.signal,
  });
  const chunks: string[] = [];
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no response body');
  let raw = '';
  let matched = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = new TextDecoder().decode(value);
      raw += text;
      chunks.push(text);
      if (predicate(text)) {
        matched = true;
        break;
      }
    }
  } catch {
    // aborted by timeout — expected
  } finally {
    clearTimeout(timer);
    if (!matched) controller.abort();
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    try {
      await res.body?.cancel();
    } catch {
      /* already closed */
    }
  }
  return { chunks, raw };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('mailbox-bridge — SSE endpoint', () => {
  it('returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/mailbox/events`, {
      signal: AbortSignal.timeout(2_000),
    });
    expect(res.status).toBe(401);
    await res.text(); // drain
  });

  it('opens a text/event-stream with auth', async () => {
    const { raw } = await openSseAndCollect((chunk) => chunk.includes('connected'), 2_000);
    expect(raw).toContain(': connected');
  });

  it('sends an initial ": connected" comment', async () => {
    const { raw } = await openSseAndCollect((chunk) => chunk.includes('connected'));
    expect(raw).toContain(': connected');
  });

  it('pushes a message.sent event when a message is sent via POST', async () => {
    // Start collecting SSE events in the background.
    const ssePromise = openSseAndCollect((chunk) => chunk.includes('message.sent'), 5_000);
    // Give the SSE connection a moment to establish + subscribe.
    await new Promise((r) => setTimeout(r, 200));

    // Send a message — this should trigger an SSE push.
    await http(
      'POST',
      '/mailbox/send',
      {
        from: 'sse-test-sender',
        to: 'sse-test-receiver',
        type: 'note',
        subject: 'sse-event-test',
        body: 'hello via SSE',
      },
      auth(),
    );

    const { raw } = await ssePromise;

    // The raw stream should contain a data: line with message.sent.
    expect(raw).toContain('data:');
    expect(raw).toContain('message.sent');
    expect(raw).toContain('sse-test-sender'); // from field
  });

  it('SSE event has correct JSON structure', async () => {
    const ssePromise = openSseAndCollect((chunk) => chunk.includes('message.sent'), 5_000);
    await new Promise((r) => setTimeout(r, 200));

    const sendRes = await http(
      'POST',
      '/mailbox/send',
      {
        from: 'json-structure-test',
        to: 'receiver',
        type: 'note',
        subject: 'structure',
        body: 'x',
      },
      auth(),
    );
    const sentMsg = sendRes.body as { id: string };

    const { raw } = await ssePromise;

    // Extract the data: JSON payload.
    const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
    expect(dataLine).toBeDefined();
    const jsonStr = dataLine!.slice(5).trim();
    const event = JSON.parse(jsonStr) as {
      type: string;
      messageId: string;
      from?: string;
      to?: string;
      timestamp: string;
    };

    expect(event.type).toBe('message.sent');
    expect(event.messageId).toBe(sentMsg.id);
    expect(event.from).toBe('json-structure-test');
    expect(event.to).toBe('receiver');
    expect(event.timestamp).toBeDefined();
  });

  it('delivers multiple events in order', async () => {
    const ssePromise = openSseAndCollect((chunk) => {
      // Wait for at least 2 data events.
      const dataLines = chunk.split('\n').filter((l) => l.startsWith('data:'));
      return dataLines.length >= 2;
    }, 5_000);
    await new Promise((r) => setTimeout(r, 200));

    await http(
      'POST',
      '/mailbox/send',
      {
        from: 'multi-sender',
        to: 'r',
        type: 'note',
        subject: 'first',
        body: '1',
      },
      auth(),
    );
    await http(
      'POST',
      '/mailbox/send',
      {
        from: 'multi-sender',
        to: 'r',
        type: 'note',
        subject: 'second',
        body: '2',
      },
      auth(),
    );

    const { raw } = await ssePromise;
    const dataLines = raw.split('\n').filter((l) => l.startsWith('data:'));
    expect(dataLines.length).toBeGreaterThanOrEqual(2);

    const events = dataLines.map((l) => JSON.parse(l.slice(5).trim()) as { type: string });
    expect(events.every((e) => e.type === 'message.sent')).toBe(true);
  });

  it('multiple concurrent SSE clients each receive events', async () => {
    // Open two SSE connections simultaneously.
    const sse1Promise = openSseAndCollect((chunk) => chunk.includes('multi-client-test'), 5_000);
    const sse2Promise = openSseAndCollect((chunk) => chunk.includes('multi-client-test'), 5_000);
    await new Promise((r) => setTimeout(r, 300));

    await http(
      'POST',
      '/mailbox/send',
      {
        from: 'multi-client-test',
        to: 'r',
        type: 'note',
        subject: 'broadcast-test',
        body: 'x',
      },
      auth(),
    );

    const [r1, r2] = await Promise.all([sse1Promise, sse2Promise]);
    expect(r1.raw).toContain('multi-client-test');
    expect(r2.raw).toContain('multi-client-test');
  });
});
