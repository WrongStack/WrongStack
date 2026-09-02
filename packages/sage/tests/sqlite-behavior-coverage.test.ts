import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';
import type { Sage } from '../src/types.js';

let directory: string;
let stores: SqliteSageStore[];

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-sage-behavior-'));
  stores = [];
});

afterEach(async () => {
  for (const store of stores) store.close();
  await fs.rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function createStore(overrides: Record<string, unknown> = {}): SqliteSageStore {
  const value = new SqliteSageStore({ projectRoot: directory, ...overrides });
  stores.push(value);
  return value;
}

function internals(store: SqliteSageStore): {
  db: DatabaseSync;
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  runMutation: <T>(work: () => T) => Promise<T>;
  upsertMemory: (memory: Sage) => void;
  syncAnchorEdges: (memory: Sage) => void;
  auditWritesSincePrune: number;
} {
  return store as never;
}

function sage(id: string, overrides: Partial<Sage> = {}): Sage {
  return {
    id,
    revision: 1,
    status: 'active',
    kind: 'fact',
    scope: 'project',
    text: `memory ${id}`,
    importance: 0.8,
    confidence: 0.8,
    freshness: 1,
    tags: [],
    anchors: [],
    sources: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function put(store: SqliteSageStore, memory: Sage, sync = true): void {
  internals(store).upsertMemory(memory);
  if (sync) internals(store).syncAnchorEdges(memory);
}

describe('SQLite defensive and lifecycle completion coverage', () => {
  it('cleans initialization failures with and without a partially opened handle', async () => {
    const beforeOpen = createStore();
    const beforeState = beforeOpen as unknown as {
      initializeOnce: () => Promise<void>;
    };
    beforeState.initializeOnce = async () => {
      throw new Error('failed before open');
    };
    await expect(beforeOpen.initialize()).rejects.toThrow('failed before open');

    const afterOpen = createStore();
    const afterState = afterOpen as unknown as {
      db: { close: () => void };
      initializeOnce: () => Promise<void>;
    };
    afterState.db = {
      close: () => {
        throw new Error('close failed');
      },
    };
    afterState.initializeOnce = async () => {
      throw new Error('failed after open');
    };
    await expect(afterOpen.initialize()).rejects.toThrow('failed after open');
  });

  it('handles malformed and cross-scope legacy rows in forget, consolidate, and list', async () => {
    const store = createStore();
    await store.initialize();
    const state = internals(store);
    const originalStmt = state.stmt.bind(store);
    const first = sage('first', {
      text: 'duplicate legacy',
      legacyScope: 'project-memory',
      createdAt: '2026-02-01T00:00:00.000Z',
      tags: ['legacy'],
    });
    const second = sage('second', {
      text: 'duplicate legacy',
      scope: 'user',
      legacyScope: 'project-memory',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const wrong = sage('wrong', {
      text: 'duplicate legacy',
      legacyScope: 'user-memory',
    });
    const noSortFields = sage('no-sort', {
      legacyScope: 'project-memory',
      createdAt: undefined as never,
    });
    const derivedScope = sage('derived-scope', {
      text: 'fallback scope query',
      legacyScope: undefined,
    });
    const missingIdA = { ...sage('missing-a', { legacyScope: 'project-memory' }) };
    const missingIdB = { ...sage('missing-b', { legacyScope: 'project-memory' }) };
    delete (missingIdA as Partial<Sage>).id;
    delete (missingIdB as Partial<Sage>).id;
    const rows = [
      { data: '{broken' },
      { data: JSON.stringify(first) },
      { data: JSON.stringify(wrong) },
      { data: JSON.stringify(noSortFields) },
      { data: JSON.stringify(derivedScope) },
      { data: JSON.stringify(missingIdA) },
      { data: JSON.stringify(missingIdB) },
    ];
    const scopedRows = [...rows, { data: JSON.stringify(second) }, { data: '{broken' }];
    (state as unknown as { stmt: typeof state.stmt }).stmt = ((sql: string) => {
      if (sql.includes('scope = ? OR legacy_scope = ?')) {
        return { all: () => scopedRows } as never;
      }
      return originalStmt(sql);
    }) as never;

    await expect(store.forget('does-not-match')).resolves.toBe(0);
    await expect(store.forget('fallback scope query')).resolves.toBe(1);
    await expect(store.consolidate('project-memory')).resolves.toBeUndefined();
    const listed = await store.list('project-memory');
    expect(listed.map((entry) => entry.text)).toEqual(expect.arrayContaining(['duplicate legacy']));
    await expect(store.readAll()).resolves.toEqual(expect.any(String));

    put(
      store,
      sage('scope-mismatch', {
        scope: 'project',
        legacyScope: 'user-memory',
      }),
    );
    put(store, sage('derived-clear-scope', { legacyScope: undefined }));
    await expect(store.clear('project-memory')).resolves.toBeUndefined();
    await expect(store.clear('project-agents')).resolves.toBeUndefined();
    await expect(store.listMemories({ status: 'all', limit: 0 })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'scope-mismatch' })]),
    );
  });

  it('returns no search results for an explicit empty status filter', async () => {
    const store = createStore();
    await store.rememberSage({ text: 'empty status filter should not match' });

    await expect(store.searchSage('', { includeStatuses: [] })).resolves.toEqual([]);
    await expect(store.searchSage('empty status filter', { includeStatuses: [] })).resolves.toEqual(
      [],
    );
  });

  it('exercises path fallbacks, relationship expansion, and audience corruption guards', async () => {
    const store = createStore();
    await store.initialize();
    const seed = sage('seed', {
      text: 'seed relation',
      tags: ['shared'],
      anchors: [
        { type: 'file', path: 'src/deep/file.ts' },
        { type: 'command', command: 'PNPM test unit' },
        { type: 'file' },
      ],
    });
    const sibling = sage('sibling', {
      text: 'sibling relation',
      tags: ['shared'],
      anchors: [
        { type: 'directory', path: 'src' },
        { type: 'command', command: 'pnpm test integration' },
      ],
    });
    const audience = sage('audience', {
      text: 'audience relation',
      anchors: [{ type: 'file', path: 'src/fallback.ts' }],
      audience: { roles: ['reviewer'] },
    });
    put(store, seed);
    put(store, sibling);
    put(store, audience);
    await store.addGraphEdge('mem:seed', 'not-a-command-node', 'about_command');
    await store.addGraphEdge('mem:seed', 'mem:sibling', 'related_to');

    expect(await store.findRelatedSage([])).toEqual([]);
    expect(await store.findRelatedSage(['missing'])).toEqual([]);
    expect((await store.findRelatedSage(['seed'], { limit: 10 })).map((item) => item.id)).toContain(
      'sibling',
    );
    expect(
      (await store.findRelatedSage(['seed'], { includeAudienceScoped: false })).map(
        (item) => item.id,
      ),
    ).toContain('sibling');

    internals(store).db.prepare("DELETE FROM edges WHERE from_node = 'mem:audience'").run();
    expect(
      await store.retrieveForPath(['src/fallback.ts'], {
        path: 'src/fallback.ts',
        includeAudienceScoped: false,
        includeAncestors: false,
      }),
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'audience' })]));

    const corruptAudience = sage('corrupt-audience', { text: 'column only audience' });
    put(store, corruptAudience, false);
    internals(store)
      .db.prepare('UPDATE memories SET audience = ? WHERE id = ?')
      .run('reviewer', corruptAudience.id);
    expect(await store.retrieveForAudience({ role: 'reviewer' })).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: corruptAudience.id })]),
    );

    expect(await store.traverseGraph(['mem:seed', 'mem:sibling'], { maxDepth: 2 })).toEqual(
      expect.any(Array),
    );
    expect(await store.graphFor('seed relation')).toEqual(expect.any(Array));

    internals(store).db.exec('DROP TRIGGER IF EXISTS memories_au');
    internals(store)
      .db.prepare('UPDATE memories SET data = ? WHERE id = ?')
      .run('{broken', corruptAudience.id);
    await expect(store.searchSage('')).resolves.toEqual(expect.any(Array));
    await expect(store.retrieveForAudience({ role: 'reviewer' })).resolves.toEqual(
      expect.any(Array),
    );
    await expect(store.listSagePage()).resolves.toMatchObject({ memories: expect.any(Array) });
    await expect(store.listSage()).resolves.toEqual(expect.any(Array));
    await expect(store.verify()).resolves.toEqual(expect.any(Array));
  });

  it('verifies active, stale, terminal, anchorless, and unverified memories', async () => {
    const store = createStore();
    await store.initialize();
    await fs.mkdir(path.join(directory, 'src'), { recursive: true });
    await fs.writeFile(path.join(directory, 'src', 'exists.ts'), 'export {};');

    for (const value of [
      sage('active-existing', { anchors: [{ type: 'file', path: 'src/exists.ts' }] }),
      sage('active-missing', { anchors: [{ type: 'file', path: 'src/missing.ts' }] }),
      sage('stale-existing', {
        status: 'stale',
        anchors: [{ type: 'file', path: 'src/exists.ts' }],
      }),
      sage('archived-existing', {
        status: 'archived',
        anchors: [{ type: 'file', path: 'src/exists.ts' }],
      }),
      sage('unverified-command', {
        anchors: [{ type: 'command', command: 'pnpm test' }],
      }),
      sage('anchorless'),
    ]) {
      put(store, value);
    }

    const results = await store.verify();
    expect(results).toHaveLength(6);
    expect(await store.getSage('active-missing')).toMatchObject({ status: 'stale' });
    expect(await store.getSage('stale-existing')).toMatchObject({ status: 'active' });
    expect(await store.getSage('archived-existing')).toMatchObject({ status: 'archived' });

    const state = internals(store);
    const originalRunMutation = state.runMutation.bind(store);
    state.runMutation = (async <T>(work: () => T): Promise<T> => {
      const current = await store.getSage('active-existing');
      put(store, { ...current!, status: 'archived' });
      return work();
    }) as never;
    await expect(store.verify('active-existing')).resolves.toHaveLength(1);
    state.runMutation = originalRunMutation;
    expect(await store.getSage('active-existing')).toMatchObject({ status: 'archived' });

    put(store, sage('concurrent-edit', { anchors: [{ type: 'file', path: 'src/exists.ts' }] }));
    state.runMutation = (async <T>(work: () => T): Promise<T> => {
      const current = await store.getSage('concurrent-edit');
      put(store, {
        ...current!,
        revision: current!.revision + 1,
        text: 'edited while anchors were being verified',
        tags: ['concurrent'],
      });
      return work();
    }) as never;
    await expect(store.verify('concurrent-edit')).resolves.toHaveLength(1);
    state.runMutation = originalRunMutation;
    expect(await store.getSage('concurrent-edit')).toMatchObject({
      revision: 3,
      text: 'edited while anchors were being verified',
      tags: ['concurrent'],
      lastVerifiedAt: expect.any(String),
      freshness: 1,
    });

    put(
      store,
      sage('concurrent-anchor-edit', {
        anchors: [{ type: 'file', path: 'src/exists.ts' }],
      }),
    );
    state.runMutation = (async <T>(work: () => T): Promise<T> => {
      const current = await store.getSage('concurrent-anchor-edit');
      put(store, {
        ...current!,
        revision: current!.revision + 1,
        freshness: 0.4,
        anchors: [{ type: 'file', path: 'src/replaced.ts' }],
      });
      return work();
    }) as never;
    await expect(store.verify('concurrent-anchor-edit')).resolves.toHaveLength(1);
    state.runMutation = originalRunMutation;
    const concurrentAnchorEdit = await store.getSage('concurrent-anchor-edit');
    expect(concurrentAnchorEdit).toMatchObject({
      revision: 2,
      anchors: [{ type: 'file', path: 'src/replaced.ts' }],
      freshness: 0.4,
    });
    expect(concurrentAnchorEdit).not.toHaveProperty('lastVerifiedAt');

    await expect(store.verify('anchorless')).resolves.toHaveLength(1);

    put(store, sage('vanishing', { anchors: [{ type: 'file', path: 'src/exists.ts' }] }));
    state.runMutation = (async <T>(work: () => T): Promise<T> => {
      state.db.prepare('DELETE FROM memories WHERE id = ?').run('vanishing');
      return work();
    }) as never;
    await expect(store.verify('vanishing')).resolves.toHaveLength(1);
    state.runMutation = originalRunMutation;

    const controller = new AbortController();
    controller.abort();
    await expect(store.verify(undefined, controller.signal)).rejects.toThrow();
  });

  it('covers hygiene verification, dedup quality ordering, and every review rule', async () => {
    const now = new Date('2026-07-24T00:00:00.000Z');
    const store = createStore({ now: () => now });
    await store.initialize();
    await fs.mkdir(path.join(directory, 'src'), { recursive: true });
    await fs.writeFile(path.join(directory, 'src', 'exists.ts'), 'export {};');

    put(
      store,
      sage('dup-low', {
        text: 'hygiene duplicate',
        importance: 0.4,
        confidence: 0.9,
        anchors: [{ type: 'file', path: 'src/exists.ts' }],
        sources: [{ type: 'user' }],
      }),
    );
    put(
      store,
      sage('dup-high', {
        text: 'hygiene duplicate',
        importance: 0.9,
        confidence: 0.5,
        anchors: [
          { type: 'symbol', path: 'src/exists.ts', symbol: 'run' },
          { type: 'test', path: 'src/missing-test.ts' },
          { type: 'git', path: 'src/missing-git.ts' },
          { type: 'directory', path: 'src' },
          { type: 'command', command: 'pnpm test' },
        ],
        sources: [{ type: 'session', sessionId: 'session' }],
      }),
    );
    put(
      store,
      sage('dup-confidence', {
        text: 'hygiene duplicate',
        importance: 0.9,
        confidence: 0.4,
        createdAt: '2025-12-31T00:00:00.000Z',
      }),
    );
    put(
      store,
      sage('dup-created', {
        text: 'hygiene duplicate',
        importance: 0.9,
        confidence: 0.5,
        createdAt: '2025-01-01T00:00:00.000Z',
      }),
    );
    put(
      store,
      sage('session-expired', {
        scope: 'session',
        expiresAt: '2026-07-23T00:00:00.000Z',
      }),
    );
    put(store, sage('project-expired', { expiresAt: '2026-07-23T00:00:00.000Z' }));
    put(
      store,
      sage('unused', {
        injectionCount: 3,
        useCount: undefined,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    put(
      store,
      sage('stale-old', {
        status: 'stale',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    put(
      store,
      sage('low-confidence', {
        confidence: 0.2,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    put(
      store,
      sage('permanent-old', {
        confidence: 0.1,
        persistence: 'permanent',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    await store.createCandidate({
      text: 'existing review',
      targetMemoryId: 'low-confidence',
      scope: 'project',
    });
    await store.createCandidate({
      text: 'audience candidate',
      audience: { roles: ['reviewer'] },
    });
    await store.createCandidate({ text: 'pending without target' });
    internals(store).auditWritesSincePrune = 255;
    await store.recordUse([], 'trigger-prune');
    (internals(store) as unknown as { audit: (event: string) => void }).audit('without.data');
    internals(store)
      .db.prepare('INSERT INTO audit_log (event, at, trace_id, data) VALUES (?, ?, ?, ?)')
      .run('null.data', '2026', null, null);
    await store.readAudit();

    const report = await store.hygiene({
      retentionDays: 1,
      archiveLowConfidenceAfterDays: 1,
      archiveUnusedAfterDays: 1,
      unusedMinInjections: 3,
    });
    expect(report.deduplicated).toBeGreaterThan(0);
    // session-expired is soft-deleted by session GC (not a review candidate).
    expect(report.deleted).toBeGreaterThanOrEqual(1);
    // project-expired, unused, stale-old, low-confidence (existing candidate) → ≥3 new reviews
    expect(report.reviewCandidatesCreated).toBeGreaterThanOrEqual(3);
    expect(
      (await store.listCandidates()).some(
        (candidate) => candidate.targetMemoryId === 'permanent-old',
      ),
    ).toBe(false);
  });

  it('resolves candidate terminal states, mutation failures, and already-resolved forms', async () => {
    const store = createStore();
    await store.initialize();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = await store.rememberSage({ text: 'candidate target' });

    const deletion = await store.createCandidate({
      text: 'delete proposal',
      targetMemoryId: target.id,
    });
    const originalUpdate = store.updateSage.bind(store);
    vi.spyOn(store, 'updateSage').mockRejectedValueOnce(new Error('delete failed'));
    await expect(store.resolveCandidate(deletion.id, 'delete')).resolves.toMatchObject({
      applied: false,
    });

    const archival = await store.createCandidate({
      text: 'archive proposal',
      targetMemoryId: target.id,
    });
    vi.mocked(store.updateSage).mockRejectedValueOnce('archive failed');
    await expect(store.resolveCandidate(archival.id, 'archive')).resolves.toMatchObject({
      applied: false,
    });
    vi.mocked(store.updateSage).mockImplementation(originalUpdate);

    const keep = await store.createCandidate({ text: 'keep proposal', targetMemoryId: target.id });
    await expect(store.resolveCandidate(keep.id, 'keep')).resolves.toMatchObject({ applied: true });
    await expect(store.resolveCandidate(keep.id, 'keep')).resolves.toMatchObject({
      alreadyResolved: true,
      targetMemoryId: target.id,
    });

    const noTarget = await store.createCandidate({ text: 'no target proposal' });
    await expect(store.resolveCandidate(noTarget.id, 'keep')).resolves.toMatchObject({
      applied: true,
    });
    await expect(store.resolveCandidate(noTarget.id, 'keep')).resolves.toMatchObject({
      alreadyResolved: true,
    });

    const missingTarget = await store.createCandidate({
      text: 'missing target resolution',
      targetMemoryId: 'missing-target',
    });
    await expect(store.resolveCandidate(missingTarget.id, 'delete')).resolves.toMatchObject({
      applied: false,
    });

    const permanent = await store.rememberSage({
      text: 'permanent resolution target',
      persistence: 'permanent',
    });
    const permanentCandidate = await store.createCandidate({
      text: 'permanent delete proposal',
      targetMemoryId: permanent.id,
    });
    await expect(store.resolveCandidate(permanentCandidate.id, 'delete')).resolves.toMatchObject({
      applied: false,
    });

    const promotedDuringDelete = await store.rememberSage({
      text: 'promoted during candidate deletion',
    });
    const promotionRaceCandidate = await store.createCandidate({
      text: 'delete proposal racing permanent promotion',
      targetMemoryId: promotedDuringDelete.id,
    });
    vi.mocked(store.updateSage).mockImplementationOnce(async (id, input) => {
      const current = await store.getSage(id);
      put(store, { ...current!, persistence: 'permanent' });
      return originalUpdate(id, input);
    });
    // Candidate resolution is an authorized internal operation that passes
    // force:true, so the permanent-memory guard does not block it.
    const raceResult = await store.resolveCandidate(promotionRaceCandidate.id, 'delete');
    expect(raceResult).toBeDefined();
    expect(raceResult!.applied).toBe(true);
    // The target was deleted despite being promoted to permanent mid-flight.
    const deletedTarget = await store.getSage(promotedDuringDelete.id);
    expect(deletedTarget).not.toBeNull();
    expect(deletedTarget!.status).toBe('deleted');

    const raced = await store.createCandidate({
      text: 'raced resolution',
      targetMemoryId: target.id,
    });
    const state = internals(store);
    const originalRunMutation = state.runMutation.bind(store);
    let mutationCall = 0;
    state.runMutation = (async <T>(work: () => T): Promise<T> => {
      mutationCall++;
      if (mutationCall === 3) return false as T;
      return originalRunMutation(work);
    }) as never;
    await expect(store.resolveCandidate(raced.id, 'keep')).resolves.toMatchObject({
      applied: false,
      alreadyResolved: true,
    });
    state.runMutation = originalRunMutation;

    const noTargetRace = await store.createCandidate({ text: 'raced without target' });
    mutationCall = 0;
    state.runMutation = (async <T>(work: () => T): Promise<T> => {
      mutationCall++;
      if (mutationCall === 2) return false as T;
      return originalRunMutation(work);
    }) as never;
    await expect(store.resolveCandidate(noTargetRace.id, 'keep')).resolves.toMatchObject({
      applied: false,
      alreadyResolved: true,
    });
    state.runMutation = originalRunMutation;

    const deleteStringFailure = await store.createCandidate({
      text: 'delete string failure',
      targetMemoryId: target.id,
    });
    vi.mocked(store.updateSage).mockRejectedValueOnce('delete string');
    await store.resolveCandidate(deleteStringFailure.id, 'delete');
    const archiveErrorFailure = await store.createCandidate({
      text: 'archive error failure',
      targetMemoryId: target.id,
    });
    vi.mocked(store.updateSage).mockRejectedValueOnce(new Error('archive error'));
    await store.resolveCandidate(archiveErrorFailure.id, 'archive');
    vi.mocked(store.updateSage).mockImplementation(originalUpdate);

    const acceptRace = await store.createCandidate({ text: 'accept race candidate' });
    const originalStmt = state.stmt.bind(store);
    let candidateReads = 0;
    (state as unknown as { stmt: typeof state.stmt }).stmt = ((sql: string) => {
      if (sql === "SELECT data FROM candidates WHERE id = ? AND status = 'pending'") {
        const prepared = originalStmt(sql);
        return {
          get: (...args: unknown[]) =>
            candidateReads++ === 0
              ? (prepared.get as (...values: unknown[]) => unknown)(...args)
              : undefined,
        } as never;
      }
      return originalStmt(sql);
    }) as never;
    await expect(store.acceptCandidate(acceptRace.id)).resolves.toEqual(expect.any(Object));
    (state as unknown as { stmt: typeof state.stmt }).stmt = originalStmt;

    const rowState = state as unknown as {
      rowToMemory: (row: { data: string }) => Sage;
    };
    const originalRowToMemory = rowState.rowToMemory.bind(store);
    rowState.rowToMemory = () => {
      throw 'row failure';
    };
    await expect(store.getSage(target.id)).resolves.toBeNull();
    rowState.rowToMemory = originalRowToMemory;
    expect(console.warn).toHaveBeenCalledTimes(6);
  });

  it('cleans independent reference shapes and considers project candidates in consolidation', async () => {
    const store = createStore();
    await store.initialize();
    const target = await store.rememberSage({ text: 'reference target' });
    for (const value of [
      sage('only-supersedes', { supersedes: [target.id] }),
      sage('only-contradicts', { contradicts: [target.id] }),
      sage('only-superseded-by', { supersededBy: target.id }),
    ]) {
      put(store, value);
    }
    await store.deleteSage(target.id, 'cleanup', { force: true });
    expect(await store.getSage('only-supersedes')).not.toHaveProperty('contradicts');
    expect(await store.getSage('only-contradicts')).not.toHaveProperty('supersededBy');

    await store.createCandidate({ text: 'project dedup', scope: 'project' });
    await store.createCandidate({ text: 'user candidate', scope: 'user' });
    await expect(
      store.consolidateSession({
        sessionId: 'session',
        facts: [
          { text: 'project dedup', confidence: 0.9, importance: 0.8 },
          { text: 'new consolidation memory', confidence: 0.9, importance: 0.8 },
        ],
      } as never),
    ).resolves.toEqual(expect.any(Object));

    const events = { emit: vi.fn() };
    const eventStore = createStore({ events: events as never, traceId: 'trace' });
    await eventStore.initialize();
    put(eventStore, sage('default-persistence'));
    await expect(eventStore.search('default-persistence')).resolves.toHaveLength(1);
    await eventStore.deleteSage('default-persistence', 'default persistence', { force: true });
    put(eventStore, sage('never-events'));
    await eventStore.deleteSage('never-events', 'never events', {
      force: true,
      neverInject: true,
    });
    expect(events.emit).toHaveBeenCalled();
  });
});
