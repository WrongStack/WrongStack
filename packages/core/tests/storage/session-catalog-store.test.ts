import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionCatalogStore } from '../../src/session-catalog/store.js';
import type { SessionRegistryEntry } from '../../src/session-catalog/session-registry-types.js';

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

    // Foreign pid (simulated via entry(pid=999_999)). All operations,
    // including non-destructive ones, must be rejected with /live/.
    const foreign = store.claimNew(entry(id, 999_999), 'owner-foreign');
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
    const ownerPid = 999_999; // the TUI, a different process than this one
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
});
