/**
 * Focused mutation matrix for the standalone mailbox HTTP bridge.
 *
 * Each row starts from a known-valid request body, alters exactly one
 * field (delete, wrong type, or out-of-domain value), and asserts that
 * the bridge returns `400 VALIDATION_ERROR` **before** any `Mailbox`
 * method is invoked. Coverage here exercises the bridge end-to-end —
 * `createMailboxHttpRouter` lives in `@wrongstack/core`, but the bridge
 * is the live external-agent surface, so validating the contract at
 * this layer (auth, body parser, router dispatch, error envelope) is
 * the highest-leverage check that a future regression in core
 * couldn't silently slip through.
 *
 * The bridge helper, `http`, spawns the `wstack mailbox serve`
 * subprocess and uses the same token file the bridge wrote on
 * startup, so every mutation runs against the real running server.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { type MailboxMessage, resolveProjectDir } from '@wrongstack/core/coordination';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostFn } from '../../core/tests/coordination/mailbox-mutation-fixtures.js';
import {
  ACK_DEF,
  ACK_MANY_DEF,
  AGENT_HEARTBEAT_DEF,
  AGENT_REG_DEF,
  addRouteMutationTests,
  CHECK_DEF,
  CLIENT_REG_DEF,
  HEARTBEAT_DEF,
  QUERY_DEF,
  SEND_DEF,
} from '../../core/tests/coordination/mailbox-mutation-fixtures.js';

let tmpProject: string;
let baseUrl: string;
let token: string;
let serverChild: import('node:child_process').ChildProcess | null = null;

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

/**
 * Build a structurally-valid but wrong token by tampering with one
 * character. We deliberately avoid putting a credential-shaped literal in
 * the source — the scanner rejects `Bearer <...>` strings. The tamper
 * is derived from the live token at runtime.
 */
function tamperedToken(): string {
  const flip =
    token.length > 0 && token.charCodeAt(0) >= 48
      ? String.fromCharCode(token.charCodeAt(0) - 1)
      : 'Z';
  return flip + token.slice(1);
}

