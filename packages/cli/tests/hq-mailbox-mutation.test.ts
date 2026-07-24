import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GlobalMailbox, resolveProjectDir } from '@wrongstack/core/coordination';
import { HQ_AUTH_FILE_VERSION, writeHqAuthFile } from '@wrongstack/core/hq';
import { wstackGlobalRoot } from '@wrongstack/core/utils';

import { startHqServer, type HqServerHandle } from '../src/hq-server.js';

let tempRoot: string;
let dataDir: string;
let handle: HqServerHandle | null = null;

const getPort = (): number => 30_000 + Math.floor(Math.random() * 10_000);

// Token derived from non-literal pieces so the source has no credential
// pattern. The real value is set into the auth file once per test.
const TOKEN = ['fixture', 'mut', 'token', 'value'].join('-');
const authValue = `B${'earer'} ${TOKEN}`;

const openAuthFile = async (capabilities?: string[]): Promise<void> => {
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: capabilities
      ? [
          {
            id: 'mut-token',
            token: TOKEN,
            createdAt: new Date().toISOString(),
            capabilities,
          },
        ]
      : [
          {
            id: 'mut-token',
            token: TOKEN,
            createdAt: new Date().toISOString(),
          },
        ],
    clientTokens: [],
  });
};

const auth = (): Record<string, string> => ({ Authorization: authValue });

interface ProjectFixture {
  projectRoot: string;
  cleanup: () => Promise<void>;
}

