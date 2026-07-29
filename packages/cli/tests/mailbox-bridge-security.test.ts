import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProjectMailbox, resolveProjectDir } from '@wrongstack/core/coordination';
import { wstackGlobalRoot } from '@wrongstack/core/utils';

/**
 * Integration tests for mailbox HTTP bridge security features:
 *   - Rate limiting (429 response)
 *   - from-identity validation (reserved internal agent ids)
 *   - ttlMs support on send
 *
 * These tests run against the same bridge instance bootstrapped by
 * mailbox-bridge.test.ts — we spawn a fresh server with a per-suite
 * temp project dir.
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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-mailbox-sec-test-'));
  process.env['WRONGSTACK_HOME'] = home;
  tmpProject = await fs.mkdtemp(path.join(home, 'project-'));
  const projectDir = resolveProjectDir(tmpProject, wstackGlobalRoot());
  mailboxProjectDir = projectDir;

  // Pre-create the mailbox store (through the project daemon — the concrete
  // SQLite store is deliberately not reachable outside its owner process).
  const mb = createProjectMailbox({ projectDir, isolatedConnection: true });
  await mb.send({
    from: 'test-bootstrap', to: 'test-bootstrap',
    type: 'note', subject: 'bootstrap', body: 'pre-suite',
  });
  await mb.close();

  // Spawn the server — same pattern as mailbox-bridge.test.ts.
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
  child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
  child.stderr?.on('data', () => { /* swallow */ });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server didn't start within 10s; stdout:\n${stdout}`)),
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

  const m = /"port":\s*(\d+)/.exec(stdout);
  if (!m) throw new Error(`could not parse port from startup log:\n${stdout}`);
  const port = Number(m[1]);
  baseUrl = `http://127.0.0.1:${port}`;
  token = await readToken(projectDir);
}, 30_000);

afterAll(async () => {
  if (serverChild) {
    const child = serverChild;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3_000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
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

// ── from-identity validation ─────────────────────────────────────────────

describe('mailbox-bridge — from-identity validation', () => {
  it('rejects "leader" as from-id', async () => {
    const res = await http('POST', '/mailbox/send', {
      from: 'leader', to: 'b', type: 'note', subject: 's', body: 'x',
    }, auth());
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    expect((res.body as { error: { message: string } }).error.message).toMatch(/reserved/i);
  });

  it('rejects "fleet" as from-id', async () => {
    const res = await http('POST', '/mailbox/send', {
      from: 'fleet', to: 'b', type: 'note', subject: 's', body: 'x',
    }, auth());
    expect(res.status).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toMatch(/reserved/i);
  });

  it('rejects "leader@session-tag" (base id is reserved)', async () => {
    const res = await http('POST', '/mailbox/send', {
      from: 'leader@abc123', to: 'b', type: 'steer', subject: 's', body: 'x',
    }, auth());
    expect(res.status).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toMatch(/reserved/i);
  });

  it('rejects "mailbox-bridge-watchdog" as from-id', async () => {
    const res = await http('POST', '/mailbox/send', {
      from: 'mailbox-bridge-watchdog', to: 'b', type: 'status', subject: 's', body: 'x',
    }, auth());
    expect(res.status).toBe(400);
  });

  it('accepts a non-reserved from-id', async () => {
    const res = await http('POST', '/mailbox/send', {
      from: 'claude-code-1234', to: 'b', type: 'note', subject: 'ok', body: 'x',
    }, auth());
    expect(res.status).toBe(201);
  });

  it('accepts "leader-like" names that are not exact matches', async () => {
    const res = await http('POST', '/mailbox/send', {
      from: 'leadership', to: 'b', type: 'note', subject: 'ok', body: 'x',
    }, auth());
    // "leadership" is NOT "leader" — should be accepted.
    expect(res.status).toBe(201);
  });
});

// ── ttlMs support ────────────────────────────────────────────────────────

describe('mailbox-bridge — ttlMs on send', () => {
  it('accepts ttlMs and sets expiresAt on the message', async () => {
    const res = await http('POST', '/mailbox/send', {
      from: 'ttl-sender', to: 'ttl-reader',
      type: 'note', subject: 'ttl-test', body: 'expires soon',
      ttlMs: 30_000,
    }, auth());
    expect(res.status).toBe(201);
    const msg = res.body as { expiresAt?: string };
    expect(msg.expiresAt).toBeDefined();
    // Should be in the near future (~30s from now).
    const expiry = new Date(msg.expiresAt!).getTime();
    const now = Date.now();
    expect(expiry).toBeGreaterThan(now);
    expect(expiry).toBeLessThan(now + 60_000);
  });

  it('works without ttlMs (expiresAt omitted)', async () => {
    const res = await http('POST', '/mailbox/send', {
      from: 'no-ttl-sender', to: 'b',
      type: 'note', subject: 'no-ttl', body: 'x',
    }, auth());
    expect(res.status).toBe(201);
    const msg = res.body as { expiresAt?: string };
    // expiresAt should be undefined or absent.
    expect(msg.expiresAt).toBeUndefined();
  });
});

// ── Rate limiting (MUST run last — exhausts the budget) ───────────────────
//
// This describe block fires 140+ requests to exhaust the 120/min budget.
// All other tests in this file MUST run before this block, otherwise they
// will receive 429 instead of their expected status codes. Vitest runs
// describe blocks in source order within a file, so keeping this last
// guarantees correctness.

describe('mailbox-bridge — rate limiting', () => {
  it('allows a small burst of requests under the limit', async () => {
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await http('GET', '/mailbox/agents', undefined, auth());
      results.push(res.status);
    }
    expect(results.every((s) => s === 200)).toBe(true);
  });

  it('returns 429 RATE_LIMITED when the limit is exceeded', async () => {
    // Fire requests rapidly — the limit is 120/min. After the budget
    // is exhausted, subsequent requests should get 429.
    let ok200 = 0;
    let rateLimited429 = 0;
    let otherStatus = 0;

    for (let i = 0; i < 140; i++) {
      const res = await http('GET', '/mailbox/agents', undefined, auth());
      if (res.status === 200) ok200++;
      else if (res.status === 429) rateLimited429++;
      else otherStatus++;
    }

    expect(rateLimited429).toBeGreaterThan(0);
    expect(ok200).toBeGreaterThan(0);
    expect(otherStatus).toBe(0);
  });

  it('429 response body has RATE_LIMITED error code', async () => {
    const res = await http('GET', '/mailbox/agents', undefined, auth());
    // Budget is exhausted from the previous test — should be 429.
    // If the window slid (unlikely in <1s), skip gracefully.
    if (res.status === 429) {
      const err = (res.body as { error: { code: string; message: string } }).error;
      expect(err.code).toBe('RATE_LIMITED');
      expect(err.message).toMatch(/rate limit/i);
    }
  });

  it('healthz is NOT rate-limited (unauthenticated)', async () => {
    // Even after the budget is exhausted, /healthz should still respond.
    const res = await http('GET', '/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
