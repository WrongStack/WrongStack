/**
 * VectorMemoryStore tests — no network, no model download.
 *
 * Uses FakeEmbeddingProvider for deterministic, reproducible vectors.
 * The temp directory is reused via WRONGSTACK_HOME; we just point the
 * store at a unique subdirectory per test.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VectorMemoryStoreOptions } from '../src/index.js';
import { encodeVector, type SageSyncSource, VectorMemoryStore } from '../src/index.js';
import { FakeEmbeddingProvider } from './fake-provider.js';

const testRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function makeStore(opts: Partial<VectorMemoryStoreOptions> = {}): VectorMemoryStore {
  const projectRoot = path.join(
    os.tmpdir(),
    `wrongstack-vm-${testRunId}-${Math.random().toString(36).slice(2, 8)}`,
  );
  return new VectorMemoryStore({
    provider: new FakeEmbeddingProvider({ dimensions: 64 }),
    projectRoot,
    ...opts,
  });
}

describe('VectorMemoryStore', () => {
  let store: VectorMemoryStore;

  beforeEach(() => {
    store = makeStore();
  });

  afterEach(() => {
    store.close();
  });

  it('remembers an entry and returns a stored vector', async () => {
    const entry = await store.remember({ text: 'hello world', tags: ['greeting'] });
    expect(entry.id).toBeTypeOf('string');
    expect(entry.text).toBe('hello world');
    expect(entry.tags).toEqual(['greeting']);
    expect(entry.vector).toBeDefined();
    expect(entry.vector?.length).toBe(64);
    expect(entry.providerId).toMatch(/^fake-v1-/);
  });

  it('keeps identical text independently recallable in each scope', async () => {
    const text = 'The same content has separate visibility in each scope';
    const project = await store.remember({ text, scope: 'project' });
    const user = await store.remember({ text, scope: 'user' });
    const session = await store.remember({ text, scope: 'session' });
    expect(new Set([project.id, user.id, session.id]).size).toBe(3);
    expect(new Set([project.contentHash, user.contentHash, session.contentHash]).size).toBe(1);
    expect((await store.remember({ text, scope: 'user' })).id).toBe(user.id);
    expect((await store.search(text, { scope: 'user' })).map((hit) => hit.entry.id)).toEqual([
      user.id,
    ]);
    expect((await store.search(text, { scope: 'session' })).map((hit) => hit.entry.id)).toEqual([
      session.id,
    ]);
    await store.forget(project.id);
    expect((await store.search(text, { scope: 'user' })).map((hit) => hit.entry.id)).toEqual([
      user.id,
    ]);
  });

  it('migrates the legacy global hash index when opening an existing database', async () => {
    const text = 'A memory already persisted before scoped deduplication';
    const project = await store.remember({ text, scope: 'project' });
    const projectRoot = path.resolve(store.directory, '..', '..');
    const db = (store as unknown as { db: { exec(sql: string): void } }).db;
    db.exec('DROP INDEX idx_entries_hash_scope');
    db.exec('CREATE UNIQUE INDEX idx_entries_hash ON entries(content_hash)');
    store.close();

    const reopened = new VectorMemoryStore({
      provider: new FakeEmbeddingProvider({ dimensions: 64 }),
      projectRoot,
    });
    try {
      expect(reopened.get(project.id)?.scope).toBe('project');
      const user = await reopened.remember({ text, scope: 'user' });
      expect(user.scope).toBe('user');
      expect(user.id).not.toBe(project.id);
      expect(reopened.findByContentHash(project.contentHash, 'project')?.id).toBe(project.id);
      expect(reopened.findByContentHash(project.contentHash, 'user')?.id).toBe(user.id);
    } finally {
      reopened.close();
    }
  });

  it('retrieves an entry by id with its vector', async () => {
    const created = await store.remember({ text: 'foo bar' });
    const fetched = store.get(created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.text).toBe('foo bar');
    expect(fetched?.vector).toBeDefined();
    expect(fetched?.vector?.length).toBe(64);
  });

  it('removes an entry on forget', async () => {
    const created = await store.remember({ text: 'delete me' });
    expect(await store.forget(created.id)).toBe(true);
    expect(store.get(created.id)).toBeUndefined();
  });

  it('returns false on forget for unknown id', async () => {
    expect(await store.forget('nonexistent-id')).toBe(false);
  });

  it('ranks search results by cosine similarity', async () => {
    await store.remember({ text: 'apple banana cherry' });
    await store.remember({ text: 'apple banana mango' });
    await store.remember({ text: 'completely unrelated text' });
    const hits = await store.search('apple banana', { limit: 5 });
    expect(hits.length).toBe(3);
    // Results should be sorted by score descending.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
    // Top hit should share the "apple banana" prefix.
    expect(hits[0]!.entry.text).toContain('apple');
  });

  it('filters by threshold', async () => {
    await store.remember({ text: 'apple banana cherry' });
    await store.remember({ text: 'completely unrelated text' });
    const hits = await store.search('apple banana', { threshold: 0.95 });
    // Threshold is strict — may drop all hits, that's fine.
    for (const h of hits) {
      expect(h.score).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('returns empty array for empty query', async () => {
    expect(await store.search('')).toEqual([]);
    expect(await store.search('   ')).toEqual([]);
  });

  it('lists entries sorted by updated_at descending', async () => {
    const a = await store.remember({ text: 'first' });
    // Ensure deterministic ordering — the second insert has a later timestamp.
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.remember({ text: 'second' });
    const list = store.list({ limit: 10 });
    expect(list.map((e) => e.id)).toEqual([b.id, a.id]);
  });

  it('reports stats with correct counts', async () => {
    await store.remember({ text: 'one' });
    await store.remember({ text: 'two' });
    await store.remember({ text: 'three' });
    const stats = store.stats();
    expect(stats.entries).toBe(3);
    expect(stats.vectors).toBe(3);
    expect(stats.providers).toContain(stats.modelId);
  });

  it('syncs active SAGE memories without duplicating', async () => {
    const sage: SageSyncSource = {
      listActiveMemories: async () => [
        { id: 'sage-1', text: 'shared fact', tags: ['sage'] },
        { id: 'sage-2', text: 'another fact' },
      ],
    };
    const report1 = await store.syncFromSage(sage);
    expect(report1.scanned).toBe(2);
    expect(report1.indexed).toBe(2);
    expect(report1.skipped).toBe(0);

    const report2 = await store.syncFromSage(sage);
    expect(report2.scanned).toBe(2);
    expect(report2.indexed).toBe(0);
    expect(report2.skipped).toBe(2);
  });

  it('syncs a project-scoped SAGE memory even when user scope has identical text', async () => {
    const text = 'A fact also stored privately by the user';
    const user = await store.remember({ text, scope: 'user' });
    const source: SageSyncSource = {
      listActiveMemories: async () => [{ id: 'sage-project', text }],
    };
    const report = await store.syncFromSage(source);
    expect(report).toMatchObject({ scanned: 1, indexed: 1, skipped: 0, failed: 0 });
    const project = store.findByContentHash(VectorMemoryStore.contentHash(text), 'project');
    expect(project?.scope).toBe('project');
    expect(project?.id).not.toBe(user.id);
    expect((await store.syncFromSage(source)).skipped).toBe(1);
  });

  it('serializes concurrent syncFromSage calls — no spurious UNIQUE failures', async () => {
    // Regression: syncFromSage used to run its dedup-check → INSERT pair
    // outside the host-OS file lock. Two concurrent syncs (e.g. two surfaces
    // force-syncing) both passed the pre-check across the `await embed()`
    // gap and the loser died on the UNIQUE (content_hash, scope) index — a spurious
    // partial-failure that kept the first-boot sync marker from completing.
    class LatentFakeProvider extends FakeEmbeddingProvider {
      override async embed(texts: string[]): Promise<Float32Array[]> {
        // Widen the async gap between the dedup check and the INSERT so the
        // interleaving two concurrent syncs race through is deterministic.
        await new Promise((resolve) => setTimeout(resolve, 2));
        return super.embed(texts);
      }
    }
    const projectRoot = path.join(
      os.tmpdir(),
      `wrongstack-vm-${testRunId}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const concurrentStore = new VectorMemoryStore({
      provider: new LatentFakeProvider({ dimensions: 64 }),
      projectRoot,
    });
    try {
      const sage: SageSyncSource = {
        listActiveMemories: async () => [
          { id: 'sage-1', text: 'shared fact', tags: ['sage'] },
          { id: 'sage-2', text: 'another fact' },
        ],
      };
      const [r1, r2] = await Promise.all([
        concurrentStore.syncFromSage(sage),
        concurrentStore.syncFromSage(sage),
      ]);
      expect(r1.failed).toBe(0);
      expect(r2.failed).toBe(0);
      expect([...r1.errors, ...r2.errors]).toEqual([]);
      const stats = concurrentStore.stats();
      expect(stats.entries).toBe(2);
      expect(stats.vectors).toBe(2);
    } finally {
      concurrentStore.close();
    }
  });

  it.each(['tags', 'summary', 'unchanged'] as const)(
    'rechecks the current SAGE mirror after a queued %s sync acquires the lock',
    async (mode) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const secondLock = Promise.withResolvers<void>();
      let blocked = false;
      class GatedProvider extends FakeEmbeddingProvider {
        override async embed(texts: string[]): Promise<Float32Array[]> {
          if (texts.includes('updated fact') && !blocked) {
            blocked = true;
            entered.resolve();
            await release.promise;
          }
          return super.embed(texts);
        }
      }
      const concurrentStore = makeStore({ provider: new GatedProvider() });
      const source = (tags: string[], summary?: string): SageSyncSource => ({
        listActiveMemories: async () => [
          { id: 'sage-1', text: 'updated fact', tags, ...(summary ? { summary } : {}) },
        ],
      });
      const pending: Array<Promise<unknown>> = [];
      try {
        await concurrentStore.remember({
          text: 'old fact',
          metadata: { source: 'sage', sageId: 'sage-1' },
        });
        const lockPath = concurrentStore.lockPath;
        let acquisitions = 0;
        Object.defineProperty(concurrentStore, 'lockPath', {
          get() {
            if (++acquisitions === 2) secondLock.resolve();
            return lockPath;
          },
        });
        const first = concurrentStore.syncFromSage(source(['first']));
        pending.push(first);
        await entered.promise;
        const second = concurrentStore.syncFromSage(
          source(
            mode === 'tags' ? ['second'] : ['first'],
            mode === 'summary' ? 'new summary' : undefined,
          ),
        );
        pending.push(second);
        await secondLock.promise;
        release.resolve();
        const reports = await Promise.all([first, second]);
        expect(reports.map((report) => report.failed)).toEqual([0, 0]);
        expect(concurrentStore.findBySageId('sage-1')).toMatchObject({
          text: 'updated fact',
          tags: mode === 'tags' ? ['second'] : ['first'],
          summary: mode === 'summary' ? 'new summary' : undefined,
        });
        expect(concurrentStore.stats().entries).toBe(1);
        if (mode === 'unchanged') expect(reports[1]?.skipped).toBe(1);
      } finally {
        release.resolve();
        await Promise.allSettled(pending);
        concurrentStore.close();
      }
    },
  );

  it('records the active provider id in schema_meta', () => {
    expect(store.activeProviderId).toMatch(/^fake-v1-/);
  });

  it('skips corrupted vectors that produce NaN cosine similarity in search', async () => {
    const valid = await store.remember({ text: 'valid entry to find' });
    const corrupted = await store.remember({ text: 'corrupted entry' });

    // Corrupt the vector blob for the second entry with NaNs
    const nanVector = new Float32Array(64).fill(Number.NaN);
    const db = (store as unknown as { db: any }).db;
    db.prepare('UPDATE vectors SET vector = ? WHERE entry_id = ?').run(
      encodeVector(nanVector),
      corrupted.id,
    );

    const hits = await store.search('valid entry', { limit: 10, threshold: 0.1 });
    expect(hits.map((h) => h.entry.id)).toContain(valid.id);
    expect(hits.map((h) => h.entry.id)).not.toContain(corrupted.id);
    expect(hits.every((h) => Number.isFinite(h.score))).toBe(true);
  });

  it('serves the sageId lookup from an index, not a full entries scan', async () => {
    // Contract under test: `findBySageId` documents `json_extract(metadata,
    // '$.sageId')` as an indexed lookup that "avoids a full table scan". SQLite
    // only honours that for an EXPRESSION index, and the mirror calls this on
    // every SAGE write and delete (sage-event-mirror.ts), so a missing index
    // silently turns each event into a whole-corpus walk. SQLite reports the
    // difference deterministically in EXPLAIN QUERY PLAN — no timing involved.
    type PlanProbe = {
      prepare(sql: string): {
        all(...params: unknown[]): Array<Record<string, unknown>>;
        run(...params: unknown[]): unknown;
      };
    };
    const db = (store as unknown as { db: PlanProbe }).db;

    // Make the path live first: a mirrored entry that findBySageId resolves,
    // so a green plan can never mean "matched nothing".
    await store.remember({ text: 'mirrored memory body', metadata: { sageId: 'sage-mirror-1' } });
    let fillerId = '';
    for (let i = 0; i < 25; i++) {
      fillerId = (await store.remember({ text: `unrelated filler ${i}`, metadata: { other: i } }))
        .id;
    }
    expect(store.findBySageId('sage-mirror-1')?.metadata?.['sageId']).toBe('sage-mirror-1');

    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN
             SELECT * FROM entries
              WHERE CASE WHEN json_valid(metadata)
                         THEN json_extract(metadata, '$.sageId')
                    END = ?
              ORDER BY updated_at DESC
              LIMIT 1`,
        )
        .all('sage-mirror-1') as Array<Record<string, unknown>>
    )
      .map((row) => String(row['detail'] ?? ''))
      .join('\n');

    // Harness sanity: a genuinely indexed column must show a seek, so an index
    // that SQLite never uses cannot masquerade as a passing assertion.
    const controlPlan = (
      db
        .prepare(`EXPLAIN QUERY PLAN SELECT * FROM entries WHERE content_hash = ?`)
        .all('whatever') as Array<Record<string, unknown>>
    )
      .map((row) => String(row['detail'] ?? ''))
      .join('\n');
    expect(controlPlan).toMatch(/SEARCH entries USING (?:COVERING )?INDEX/);

    expect(plan).toMatch(/SEARCH entries USING (?:COVERING )?INDEX/);
    expect(plan).not.toMatch(/SCAN entries/);

    // Why the `json_valid` guard exists. A bare `json_extract` RAISES
    // "malformed JSON" on an unparseable `metadata` value rather than yielding
    // NULL, so one corrupt legacy row would break every mirror write (and the
    // unguarded index made it worse: CREATE INDEX evaluated the throwing
    // expression over the whole table, so the store refused to open at all).
    // Reverting the indexed expression and the query together to a bare
    // json_extract leaves every assertion above green — the plan still matches
    // itself — so this is the case that pins the guard's reason for existing.
    expect(() =>
      db.prepare('UPDATE entries SET metadata = ? WHERE id = ?').run('malformed json {', fillerId),
    ).not.toThrow();
    expect(store.findBySageId('sage-mirror-1')?.metadata?.['sageId']).toBe('sage-mirror-1');
    expect(store.findBySageId('no-such-sage-id')).toBeUndefined();
  });

  it('closes the SQLite handle if schema or provider initialization throws in the constructor', () => {
    const dbPath = store.databasePath;
    const projectRoot = path.dirname(path.dirname(store.directory));
    const db = (store as unknown as { db: { exec: (sql: string) => void } }).db;
    db.exec('DROP TABLE schema_meta; CREATE TABLE schema_meta (invalid_col TEXT);');
    store.close();

    expect(
      () =>
        new VectorMemoryStore({
          provider: new FakeEmbeddingProvider({ dimensions: 64 }),
          projectRoot,
        }),
    ).toThrow();
    expect(dbPath).toBeTruthy();
  });

  it('rejects directory paths that escape projectRoot via symlink', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-vec-sym-'));
    try {
      const proj = path.join(tmpRoot, 'proj');
      const outside = path.join(tmpRoot, 'outside');
      fs.mkdirSync(proj);
      fs.mkdirSync(outside);
      fs.symlinkSync(
        outside,
        path.join(proj, 'sym'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      expect(
        () =>
          new VectorMemoryStore({
            projectRoot: proj,
            directory: 'sym/db',
            provider: new FakeEmbeddingProvider({ dimensions: 64 }),
          }),
      ).toThrow(/project root/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