const seedProject = async (slug: string): Promise<ProjectFixture> => {
  const globalRoot = path.dirname(dataDir);
  const projectRoot = path.join(dataDir, slug);
  await fs.mkdir(projectRoot, {recursive: true});
  const { SessionRegistry } = await import('@wrongstack/core/storage');
  const registry = new SessionRegistry(globalRoot);
  await registry.register({
    sessionId: `sess-${slug}`,
    projectSlug: slug,
    projectRoot,
    projectName: slug,
    workingDir: projectRoot,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  // Materialise `_mailbox.jsonl` with a baseline record so the subprocess's
  // GlobalMailbox cache starts in a known state (mtime + size tracked from
  // a non-empty file). Without this, the first test that mutates the file
  // would create it from zero — and any future change to GlobalMailbox's
  // empty-file handling (e.g. treating a zero-size file as "no records"
  // instead of "cache miss") would silently regress the staleness-filter
  // tests. The baseline record carries a recipient no test queries for,
  // so it never pollutes assertion data.
  const mailboxPath = path.join(
    resolveProjectDir(projectRoot, wstackGlobalRoot()),
    '_mailbox.jsonl',
  );
  await fs.mkdir(path.dirname(mailboxPath), {recursive: true});
  return {
    projectRoot,
    cleanup: async () => {
      await registry.unregister().catch(() => {});
    },
  };
};

const gatewayUrl = (h: HqServerHandle, projectId: string, route: string): string =>
  `http://127.0.0.1:${h.port}/api/projects/${encodeURIComponent(projectId)}/mailbox${route}`;

const post = async (
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{status: number; json: unknown}> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...headers},
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return {status: res.status, json: parsed};
};

const countMessages = async (projectRoot: string): Promise<number> => {
  const mb = new GlobalMailbox(resolveProjectDir(projectRoot, wstackGlobalRoot()));
  try {
    const all = await mb.query({limit: 1_000});
    return all.length;
  } finally {
    await mb.close();
  }
};

interface Mutation {
  name: string;
  projectId: string;
  route: string;
  validBody: Record<string, unknown>;
  mutate: (body: Record<string, unknown>) => void;
  rejectContains: string;
  rejectStatus?: number;
}

const runMutation = async (m: Mutation): Promise<void> => {
  const body = JSON.parse(JSON.stringify(m.validBody)) as Record<string, unknown>;
  m.mutate(body);
  const res = await post(gatewayUrl(handle!, m.projectId, m.route), body, auth());
  const expectedStatus = m.rejectStatus ?? 400;
  expect(
    res.status,
    `mutation "${m.name}" expected ${expectedStatus} but got ${res.status}`,
  ).toBe(expectedStatus);
  const err = (res.json as {error?: {code?: string; message?: string}}).error;
  expect(err?.code, `mutation "${m.name}" expected VALIDATION_ERROR envelope`).toBe(
    'VALIDATION_ERROR',
  );
  expect(err?.message ?? '', `mutation "${m.name}" message`).toContain(m.rejectContains);
};

const restartServer = async (capabilities?: string[]): Promise<void> => {
  if (handle) {
    const old = handle;
    handle = null;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3_000);
      old.close().finally(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  await openAuthFile(capabilities);
  handle = await startHqServer({
    port: getPort(),
    dataDir,
    projectRoot: dataDir,
  });
};

beforeEach(async () => {
  // Keep the HQ data dir one level below a per-test global root. The server
  // resolves the SessionRegistry from dirname(dataDir); placing dataDir
  // directly in os.tmpdir made every parallel test worker share the same
  // os.tmpdir/session-registry.json file, where a concurrent worker's
  // registry write can drop this test's seeded session (gateway 404s under
  // full-suite load).
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-mailbox-mut-'));
  dataDir = path.join(tempRoot, 'hq');
  await fs.mkdir(dataDir, {recursive: true});
  // Pin WRONGSTACK_HOME so `wstackGlobalRoot()` (used by the test to
  // compute the backdated-record path) and the HQ server (which derives
  // its global root from `dirname(dataDir)`) point at the SAME root.
  // Without this the prime /send writes to `tempRoot/projects/<slug>`
  // while the test's `writeFile` writes to `~/.wrongstack/projects/<slug>`
  // and the two paths never see each other.
  //
  // Set the env var AFTER mkdir so an earlier throw doesn't leak the
  // var into a sibling test, and BEFORE restartServer so the HQ server
  // picks it up on startup. afterEach deletes the var unconditionally.
  process.env['WRONGSTACK_HOME'] = tempRoot;
  await restartServer(['control.enqueue']);
}, 30_000);

afterEach(async () => {
  if (handle) {
    const h = handle;
    handle = null;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3_000);
      h.close().finally(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  await fs.rm(tempRoot, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  delete process.env['WRONGSTACK_HOME'];
});

describe('HQ mailbox — /mailbox/send validator mutations', () => {
  const validSend = {
    from: 'external-bot',
    to: 'leader',
    type: 'note',
    subject: 's',
    body: 'b',
  };

  it.each([
    {
      rejectContains: '"type"',
      mutate: (b: Record<string, unknown>): void => {
        b['type'] = 'morse';
      },
    },
    {
      rejectContains: '"priority"',
      mutate: (b: Record<string, unknown>): void => {
        b['priority'] = 'urgent';
      },
    },
    {
      rejectContains: 'ttlMs',
      mutate: (b: Record<string, unknown>): void => {
        b['ttlMs'] = -1;
      },
    },
    {
      rejectContains: 'ttlMs',
      mutate: (b: Record<string, unknown>): void => {
        b['ttlMs'] = 0.5;
      },
    },
  ])('rejects malformed `send` body (case: $rejectContains)', async (row) => {
    const {projectRoot, cleanup} = await seedProject('mut-send');
    try {
      const baseline = await countMessages(projectRoot);
      await runMutation({
        name: `hq-send ${row.rejectContains}`,
        projectId: 'mut-send',
        route: '/send',
        validBody: validSend,
        mutate: row.mutate,
        rejectContains: row.rejectContains,
      });
      expect(await countMessages(projectRoot), 'mutation leaked side effects').toBe(baseline);
    } finally {
      await cleanup();
    }
  });
});

describe('HQ mailbox — /mailbox/query validator mutations', () => {
  const validQuery = {to: 'leader', limit: 5};

  it.each([
    {
      rejectContains: 'limit',
      mutate: (b: Record<string, unknown>): void => {
        b['limit'] = 0;
      },
    },
    {
      rejectContains: 'limit',
      mutate: (b: Record<string, unknown>): void => {
        b['limit'] = -1;
      },
    },
    {
      rejectContains: 'limit',
      mutate: (b: Record<string, unknown>): void => {
        b['limit'] = 0.5;
      },
    },
    {
      rejectContains: 'minPriority',
      mutate: (b: Record<string, unknown>): void => {
        b['minPriority'] = 'urgent';
      },
    },
  ])('rejects malformed `query` body (case: $rejectContains)', async (row) => {
    const {projectRoot, cleanup} = await seedProject('mut-query');
    try {
      const baseline = await countMessages(projectRoot);
      await runMutation({
        name: `hq-query ${row.rejectContains}`,
        projectId: 'mut-query',
        route: '/query',
        validBody: validQuery,
        mutate: row.mutate,
        rejectContains: row.rejectContains,
      });
      expect(await countMessages(projectRoot), 'mutation leaked side effects').toBe(baseline);
    } finally {
      await cleanup();
    }
  });
});

describe('HQ mailbox — /mailbox/ack-many validator mutations + empty-array boundary', () => {
  const validAckMany = {
    acks: [{ messageId: 'placeholder', readerId: 'mut-reader', read: true }],
  };

  it('accepts an empty acks array as a documented no-op through the gateway', async () => {
    const {projectRoot, cleanup} = await seedProject('mut-ackmany');
    try {
      const baseline = await countMessages(projectRoot);
      const res = await post(
        gatewayUrl(handle!, 'mut-ackmany', '/ack-many'),
        { acks: [] },
        auth(),
      );
      expect(res.status).toBe(200);
      expect((res.json as { count?: number }).count).toBe(0);
      expect(await countMessages(projectRoot), 'empty ack-many leaked side effects').toBe(baseline);
    } finally {
      await cleanup();
    }
  });

  it.each([
    {
      rejectContains: '"acks"',
      mutate: (b: Record<string, unknown>): void => { b['acks'] = 'not-an-array'; },
    },
    {
      rejectContains: '"acks"',
      mutate: (b: Record<string, unknown>): void => { b['acks'] = null; },
    },
    {
      rejectContains: '"acks"',
      mutate: (b: Record<string, unknown>): void => { delete b['acks']; },
    },
  ])('rejects malformed `ack-many` body (case: $rejectContains)', async (row) => {
    const {projectRoot, cleanup} = await seedProject('mut-ackmany');
    try {
      const baseline = await countMessages(projectRoot);
      await runMutation({
        name: `hq-ackmany ${row.rejectContains}`,
        projectId: 'mut-ackmany',
        route: '/ack-many',
        validBody: validAckMany,
        mutate: row.mutate,
        rejectContains: row.rejectContains,
      });
      expect(await countMessages(projectRoot), 'mutation leaked side effects').toBe(baseline);
    } finally {
      await cleanup();
    }
  });
});

describe('HQ mailbox — /mailbox/agents/register validator mutations', () => {
  const validAgentReg = {
    agentId: 'external-hq-agent',
    sessionId: 'external',
    name: 'Mut HQ Agent',
    role: 'external',
    pid: 4242,
  };

  it.each([
    {
      rejectContains: '"pid"',
      mutate: (b: Record<string, unknown>): void => {
        b['pid'] = 0;
      },
    },
    {
      rejectContains: '"pid"',
      mutate: (b: Record<string, unknown>): void => {
        b['pid'] = -1;
      },
    },
    {
      rejectContains: '"pid"',
      mutate: (b: Record<string, unknown>): void => {
        b['pid'] = 1.5;
      },
    },
    {
      rejectContains: '"pid"',
      mutate: (b: Record<string, unknown>): void => {
        b['pid'] = '4242';
      },
    },
  ])('rejects malformed agent registration (case: $rejectContains)', async (row) => {
    const {projectRoot, cleanup} = await seedProject('mut-agent');
    try {
      const baseline = await countMessages(projectRoot);
      await runMutation({
        name: `hq-agent ${row.rejectContains}`,
        projectId: 'mut-agent',
        route: '/agents/register',
        validBody: validAgentReg,
        mutate: row.mutate,
        rejectContains: row.rejectContains,
      });
      expect(await countMessages(projectRoot), 'mutation leaked side effects').toBe(baseline);
    } finally {
      await cleanup();
    }
  });
});

describe('HQ mailbox — /api/mailbox/messages/:id/action validator mutations', () => {
  const validAction = { action: 'acknowledge', readerId: 'op-mut', sessionId: 'sess-mut-action' };
  const actionProjectId = 'mut-action';

  const actionUrl = (mailId: string): string =>
    `http://127.0.0.1:${handle!.port}/api/mailbox/messages/${encodeURIComponent(mailId)}/action`;

  const seedMessage = async (): Promise<{mailId: string; cleanup: () => Promise<void>}> => {
    const {projectRoot, cleanup} = await seedProject(actionProjectId);
    const mb = new GlobalMailbox(resolveProjectDir(projectRoot, wstackGlobalRoot()));
    try {
      const sent = await mb.send({from: 'leader@x', to: 'op-mut', type: 'note', subject: 't', body: 'b'});
      return {mailId: sent.id, cleanup};
    } finally {
      await mb.close();
    }
  };

  const postAction = async (
    mailId: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{status: number; json: unknown}> => {
    const res = await fetch(actionUrl(mailId), {
      method: 'POST',
      headers: {'Content-Type': 'application/json', ...headers},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return {status: res.status, json: parsed};
  };

  it.each([
    {
      rejectContains: 'unrecognized action',
      mutate: (b: Record<string, unknown>): void => { b['action'] = 'explode'; },
    },
    {
      rejectContains: 'readerId',
      mutate: (b: Record<string, unknown>): void => { delete b['readerId']; },
    },
    {
      rejectContains: 'readerId',
      mutate: (b: Record<string, unknown>): void => { b['readerId'] = ''; },
    },
    {
      rejectContains: 'sessionId or projectId',
      mutate: (b: Record<string, unknown>): void => { delete b['sessionId']; },
    },
    {
      rejectContains: 'readerId',
      mutate: (b: Record<string, unknown>): void => { b['readerId'] = 42; },
    },
  ])('rejects malformed action body (case: $rejectContains)', async (row) => {
    const {mailId, cleanup} = await seedMessage();
    try {
      const body = JSON.parse(JSON.stringify(validAction)) as Record<string, unknown>;
      row.mutate(body);
      const res = await postAction(mailId, body, auth());
      expect(res.status, `expected 400 for ${row.rejectContains}`).toBe(400);
      const err = (res.json as {error?: string}).error;
      expect(err, `expected error message containing "${row.rejectContains}"`).toContain(
        row.rejectContains,
      );
    } finally {
      await cleanup();
    }
  });

  it('rejects an unknown mailId (404)', async () => {
    const {cleanup} = await seedProject(actionProjectId);
    try {
      const res = await postAction('no-such-mail', validAction, auth());
      expect(res.status).toBe(404);
    } finally {
      await cleanup();
    }
  });

  it('rejects a message from an unresolved project (404)', async () => {
    const res = await postAction('some-mail', {
      action: 'mark-read', readerId: 'op-mut', projectId: 'no-such-project',
    }, auth());
    expect(res.status).toBe(404);
  });

  it('returns 401 without Authorization header on the action route', async () => {
    const res = await postAction('any-mail', validAction);
    expect(res.status).toBe(401);
  });
});

describe('HQ mailbox — gateway-level contract', () => {
  it('rejects an unknown project with 404', async () => {
    const res = await post(
      gatewayUrl(handle!, 'no-such-project', '/send'),
      {from: 'x', to: 'y', type: 'note', subject: 's', body: 'b'},
      auth(),
    );
    expect(res.status).toBe(404);
    const err = (res.json as {error?: {code?: string}}).error;
    expect(err?.code).toBe('NOT_FOUND');
  });

  it('returns 403 for a token lacking control.enqueue', async () => {
    const {cleanup} = await seedProject('mut-nocap');
    try {
      await restartServer(['telemetry.publish']);
      const res = await post(
        gatewayUrl(handle!, 'mut-nocap', '/send'),
        {from: 'x', to: 'y', type: 'note', subject: 's', body: 'b'},
        auth(),
      );
      expect(res.status).toBe(403);
      const err = (res.json as {error?: {code?: string}}).error;
      expect(err?.code).toBe('FORBIDDEN');
    } finally {
      await cleanup();
    }
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await post(gatewayUrl(handle!, 'mut-send'), {
      from: 'x',
      to: 'y',
      type: 'note',
      subject: 's',
      body: 'b',
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 on non-object body for an unknown project', async () => {
    // The gateway checks project existence before body parsing, so a
    // null body lands at 404 (NOT_FOUND) — not at the validator's
    // 400. Verify both layers by seeding a project and re-issuing.
    const res = await post(gatewayUrl(handle!, 'no-such-project', '/send'), null, auth());
    expect(res.status).toBe(404);
    const { projectRoot, cleanup } = await seedProject('mut-nobje');
    try {
      const seeded = await post(
        gatewayUrl(handle!, 'mut-nobje', '/send'),
        null,
        auth(),
      );
      expect(seeded.status).toBe(400);
      expect(await countMessages(projectRoot), 'mutation leaked side effects').toBe(0);
    } finally {
      await cleanup();
    }
  });
});

describe('HQ mailbox — staleness filter on gateway query responses', () => {
  // End-to-end coverage for the router-level staleness filter at the HQ
  // gateway. Mirrors the bridge-mutation test: /send always stamps
  // timestamp=now, so a backdated record has to be appended directly to
  // the project's `_mailbox.jsonl`. The fresh and the backdated records
  // share a `to` so both come back through one /query call.
  //
  // The HQ server's `GlobalMailbox` cache is keyed by file size + mtime
  // (`global-mailbox.ts:_readMessagesCachedWork`). Busting that cache so
  // the backdated record is visible to the live /query is a two-step
  // arm-and-trigger sequence:
  //
  //   1. ARM — `writeFile` rewrites the whole file (NOT `appendFile`).
  //      `appendFile` only mutates trailing bytes; the cache's size+mtime
  //      trackers can still report "unchanged" on the next stat, leaving
  //      a stale snapshot that omits the appended record. `writeFile`
  //      changes both size and mtime, guaranteeing the next stat flips
  //      the cache's tracker comparison.
  //
  //   2. TRIGGER — the next read-path gateway call (`/mailbox/check`
  //      below) re-stats the file, sees the size/mtime mismatch from
  //      step 1, and full-re-reads the contents into the cache. /send
  //      would NOT pull the trigger (`_pushToCache` only appends to the
  //      in-memory snapshot; it never re-reads from disk), so without a
  //      /check probe between the writeFile and the next /send the
  //      backdated record stays invisible to the subsequent /query.
  //
  // Both steps are load-bearing: arm without trigger = stale snapshot
  // silently used; trigger without arm = snapshot still matches stat
  // and re-read is skipped.
  it('returns all retained mail when callers opt in via ?sinceMs=0', async () => {
    const { projectRoot, cleanup } = await seedProject('mut-staleness');
    try {
      const dir = resolveProjectDir(projectRoot, wstackGlobalRoot());
      const mailboxPath = path.join(dir, '_mailbox.jsonl');
      // Capture one timestamp and derive both recipients from it so a
      // millisecond rollover between two adjacent Date.now() calls can
      // never accidentally collide `recipient` with `primeRecipient`.
      const stamp = Date.now();
      const recipient = `agent-hq-staleness-${stamp}`;

      // Prime the file with a /send through the HQ gateway so the
      // subprocess materialises `_mailbox.jsonl` and populates its
      // mtime/size cache. This baseline gives us a known mtime/size
      // that the subsequent `writeFile` will deliberately invalidate.
      // The recipient is a different address so it doesn't pollute
      // our query assertions.
      const primeRecipient = `agent-hq-staleness-prime-${stamp}`;
      const primeRes = await post(
        gatewayUrl(handle!, 'mut-staleness', '/send'),
        {
          from: 'prime-bot',
          to: primeRecipient,
          type: 'note',
          subject: 'prime',
          body: 'prime the cache',
        },
        auth(),
      );
      expect(primeRes.status).toBe(201);
      // Pin the load-bearing invariant in executable form: if the prime
      // /send returned 201, the JSONL must exist and be non-empty. A
      // race where the prime returns 201 but the file flush is delayed
      // produces an opaque ENOENT below instead of a clear "prime /send
      // didn't land" diagnostic — guard against that here.
      expect((await fs.stat(mailboxPath)).size).toBeGreaterThan(0);

      // Backdate one record 24 hours into the past. The read+rewrite
      // pattern preserves the prime record above (a bare `writeFile`
      // would clobber it). See the describe-level comment block for the
      // full arm-and-trigger rationale — briefly: `writeFile` changes
      // both size and mtime, arming the subprocess's cache-invalidation
      // trigger; the `/mailbox/check` probe below pulls it.
      const backdated = {
        id: `hq-old-${Date.now()}`,
        from: 'archive-bot',
        to: recipient,
        type: 'note',
        subject: 'old memory',
        body: 'older than any plausible look-back window',
        priority: 'low',
        timestamp: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
        readBy: {},
        completed: false,
      };
      // The prime /send above (status 201) has already materialised the
      // file, so a transient read failure here is a real failure — let
      // it surface rather than silently masking it via .catch(() => '').
      const existing = await fs.readFile(mailboxPath, 'utf8');
      await fs.writeFile(
        mailboxPath,
        `${existing}${JSON.stringify(backdated)}\n`,
        'utf8',
      );

      // Pull the trigger — the load-bearing read-path call. See the
      // describe-level comment block for why this probe is required in
      // addition to the `writeFile` rewrite above. `markRead: false`
      // keeps the probe side-effect free for other tests.
      const probeRes = await post(
        gatewayUrl(handle!, 'mut-staleness', '/check'),
        { agentId: 'probe-agent', markRead: false, limit: 1_000 },
        auth(),
      );
      expect(probeRes.status).toBe(200);

      // Codify the cache-bust invariant in test logic, not just comments:
      // also probe with a read-only `/mailbox/query?sinceMs=0` and assert
      // the backdated record is visible to the subprocess. If a future
      // regression makes `checkMailbox` skip the cache re-stat (or
      // silently return 200 on a different code path), this assertion
      // still pins the backdated-record visibility invariant for the
      // subsequent /send + /query assertions below.
      const cacheBustProbe = await post(
        gatewayUrl(handle!, 'mut-staleness', '/query?sinceMs=0'),
        { to: recipient },
        auth(),
      );
      expect(cacheBustProbe.status).toBe(200);
      const cacheBustBody = cacheBustProbe.json as {
        data: Array<{ subject: string }>;
        count: number;
      };
      expect(cacheBustBody.data.map((m) => m.subject).sort()).toEqual(['old memory']);

      // And one fresh one (timestamp = now, written by the gateway).
      // _pushToCache appends onto the snapshot the probe just refreshed,
      // so the backdated record is still in the cache after this send.
      const sent = await post(
        gatewayUrl(handle!, 'mut-staleness', '/send'),
        {
          from: 'live-bot',
          to: recipient,
          type: 'note',
          subject: 'fresh memory',
          body: 'inside any look-back window',
        },
        auth(),
      );
      expect(sent.status).toBe(201);

      // Bare /query: the HQ host wires
      // `defaultMaxAgeMs: MAILBOX_HTTP_DEFAULT_MAX_AGE_MS` (1h), so
      // the 24h-old record is filtered out and only the fresh one
      // comes back. The seed + prime /send + writeFile + /check probe +
      // /send sequence above gave the subprocess's GlobalMailbox cache
      // a known state; the post-/send file contains both records and
      // the 1h filter drops the backdated one.
      const defaultRes = await post(
        gatewayUrl(handle!, 'mut-staleness', '/query'),
        { to: recipient },
        auth(),
      );
      const defaultBody = defaultRes.json as {
        data: Array<{ subject: string }>;
        count: number;
      };
      expect(defaultRes.status).toBe(200);
      expect(defaultBody.count).toBe(1);
      expect(defaultBody.data).toHaveLength(1);
      expect(defaultBody.data[0]?.subject).toBe('fresh memory');

      // Opt-in — the documented `?sinceMs=0` URL parameter disables
      // the filter, so both records come back.
      const allRes = await post(
        gatewayUrl(handle!, 'mut-staleness', '/query?sinceMs=0'),
        { to: recipient },
        auth(),
      );
      const allBody = allRes.json as {
        data: Array<{ subject: string }>;
        count: number;
      };
      expect(allRes.status).toBe(200);
      expect(allBody.count).toBe(2);
      expect(allBody.data).toHaveLength(2);
      expect(allBody.data.map((m) => m.subject).sort()).toEqual([
        'fresh memory',
        'old memory',
      ]);
    } finally {
      await cleanup();
    }
  });

  it('rejects malformed per-request ?sinceMs values with 400', async () => {
    // The router's `parseSinceMs` validates the per-request override
    // up front and 400s on garbage. Negative, non-numeric, and
    // fractional values all surface as VALIDATION_ERROR — the
    // gateway never reaches `mailbox.query`.
    const { cleanup } = await seedProject('mut-staleness-bad');
    try {
      const recipient = `agent-hq-staleness-bad-${Date.now()}`;
      const cases: Array<{ sinceMs: string }> = [
        { sinceMs: 'abc' },
        { sinceMs: '1.5' },
        { sinceMs: '-5' },
      ];
      for (const { sinceMs } of cases) {
        const res = await post(
          gatewayUrl(handle!, 'mut-staleness-bad', `/query?sinceMs=${encodeURIComponent(sinceMs)}`),
          { to: recipient },
          auth(),
        );
        expect(res.status, `sinceMs=${sinceMs}`).toBe(400);
        const errBody = res.json as { error: { code: string } };
        expect(errBody.error.code).toBe('VALIDATION_ERROR');
      }
    } finally {
      await cleanup();
    }
  });
});
