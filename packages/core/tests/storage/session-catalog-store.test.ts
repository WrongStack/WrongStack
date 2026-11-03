import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionRegistryEntry } from '../../src/session-catalog/session-registry-types.js';
import { SessionCatalogStore } from '../../src/session-catalog/store.js';
import { matchesSessionFilter } from '../../src/storage/session-summary.js';
import { loadDatabaseSync } from '../../src/utils/sqlite-database.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; store: SessionCatalogStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-session-catalog-'));
  roots.push(root);
  return { root, store: new SessionCatalogStore(root) };
}

function entry(sessionId: string, pid = process.pid): SessionRegistryEntry {
  const now = new Date().toISOString();
  return {
    sessionId,
    projectSlug: 'project-a',
    projectRoot: 'C:/project-a',
    projectName: 'project-a',
    workingDir: 'C:/project-a',
    clientType: 'tui',
    status: 'active',
    pid,
    startedAt: now,
    lastHeartbeatAt: now,
    agentCount: 0,
    agents: [],
  };
}

describe('SessionCatalogStore', () => {
  it('rename preserves cold-record storage metadata (contentSha256, archivedAt, storageState)', async () => {
    const { root, store } = await fixture();
    const id = '2026-01-01/sess_sha';
    const sha = 'deadbeefcafebabe0123456789abcdefdeadbeefcafebabe0123456789abcdef';
    const archivedAt = '2026-02-02T10:00:00.000Z';

    store.upsertSummary(
      {
        id,
        title: 'archived session',
        startedAt: '2026-01-01T00:00:00.000Z',
        model: 'test-model',
        provider: 'test-provider',
        tokenTotal: 42,
        lastActivityAt: '2026-01-01T09:00:00.000Z',
      },
      `${id}.jsonl.gz`,
      `${id}.summary.json`,
      {
        storageState: 'cold',
        codec: 'gzip',
        uncompressedSize: 1000,
        compressedSize: 400,
        contentSha256: sha,
        archivedAt,
      },
    );

    const renamed = await store.rename(id, 'renamed session');

    // Regression (bug-hunt round 2): renameSessionSummary previously called
    // upsertSummary WITHOUT the storage block, which re-derived
    // contentSha256 to null and archivedAt to the rename time — silently
    // destroying a cold session's integrity hash.
    expect(renamed.contentSha256).toBe(sha);
    expect(renamed.archivedAt).toBe(archivedAt);
    expect(renamed.storageState).toBe('cold');
    expect(renamed.codec).toBe('gzip');
    expect(renamed.compressedSize).toBe(400);
    expect(renamed.uncompressedSize).toBe(1000);
    expect(renamed.name).toBe('renamed session');
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('preserves a failed transaction error when SQLite already ended the transaction', async () => {
    const { store } = await fixture();
    store.close();

    const original = new Error('disk I/O error');
    const state = store as unknown as {
      db: { exec(sql: string): void };
      transaction<T>(run: () => T): T;
    };
    state.db = {
      exec(sql) {
        if (sql === 'ROLLBACK') throw new Error('cannot rollback - no transaction is active');
      },
    };

    expect(() =>
      state.transaction(() => {
        throw original;
      }),
    ).toThrow(original);
  });

  it('elects exactly one live writer and requires the exact lease proof', async () => {
    const { store } = await fixture();
    const first = store.claimNew(entry('2026-08-08/sess_a'), 'owner-a');
    expect(() => store.claimNew(entry('2026-08-08/sess_a'), 'owner-b')).toThrow(/already open/);
    expect(() => store.heartbeat({ ...first, leaseSecret: 'wrong' })).toThrow(/lease proof/);
    const renewed = store.heartbeat(first, 'idle');
    expect(renewed.expiresAt).toBeGreaterThanOrEqual(first.expiresAt);
    expect(store.getLive(first.sessionId)?.status).toBe('idle');
    store.release(renewed);
    expect(store.getLive(first.sessionId)).toBeNull();
    store.close();
  });

  // Regression: 'closing' is terminal (session_end written, process shutting
  // down) and executeHeartbeat already preserves it, but executePublishAgents
  // recomputed status from the agent list alone — so a roster batch landing
  // after mark_closing flipped the lease back to 'active'/'idle' and undid the
  // filter every consumer applies on 'closing'. The race is live: the daemon
  // dispatches socket frames without serializing them, and markClosing() does
  // not await an in-flight flushAgents().
  it('does not resurrect a closing lease on the next agent publish', async () => {
    const { store } = await fixture();
    const credential = store.claimNew(entry('2026-08-08/sess_closing'), 'owner-a');
    const running = [
      { id: 'a1', name: 'agent-1', status: 'running' },
    ] as SessionRegistryEntry['agents'];

    store.publishAgents(credential, 1, running);
    expect(store.getLive(credential.sessionId)?.status).toBe('active');

    store.markClosing(credential);
    expect(store.getLive(credential.sessionId)?.status).toBe('closing');

    store.publishAgents(credential, 2, running);
    expect(store.getLive(credential.sessionId)?.status).toBe('closing');
    // The roster itself still updates — only the lifecycle status is sticky.
    expect(store.getLive(credential.sessionId)?.agentCount).toBe(1);
    store.close();
  });

  it('a stale agent revision is rejected and leaves the roster intact', async () => {
    const { store } = await fixture();
    const credential = store.claimNew(entry('2026-08-08/sess_stale'), 'owner-a');
    const running = [
      { id: 'a1', name: 'agent-1', status: 'running' },
    ] as SessionRegistryEntry['agents'];

    store.publishAgents(credential, 5, running);
    expect(store.publishAgents(credential, 2, []).accepted).toBe(false);
    expect(store.getLive(credential.sessionId)?.agentCount).toBe(1);
    store.close();
  });

  it('frees an unexpired lease once its owner process is gone', async () => {
    // A CLI leaving through the forced-exit path never releases its lease;
    // waiting out the expiry made `wstack -r <id>` right after a one-shot run
    // fail with "already open in another running wstack" naming a dead pid.
    const { store } = await fixture();
    const id = '2026-08-08/sess_dead_owner';
    store.claimNew(entry(id, 2 ** 22 + 12_345), 'owner-gone');
    const next = store.claimNew(entry(id), 'owner-new');
    expect(next.sessionId).toBe(id);
    store.release(next);
    store.close();
  });

  it('uses a two-phase resume reservation with one winner', async () => {
    const { root, store } = await fixture();
    const id = '2026-08-08/sess_resume';
    const transcript = path.join(root, 'sessions', `${id}.jsonl`);
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    await fs.writeFile(
      transcript,
      `${JSON.stringify({ type: 'session_start', ts: new Date().toISOString(), id, model: 'm', provider: 'p' })}\n`,
    );
    store.rebuildCatalog();
    const reservation = store.reserveResume(id, 'owner-a');
    expect(() => store.reserveResume(id, 'owner-b')).toThrow(/already reserved/);
    const credential = store.activateReservation(reservation, entry(id));
    expect(store.getLive(id)?.sessionId).toBe(id);
    expect(() => store.activateReservation(reservation, entry(id))).toThrow(/expired|owned/);
    store.release(credential);
    store.close();
  });

  it('renews a reservation so slow hydration cannot outlive its own claim', async () => {
    // A resume reserves BEFORE it knows how long opening the transcript takes,
    // and the default window is 15s. Journals in the field reach 131 MB and
    // hydration also waits on this daemon, so without renewal `activate` fails
    // with "reservation expired" after all the expensive work already
    // succeeded — and the caller rolls back to a blank screen.
    const { root, store } = await fixture();
    const id = '2026-08-08/sess_renew';
    const transcript = path.join(root, 'sessions', `${id}.jsonl`);
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    await fs.writeFile(
      transcript,
      `${JSON.stringify({ type: 'session_start', ts: new Date().toISOString(), id, model: 'm', provider: 'p' })}
`,
    );
    store.rebuildCatalog();

    // Reserve with the shortest window we can, then push it out.
    const reservation = store.reserveResume(id, 'owner-a', undefined, 1);
    const renewed = store.renewReservation(reservation.reservationId, 'owner-a', 60_000);
    expect(renewed.reservationId).toBe(reservation.reservationId);
    expect(renewed.targetSessionId).toBe(id);
    expect(renewed.expiresAt).toBeGreaterThan(reservation.expiresAt);

    // Renewal is not a back door: only the holder can extend it.
    expect(() => store.renewReservation(reservation.reservationId, 'owner-b')).toThrow(
      /not owned by this requester/,
    );
    expect(() => store.renewReservation('no-such-reservation', 'owner-a')).toThrow(
      /not owned by this requester/,
    );

    // The renewed reservation still activates — that is the whole point.
    const credential = store.activateReservation(renewed, entry(id));
    expect(store.getLive(id)?.sessionId).toBe(id);
    // Settled reservations are gone; renewing one is an error, not a no-op
    // that silently resurrects a claim someone else may now hold.
    expect(() => store.renewReservation(reservation.reservationId, 'owner-a')).toThrow(
      /not owned by this requester/,
    );
    store.release(credential);
    store.close();
  });

  it('refuses to renew a reservation that already expired', async () => {
    const { root, store } = await fixture();
    const id = '2026-08-08/sess_renew_late';
    const transcript = path.join(root, 'sessions', `${id}.jsonl`);
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    await fs.writeFile(
      transcript,
      `${JSON.stringify({ type: 'session_start', ts: new Date().toISOString(), id, model: 'm', provider: 'p' })}
`,
    );
    store.rebuildCatalog();
    // 1000ms is the floor `boundedMs` enforces — the shortest window the
    // store will hand out, and short enough to expire inside a test.
    const reservation = store.reserveResume(id, 'owner-a', undefined, 1_000);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    // "expired" and "not yours" are deliberately distinguishable: the caller
    // needs to know whether it lost a race or was too slow.
    expect(() => store.renewReservation(reservation.reservationId, 'owner-a')).toThrow(/expired/);
    store.close();
  });

  it('scrubs and bounds revisioned agent presence before projection', async () => {
    const { store } = await fixture();
    const id = '2026-08-08/sess_presence';
    const credential = store.claimNew(entry(id), 'owner-a');
    const partialText = `sk-proj-${'A'.repeat(30)} ${'x'.repeat(7_000)}`;
    expect(
      store.publishAgents(credential, 1, [
        {
          id: 'leader',
          name: 'leader',
          status: 'streaming',
          iterations: 1,
          toolCalls: 0,
          partialText,
          lastActivityAt: new Date().toISOString(),
        },
      ]),
    ).toEqual({ accepted: true, revision: 1 });
    expect(store.publishAgents(credential, 1, [])).toEqual({ accepted: false, revision: 1 });
    const projected = store.getLive(id)?.agents[0]?.partialText ?? '';
    expect(projected).not.toContain('sk-proj-');
    expect(projected).toContain('[REDACTED:openai_key]');
    expect(projected.length).toBeLessThanOrEqual(6_001);
    store.release(credential);
    store.close();
  });

  it('rebuilds catalog rows from transcript authority and persists lease proof across reopen', async () => {
    const { root, store } = await fixture();
    const id = '2026-08-08/sess_rebuild';
    const transcript = path.join(root, 'sessions', `${id}.jsonl`);
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    await fs.writeFile(
      transcript,
      [
        {
          type: 'session_start',
          ts: '2026-08-08T10:00:00.000Z',
          id,
          model: 'model-a',
          provider: 'provider-a',
        },
        { type: 'session_end', ts: '2026-08-08T10:01:00.000Z', usage: { input: 1, output: 2 } },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n'),
    );
    expect(store.rebuildCatalog()).toEqual({ indexed: 1, damaged: 0 });
    expect(store.resolveId('sess_rebuild')).toBe(id);
    expect(store.getSummary(id)?.model).toBe('model-a');
    const credential = store.claimNew(entry(id), 'owner-a');
    store.close();

    const reopened = new SessionCatalogStore(root);
    expect(reopened.reconnectLease(credential).sessionId).toBe(id);
    reopened.release(credential);
    reopened.close();
  });

  it('quarantines a corrupt catalog database without deleting transcript authority', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-session-catalog-corrupt-'));
    roots.push(root);
    const sessionsDir = path.join(root, 'sessions');
    const id = '2026-08-08/sess_survives_corruption';
    const transcript = path.join(sessionsDir, `${id}.jsonl`);
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    await fs.writeFile(path.join(sessionsDir, 'catalog.sqlite'), 'not a sqlite database');
    await fs.writeFile(
      transcript,
      `${JSON.stringify({ type: 'session_start', ts: '2026-08-08T10:00:00.000Z', id, model: 'm', provider: 'p' })}\n`,
    );

    const store = new SessionCatalogStore(root);
    expect(store.getSummary(id)?.id).toBe(id);
    expect(await fs.readFile(transcript, 'utf8')).toContain('session_start');
    const files = await fs.readdir(sessionsDir);
    expect(files.some((file) => file.startsWith('catalog.sqlite.corrupt-'))).toBe(true);
    store.close();
  });

  it('applies catalog filters before the page limit', async () => {
    const { store } = await fixture();
    for (let index = 0; index < 105; index++) {
      store.upsertSummary({
        id: `2026-08-09/sess_other_${String(index).padStart(3, '0')}`,
        title: `Other ${index}`,
        startedAt: `2026-08-09T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
        lastActivityAt: `2026-08-09T13:${String(index % 60).padStart(2, '0')}:00.000Z`,
        model: 'other-model',
        provider: 'other-provider',
        tokenTotal: 10,
      });
    }
    const targetId = '2026-08-08/sess_filtered_target';
    store.upsertSummary({
      id: targetId,
      title: 'Literal 100% target_name',
      startedAt: '2026-08-08T10:00:00.000Z',
      endedAt: '2026-08-08T11:00:00.000Z',
      model: 'target-model',
      provider: 'target-provider',
      tokenTotal: 5_000,
    });

    expect(
      store.listCatalog({
        limit: 1,
        provider: 'target-provider',
        model: 'target-model',
        minTokens: 1_000,
        until: '2026-08-08T23:59:59.999Z',
      }),
    ).toEqual([expect.objectContaining({ id: targetId })]);
    expect(store.listCatalog({ search: '100%' })).toEqual([
      expect.objectContaining({ id: targetId }),
    ]);
    expect(store.listCatalog({ search: 'target_' })).toEqual([
      expect.objectContaining({ id: targetId }),
    ]);
    store.close();
  });

  // Regression: `clampListLimit` (storage/session-store/list-sessions.ts)
  // normalizes an untrusted caller limit so 0 and negative BOTH mean an empty
  // page — documented as "matching the catalog RPC's bounded limit" and pinned
  // by tests/storage/session-store-list-limit.test.ts. This RPC clamped to a
  // floor of 1 instead, so `sessionStore.list(0)` answered with the single
  // NEWEST session when the catalog daemon was up and with nothing when it was
  // not — the same call returned different rows depending on the backend.
  it('treats limit 0 and negative limits as an empty page (backend parity)', async () => {
    const { store } = await fixture();
    for (let i = 0; i < 3; i++) {
      store.upsertSummary({
        id: `2026-08-08/sess_page_${i}`,
        title: `page ${i}`,
        model: 'page-model',
        provider: 'page-provider',
        tokenTotal: i,
        startedAt: `2026-08-08T0${i}:00:00.000Z`,
        lastActivityAt: `2026-08-08T0${i}:00:00.000Z`,
      });
    }

    // The control: a positive limit is still honored (newest first).
    expect(store.listCatalog({ limit: 2 })).toHaveLength(2);
    expect(store.listCatalog({ limit: 3 })).toHaveLength(3);
    expect(store.listCatalog()).toHaveLength(3);

    // The contract: 0 and negative are an empty page, never a 1-row page.
    expect(store.listCatalog({ limit: 0 })).toEqual([]);
    expect(store.listCatalog({ limit: -1 })).toEqual([]);
    store.close();
  });

  // Regression: `titleContains` answered differently depending on which backend
  // served it. This RPC filtered with `json_extract(summary_json,'$.title') LIKE ?`
  // and left the title's case to SQLite, whose LIKE/LOWER fold ASCII ONLY — so a
  // title holding non-ASCII uppercase letters could miss a lowercase needle.
  // The catalog must agree with the JS filter in every host locale, including
  // locales where U+0130 folds to two code points rather than plain ASCII 'i'.
  it('titleContains matches a non-ASCII title the way the in-process filters do', async () => {
    const { store } = await fixture();
    store.upsertSummary({
      id: '2026-08-08/sess_dotted_i',
      title: 'İstanbul ÉCOLE deploy notes',
      model: 'm',
      provider: 'p',
      tokenTotal: 0,
      startedAt: '2026-08-08T00:00:00.000Z',
      lastActivityAt: '2026-08-08T00:00:00.000Z',
    });

    // The control: ASCII titles keep matching on both casings.
    expect(store.listCatalog({ titleContains: 'deploy' })).toHaveLength(1);

    // É exercises Unicode folding in both English and Turkish host locales.
    expect(store.listCatalog({ titleContains: 'école' })).toHaveLength(1);
    const summary = store.listCatalog({})[0]!;
    for (const titleContains of ['İstanbul', 'istanbul', 'STANBUL']) {
      expect(store.listCatalog({ titleContains })).toHaveLength(
        matchesSessionFilter(summary, { titleContains }) ? 1 : 0,
      );
    }

    // Still a real substring filter, not a match-everything fallback.
    expect(store.listCatalog({ titleContains: 'zzzz-absent' })).toHaveLength(0);
    store.close();
  });

  it('excludes maintenance while live and deletes only with an exact maintenance lease', async () => {
    const { root, store } = await fixture();
    const id = '2026-08-08/sess_delete';
    const transcript = path.join(root, 'sessions', `${id}.jsonl`);
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    await fs.writeFile(
      transcript,
      `${JSON.stringify({ type: 'session_start', ts: '2026-08-08T10:00:00.000Z', id, model: 'm', provider: 'p' })}\n`,
    );
    store.rebuildCatalog();
    const live = store.claimNew(entry(id), 'owner-a');
    expect(() => store.acquireMaintenance(id, 'delete', 'maintainer')).toThrow(/live/);
    store.release(live);
    const lease = store.acquireMaintenance(id, 'delete', 'maintainer');
    expect(() => store.delete(id, { ...lease, leaseId: 'wrong' })).toThrow(/valid delete/);
    store.delete(id, lease);
    expect(store.getSummary(id)).toBeNull();
    await expect(fs.stat(transcript)).rejects.toMatchObject({ code: 'ENOENT' });
    store.close();
  });

  it('does not prune a session recorded before its transcript reached disk', async () => {
    const { root, store } = await fixture();
    const summary = (id: string) => ({
      id,
      title: id,
      startedAt: '2026-09-25T00:00:00.000Z',
      model: 'm',
      provider: 'p',
      tokenTotal: 0,
      lastActivityAt: '2026-09-25T00:00:00.000Z',
    });
    // Just created, then the process died before the first write: mtime 0.
    const fresh = '2026-09-25/sess_fresh';
    store.upsertSummary(summary(fresh), `${fresh}.jsonl`, `${fresh}.summary.json`);
    // Genuinely old.
    const old = '2026-06-01/sess_old';
    const transcript = path.join(root, 'sessions', `${old}.jsonl`);
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    await fs.writeFile(transcript, '');
    const longAgo = new Date(Date.now() - 90 * 86_400_000);
    await fs.utimes(transcript, longAgo, longAgo);
    store.upsertSummary(summary(old), `${old}.jsonl`, `${old}.summary.json`);

    expect(store.prune(30, 'maintainer')).toBe(1);
    expect(store.getSummary(old)).toBeNull();
    expect(store.getSummary(fresh)).not.toBeNull();
    store.close();
  });

  it('allows non-destructive maintenance from the owning pid but rejects foreign pids', async () => {
    const { store } = await fixture();
    const id = '2026-08-08/sess_self_vs_foreign';

    // Same pid as the test process → /clear path. Non-destructive ops
    // must succeed even though claimNew has already taken a lease.
    const self = store.claimNew(entry(id), 'owner-a');
    const clearLease = store.acquireMaintenance(id, 'clear', 'self');
    expect(clearLease.operation).toBe('clear');
    store.releaseMaintenance(clearLease);
    const rewindLease = store.acquireMaintenance(id, 'rewind', 'self');
    expect(rewindLease.operation).toBe('rewind');
    store.releaseMaintenance(rewindLease);
    // delete is still strict even for the owning pid — preserve the
    // safety guarantee that a live writer cannot have its JSONL yanked.
    expect(() => store.acquireMaintenance(id, 'delete', 'self')).toThrow(/live/);
    store.release(self);

    // Foreign pid (a live process other than this one; a dead pid's lease
    // is reaped on sight). All operations,
    // including non-destructive ones, must be rejected with /live/.
    const foreign = store.claimNew(entry(id, process.ppid), 'owner-foreign');
    expect(() => store.acquireMaintenance(id, 'clear', 'self')).toThrow(/live/);
    expect(() => store.acquireMaintenance(id, 'rewind', 'self')).toThrow(/live/);
    expect(() => store.acquireMaintenance(id, 'truncate', 'self')).toThrow(/live/);
    expect(() => store.acquireMaintenance(id, 'delete', 'self')).toThrow(/live/);
    store.release(foreign);
    store.close();
  });

  it('recognises the session owner by the caller pid, not the store process pid', async () => {
    // Regression: in the built runtime this store lives inside the detached
    // project-catalog daemon, so `process.pid` is the daemon's. Without an
    // explicit caller pid every lease looked foreign and `/clear` failed with
    // "Session … is live" at an idle prompt with nothing running.
    const { store } = await fixture();
    const id = '2026-08-08/sess_daemon_hosted';
    // The TUI: a different, live process (a dead owner's lease is reaped).
    const ownerPid = process.ppid;
    const live = store.claimNew(entry(id, ownerPid), 'owner-tui');

    // Daemon's own pid → the lease is genuinely foreign.
    expect(() => store.acquireMaintenance(id, 'clear', 'holder')).toThrow(/live/);
    // Some third process → still foreign.
    expect(() => store.acquireMaintenance(id, 'clear', 'holder', undefined, 12_345)).toThrow(
      /live/,
    );

    // The lease owner itself → non-destructive maintenance is granted.
    const clearLease = store.acquireMaintenance(id, 'clear', 'holder', undefined, ownerPid);
    expect(clearLease.operation).toBe('clear');
    store.releaseMaintenance(clearLease);
    // `delete` stays strict even for the owner.
    expect(() => store.acquireMaintenance(id, 'delete', 'holder', undefined, ownerPid)).toThrow(
      /live/,
    );

    store.release(live);
    store.close();
  });

  it('preserves terminal closing status when heartbeat is called with an explicit status', async () => {
    const { store } = await fixture();
    const id = '2026-08-08/sess_closing_terminal';
    const cred = store.claimNew(entry(id), 'owner-a');
    store.markClosing(cred);
    expect(store.getLive(id)?.status).toBe('closing');

    store.heartbeat(cred, 'active');
    expect(store.getLive(id)?.status).toBe('closing');

    store.release(cred);
    store.close();
  });

  it('preserves terminal closing status across lease expiry reaping so heartbeats cannot resurrect it', async () => {
    const { store } = await fixture();
    const id = '2026-08-08/sess_closing_expired';
    const cred = store.claimNew(entry(id), 'owner-a', 1_000);
    store.markClosing(cred);
    await new Promise((resolve) => setTimeout(resolve, 1_050));

    expect(store.getLive(id)?.status).toBe('closing');
    store.heartbeat(cred, 'active');
    expect(store.getLive(id)?.status).toBe('closing');

    store.release(cred);
    store.close();
  });
});

describe('SessionCatalogStore — auto-rebuild ignores sidecar-only directories', () => {
  function readCatalogMeta(root: string): { reconciliation?: string; generation: number } {
    const DatabaseSync = loadDatabaseSync();
    const db = new DatabaseSync(path.join(root, 'sessions', 'catalog.sqlite'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT key, value FROM catalog_meta').all() as Array<{
        key: string;
        value: string;
      }>;
      const meta = new Map(rows.map((row) => [row.key, row.value]));
      return {
        ...(meta.has('last_reconciliation')
          ? { reconciliation: meta.get('last_reconciliation') as string }
          : {}),
        generation: Number(meta.get('generation') ?? '0'),
      };
    } finally {
      db.close();
    }
  }

  async function projectWithSessions(files: Record<string, string>): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-session-catalog-rebuild-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'sessions'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(root, 'sessions', name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
    }
    return root;
  }

  it('does not rebuild when only the mailbox and session sidecars remain', async () => {
    // `_mailbox.jsonl` and the `.audit.jsonl` / `.annotations.jsonl` sidecars
    // are not transcripts. Counting them rebuilt the whole catalog on every
    // open (writing last_reconciliation and bumping the generation clients
    // watch) once every session had been deleted.
    const root = await projectWithSessions({
      '_mailbox.jsonl': `${JSON.stringify({ id: 'm1' })}\n`,
      '2026-01-01/sess_gone.audit.jsonl': `${JSON.stringify({ tool: 'x' })}\n`,
      '2026-01-01/sess_gone.annotations.jsonl': `${JSON.stringify({ note: 'x' })}\n`,
    });
    new SessionCatalogStore(root).close();
    const meta = readCatalogMeta(root);
    expect(meta.reconciliation).toBeUndefined();
    expect(meta.generation).toBe(0);
  });

  it('still rebuilds when a real transcript is on disk', async () => {
    const root = await projectWithSessions({
      'sess_a.jsonl': `${JSON.stringify({
        type: 'session_start',
        ts: '2026-01-01T00:00:00.000Z',
        model: 'model-a',
        provider: 'provider-a',
      })}\n`,
    });
    new SessionCatalogStore(root).close();
    expect(readCatalogMeta(root).reconciliation).toBeDefined();
  });

  it('still rebuilds from a cold (.jsonl.gz) transcript', async () => {
    const root = await projectWithSessions({ 'sess_cold.jsonl.gz': 'not-really-gzip' });
    new SessionCatalogStore(root).close();
    expect(readCatalogMeta(root).reconciliation).toBeDefined();
  });
});