beforeAll(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-mailbox-mut-home-'));
  process.env['WRONGSTACK_HOME'] = home;
  tmpProject = await fs.mkdtemp(path.join(home, 'project-'));

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
        reject(
          new Error(
            `server didn't start within 25s; stdout so far:\n${stdout}\nstderr so far:\n${stderr}`,
          ),
        ),
      25_000,
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
  token = await readToken(resolveProjectDir(tmpProject, wstackGlobalRoot()));
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
  if (process.env['WRONGSTACK_HOME']) {
    await fs.rm(process.env['WRONGSTACK_HOME'], {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
    delete process.env['WRONGSTACK_HOME'];
  }
});

const auth = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const wrongAuth = (): Record<string, string> => ({ Authorization: `Bearer ${tamperedToken()}` });

// Shared fixture route mutations — these describe blocks are generated by
// addRouteMutationTests using the route definitions from core's fixture.
// Adding a new case to any RouteDef in mailbox-mutation-fixtures.ts
// automatically adds it to this suite too.
const bridgePost: PostFn = async (route, body, headers) => {
  const res = await http('POST', route, body, { ...auth(), ...headers });
  return { status: res.status, json: res.body };
};

addRouteMutationTests(
  [
    SEND_DEF,
    QUERY_DEF,
    CHECK_DEF,
    ACK_DEF,
    ACK_MANY_DEF,
    AGENT_REG_DEF,
    CLIENT_REG_DEF,
    HEARTBEAT_DEF,
    AGENT_HEARTBEAT_DEF,
  ],
  bridgePost,
);

describe('mailbox-bridge — POST /mailbox/ack-many empty-array acceptance boundary', () => {
  it('rejects non-object body on /mailbox/send', async () => {
    const res = await http('POST', '/mailbox/send', null, auth());
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects array body on /mailbox/send', async () => {
    const res = await http('POST', '/mailbox/send', [], auth());
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON', async () => {
    const res = await fetch(`${baseUrl}/mailbox/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...auth(),
      },
      body: '{this is not json',
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.status).toBe(400);
  });
});

describe('mailbox-bridge — auth gating for mutations', () => {
  it('returns 401 for a mutation without a token', async () => {
    const res = await http('POST', '/mailbox/send', {
      from: 'x',
      to: 'y',
      type: 'note',
      subject: 's',
      body: 'b',
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a mutation with a malformed Authorization header', async () => {
    const res = await http(
      'POST',
      '/mailbox/send',
      {
        from: 'x',
        to: 'y',
        type: 'note',
        subject: 's',
        body: 'b',
      },
      wrongAuth(),
    );
    expect(res.status).toBe(401);
  });
});

describe('mailbox-bridge — staleness filter on query responses', () => {
  // End-to-end coverage for the router-level staleness filter. We can't
  // /mailbox/send a backdated message (writes stamp `timestamp = now`), so
  // we splice a backdated record into the project's mailbox JSONL before
  // driving the live bridge. Both the fresh and the backdated messages
  // share a `to` so the bridge can address them through the
  // /mailbox/query endpoint.
  //
  // We rewrite the whole file (not just `appendFile`) on purpose: the
  // bridge subprocess keeps an mtime/size-keyed SqliteMailbox cache, and
  // a bare `appendFile` between bridge operations would leave the cache
  // "current" per its trackers yet missing the appended record. The
  // bridge's `send()` updates the cache with the post-append size, so
  // any external append is invisible until the cache mismatches on a
  // later read. `writeFile` changes both size and mtime, so the bridge's
  // next read invalidates the cache and re-reads the file from disk.
  //
  // IMPORTANT: do NOT change `writeRecord` to `appendFile` — the helper
  // exists specifically to defeat the SqliteMailbox size/mtime cache
  // and force a re-read on the next bridge operation.

  // Contract source: `packages/cli/src/subcommands/handlers/mailbox-serve.ts`
  // passes `defaultMaxAgeMs: MAILBOX_HTTP_DEFAULT_MAX_AGE_MS` to
  // `createMailboxHttpRouter`. The 1h look-back below depends on that
  // host wiring; if it ever flips to opt-out the assertions degrade to
  // "no filter" without any test signal — verify with a grep before
  // changing this test.
  /**
   * Seed a message the API cannot produce: one stamped in the past.
   * `send()` always stamps `Date.now()`, so a staleness test has to write
   * the row itself. This inserts straight into the project store the bridge
   * subprocess is serving. WAL makes the concurrent write safe, and unlike
   * the old JSONL file there is no reader cache to invalidate afterwards.
   */
  function writeRecord(databasePath: string, record: MailboxMessage): void {
    const db = new DatabaseSync(databasePath);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.prepare(
        `INSERT INTO messages(
           id, from_id, to_id, type, priority, timestamp, completed, completed_at,
           deleted_at, sender_session_id, reply_to, expires_at,
           legacy_global_completion, data
         ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, 0, ?)`,
      ).run(
        record.id,
        record.from,
        record.to,
        record.type,
        record.priority,
        record.timestamp,
        JSON.stringify(record),
      );
    } finally {
      db.close();
    }
  }

  it('returns all retained mail when callers opt in via ?sinceMs=0', async () => {
    // Unique-per-run recipient so the test does not depend on
    // isolation from other describes in this file or on a global
    // baseline. The per-request `?sinceMs=0` URL parameter is the
    // documented per-request disable sentinel. Per
    // `mailbox-http-router.ts:64-68` it shares the "no filter"
    // semantics regardless of the host's `defaultMaxAgeMs`, so the
    // bridge must return every retained message addressed at the
    // recipient regardless of age.
    // Suffix with `Date.now()` and reuse the same constant in the
    // outer `beforeAll` (L266-282) so the backdated record and the
    // test's live `/mailbox/send` address the same recipient.
    const now = Date.now();
    const recipient = `agent-staleness-${now}`;
    const dir = resolveProjectDir(tmpProject, wstackGlobalRoot());
    const databasePath = path.join(dir, '_mailbox.sqlite');
    const backdated: MailboxMessage = {
      id: `old-stale-${now}`,
      from: 'archive-bot',
      to: recipient,
      type: 'note',
      subject: 'stale',
      body: 'older than any plausible look-back window',
      priority: 'low',
      timestamp: new Date(now - 24 * 60 * 60_000).toISOString(),
      readBy: {},
      completed: false,
    };
    writeRecord(databasePath, backdated);

    // Sanity-check that the seeded row is visible to the serving process
    // before the assertions depend on it. /mailbox/check requires
    // `agentId`; `markRead: false` keeps the probe from mutating read state,
    // so the /mailbox/query?sinceMs=0 assertion below is unaffected.
    // `limit` is capped at MAILBOX_HTTP_MAX_QUERY_LIMIT (500) — /check acks
    // what it returns, so an uncapped limit is also an uncapped ack batch.
    const probe = await http(
      'POST',
      '/mailbox/check',
      { agentId: 'probe-agent', markRead: false, limit: 500 },
      auth(),
    );
    expect(probe.status).toBe(200);

    // And a fresh one with the same `recipient` so the addresses
    // collide and the bridge returns both side-by-side.
    const sent = await http(
      'POST',
      '/mailbox/send',
      {
        from: 'live-bot',
        to: recipient,
        type: 'note',
        subject: 'fresh',
        body: 'inside any look-back window',
        priority: 'normal',
      },
      auth(),
    );
    expect(sent.status).toBe(201);

    // Bare /query: the bridge host wires
    // `defaultMaxAgeMs: MAILBOX_HTTP_DEFAULT_MAX_AGE_MS` (1h), so the
    // 24h-old record is filtered out and only the fresh one comes
    // back. The /mailbox/check probe above already forced a cache
    // refresh, so the default query reads the post-/send file state
    // (which contains both records) and applies the 1h filter.
    const defaultResponse = await http('POST', '/mailbox/query', { to: recipient }, auth());
    const defaultBody = defaultResponse.body as { data: Array<{ subject: string }>; count: number };
    expect(defaultResponse.status).toBe(200);
    expect(defaultBody.count).toBe(1);
    expect(defaultBody.data).toHaveLength(1);
    expect(defaultBody.data[0]?.subject).toBe('fresh');

    // `?sinceMs=0` is the documented per-request disable sentinel.
    // Both records come back regardless of age.
    const allResponse = await http('POST', `/mailbox/query?sinceMs=0`, { to: recipient }, auth());
    const allBody = allResponse.body as { data: Array<{ subject: string }>; count: number };
    expect(allResponse.status).toBe(200);
    expect(allBody.count).toBe(2);
    expect(allBody.data.map((m) => m.subject).sort()).toEqual(['fresh', 'stale']);
  });

  it('rejects malformed per-request ?sinceMs values with 400', async () => {
    // The router's `parseSinceMs` validates the per-request override
    // up front and 400s on garbage. Negative, non-numeric, and
    // fractional values all surface as VALIDATION_ERROR — the bridge
    // never reaches `mailbox.query`.
    const recipient = `agent-staleness-bridge-bad-${Date.now()}`;
    // The recipient is only used to populate the `to` field; the
    // malformed-`sinceMs` validation rejects the request before the
    // router gets far enough to filter by recipient, so no persisted
    // record needs to match it.
    const cases: Array<{ sinceMs: string }> = [
      { sinceMs: 'abc' },
      { sinceMs: '1.5' },
      { sinceMs: '-5' },
    ];
    for (const { sinceMs } of cases) {
      const res = await http(
        'POST',
        `/mailbox/query?sinceMs=${encodeURIComponent(sinceMs)}`,
        { to: recipient },
        auth(),
      );
      expect(res.status, `sinceMs=${sinceMs}`).toBe(400);
      const errBody = res.body as { error: { code: string } };
      expect(errBody.error.code).toBe('VALIDATION_ERROR');
    }
  });
});
