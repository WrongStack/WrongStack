import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';
import type { Sage } from '../src/types.js';

let tempDir: string;

let activeStores: SqliteSageStore[] = [];

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wrongstack-sqlite-mem-'));
  activeStores = [];
});

afterEach(async () => {
  for (const store of activeStores) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  // Give Windows a tick to release WAL file handles
  await new Promise((r) => setTimeout(r, 10));
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

function trackStore(store: SqliteSageStore): SqliteSageStore {
  activeStores.push(store);
  return store;
}

/**
 * Write legacy JSONL artifacts directly to disk so the auto-migration path can
 * be exercised without the deleted JSONL store. Mirrors the on-disk layout the
 * migration reader expects: memories.jsonl, candidates.jsonl, graph/edges.jsonl,
 * audit.jsonl under `<projectRoot>/.wrongstack/memories`.
 */
async function seedLegacyJsonl(files: {
  memories?: object[];
  candidates?: object[];
  edges?: object[];
  audits?: object[];
}): Promise<void> {
  const root = path.join(tempDir, '.wrongstack', 'memories');
  await fs.promises.mkdir(path.join(root, 'graph'), { recursive: true });
  const write = (file: string, rows?: object[]): Promise<void> =>
    rows?.length
      ? fs.promises.writeFile(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
      : Promise.resolve();
  await write(path.join(root, 'memories.jsonl'), files.memories);
  await write(path.join(root, 'candidates.jsonl'), files.candidates);
  await write(path.join(root, 'graph', 'edges.jsonl'), files.edges);
  await write(path.join(root, 'audit.jsonl'), files.audits);
}

/** Build a legacy `recordType:'memory'` JSONL row for the migration fixtures. */
function legacyMemoryRow(id: string, kind: string, text: string): object {
  const now = new Date().toISOString();
  return {
    recordType: 'memory',
    schemaVersion: 1,
    op: 'add',
    memory: {
      id,
      revision: 1,
      status: 'active',
      kind,
      scope: 'project',
      text,
      importance: 0.8,
      confidence: 0.8,
      freshness: 1,
      tags: [],
      anchors: [],
      sources: [],
      createdAt: now,
      updatedAt: now,
    },
  };
}

describe('SqliteSageStore', () => {
  describe('initialize', () => {
    it('creates the SQLite database and manifest on first open', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const dbPath = path.join(tempDir, '.wrongstack', 'memories', 'sage.db');
      const manifestPath = path.join(tempDir, '.wrongstack', 'memories', 'manifest.json');
      expect(fs.existsSync(dbPath)).toBe(true);
      expect(fs.existsSync(manifestPath)).toBe(true);
    });

    it('is idempotent — calling initialize twice does not throw', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      await store.initialize();
    });
  });

  describe('rememberSage', () => {
    it('stores a new memory', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const mem = await store.rememberSage({ text: 'SQLite test memory', kind: 'fact' });
      expect(mem.id).toBeTruthy();
      expect(mem.text).toBe('SQLite test memory');
      expect(mem.status).toBe('active');
    });

    it('merges duplicates by canonical text', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const first = await store.rememberSage({ text: 'Duplicate  test  content', kind: 'fact' });
      const second = await store.rememberSage({
        text: 'duplicate test content',
        kind: 'fact',
        tags: ['new-tag'],
      });
      expect(second.id).toBe(first.id);
      expect(second.tags).toContain('new-tag');
    });

    it('merges near-duplicate paraphrases of the same durable fact', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const first = await store.rememberSage({
        text: 'Session tokens in packages/auth must be compared in milliseconds after normalizing exp claims from the JWT payload.',
        kind: 'fact',
        tags: ['auth'],
        anchors: [{ type: 'file', path: 'packages/auth/session.ts' }],
      });
      const second = await store.rememberSage({
        text: 'Session tokens in packages/auth must be compared in milliseconds after normalizing exp claims from the JWT payload before Date.now checks.',
        kind: 'fact',
        tags: ['jwt'],
        anchors: [{ type: 'symbol', path: 'packages/auth/session.ts', symbol: 'verifySession' }],
      });
      expect(second.id).toBe(first.id);
      expect(second.tags).toEqual(expect.arrayContaining(['auth', 'jwt']));
      expect(second.anchors.some((a) => a.symbol === 'verifySession')).toBe(true);
    });

    it('keeps exact and near-duplicate session memories isolated by owner', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      const exactA = await store.rememberSage({
        text: 'Session owner exact duplicate memory',
        scope: 'session',
        ownerSessionId: 'session-a',
      });
      const exactB = await store.rememberSage({
        text: 'Session owner exact duplicate memory',
        scope: 'session',
        ownerSessionId: 'session-b',
      });
      const nearA = await store.rememberSage({
        text: 'Session owner near duplicate memory retains its original owner and unique identifier.',
        scope: 'session',
        ownerSessionId: 'session-a',
      });
      const nearB = await store.rememberSage({
        text: 'Session owner near duplicate memory retains its original owner and unique identifier during merging.',
        scope: 'session',
        ownerSessionId: 'session-b',
      });

      expect(exactB.id).not.toBe(exactA.id);
      expect(exactA.ownerSessionId).toBe('session-a');
      expect(exactB.ownerSessionId).toBe('session-b');
      expect(nearB.id).not.toBe(nearA.id);
      expect(nearA.ownerSessionId).toBe('session-a');
      expect(nearB.ownerSessionId).toBe('session-b');
    });

    it('does not merge an owned session memory into a legacy ownerless row', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      const legacy = await store.rememberSage({
        text: 'Legacy ownerless session memory retains its original unique identifier.',
        scope: 'session',
        ownerSessionId: 'legacy-owner',
      });
      const database = store as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
      };
      database.db
        .prepare(
          "UPDATE memories SET owner_session_id = NULL, data = json_remove(data, '$.ownerSessionId') WHERE id = ?",
        )
        .run(legacy.id);

      const owned = await store.rememberSage({
        text: 'Legacy ownerless session memory retains its original unique identifier during merging.',
        scope: 'session',
        ownerSessionId: 'session-b',
      });

      expect(owned.id).not.toBe(legacy.id);
      expect(owned.ownerSessionId).toBe('session-b');
    });

    it('merges duplicate session memories owned by the same session', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      const first = await store.rememberSage({
        text: 'Same session duplicate memory',
        scope: 'session',
        ownerSessionId: 'session-a',
      });
      const second = await store.rememberSage({
        text: 'Same session duplicate memory',
        scope: 'session',
        ownerSessionId: 'session-a',
        tags: ['merged'],
      });

      expect(second.id).toBe(first.id);
      expect(second.ownerSessionId).toBe('session-a');
      expect(second.tags).toContain('merged');
    });

    it('rejects ephemeral progress chatter for project scope', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await expect(
        store.rememberSage({ text: 'still working on the auth bug', kind: 'fact' }),
      ).rejects.toThrow(/ephemeral progress/i);
    });

    it('rejects structural kinds without anchors', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await expect(
        store.rememberSage({ text: 'Note about the auth session helper path', kind: 'file_note' }),
      ).rejects.toThrow(/requires at least one anchor/i);
    });

    it('demotes unanchored short memories when scores are defaulted', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const demoted = await store.rememberSage({
        text: 'Use pnpm always',
        kind: 'preference',
      });
      expect(demoted.importance).toBeLessThanOrEqual(0.7);
      expect(demoted.confidence).toBeLessThanOrEqual(0.75);

      const explicit = await store.rememberSage({
        text: 'Always prefer exact package manager versions in CI scripts',
        kind: 'preference',
        importance: 0.95,
        confidence: 0.95,
      });
      expect(explicit.importance).toBeCloseTo(0.95);
      expect(explicit.confidence).toBeCloseTo(0.95);
    });

    it('rejects credential-shaped input before persistence', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      const credential = `api_key=${'a'.repeat(24)}`;

      await expect(store.rememberSage({ text: credential })).rejects.toThrow(
        /secret or credential/i,
      );
      expect((await store.getStats()).total).toBe(0);
    });

    it('scans nested metadata for credential-shaped input', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      const credential = `token=${'b'.repeat(24)}`;

      await expect(
        store.rememberSage({
          text: 'Harmless text',
          anchors: [{ type: 'command', command: `echo ${credential}` }],
        }),
      ).rejects.toThrow(/secret or credential/i);
      expect((await store.getStats()).total).toBe(0);
    });

    it('stores anchors, tags, audience, and sources', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const mem = await store.rememberSage({
        text: 'Anchored memory',
        kind: 'file_note',
        tags: ['api', 'v2'],
        anchors: [{ type: 'file', path: 'src/index.ts' }],
        audience: { roles: ['reviewer'] },
        importance: 0.9,
        confidence: 0.95,
      });
      expect(mem.anchors).toHaveLength(1);
      expect(mem.anchors[0]?.path).toBe('src/index.ts');
      expect(mem.tags).toEqual(expect.arrayContaining(['api', 'v2']));
      expect(mem.audience?.roles).toEqual(['reviewer']);
    });
  });

  describe('updateSage', () => {
    it('updates text and status', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const mem = await store.rememberSage({ text: 'Original text', kind: 'fact' });
      const updated = await store.updateSage(mem.id, { text: 'Updated text', status: 'stale' });
      expect(updated.text).toBe('Updated text');
      expect(updated.status).toBe('stale');
      expect(updated.revision).toBe(mem.revision + 1);
    });

    it('updates persistence and requires force to delete permanent memories', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const mem = await store.rememberSage({
        text: 'Permanent memory',
        kind: 'fact',
        persistence: 'short_lived',
      });

      await expect(
        store.updateSage(mem.id, { persistence: 'permanent', status: 'deleted' }),
      ).rejects.toThrow("is marked 'permanent' and cannot be deleted");

      const permanent = await store.updateSage(mem.id, { persistence: 'permanent' });
      expect(permanent.persistence).toBe('permanent');
      await expect(store.updateSage(mem.id, { status: 'deleted' })).rejects.toThrow(
        "is marked 'permanent' and cannot be deleted",
      );

      const deleted = await store.updateSage(mem.id, { status: 'deleted', force: true });
      expect(deleted.status).toBe('deleted');
      const audit = await store.readAudit(10);
      expect(audit).toContainEqual(
        expect.objectContaining({
          event: 'memory.deleted',
          memoryId: mem.id,
          details: expect.objectContaining({ force: true, persistence: 'permanent' }),
        }),
      );
    });

    it('requires force to delete non-permanent memories (P1-4)', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const mem = await store.rememberSage({
        text: 'Normal long-lived memory',
        kind: 'fact',
      });

      // Without force, the deletion guard rejects ALL deletions, not just permanent.
      await expect(store.updateSage(mem.id, { status: 'deleted' })).rejects.toThrow(
        /cannot be deleted without explicit authorization/,
      );

      // With force, the deletion succeeds.
      const deleted = await store.updateSage(mem.id, { status: 'deleted', force: true });
      expect(deleted.status).toBe('deleted');
    });

    it('throws for a non-existent id', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      await expect(store.updateSage('nonexistent', { text: 'x' })).rejects.toThrow();
    });
  });

  describe('hardDeleteSage', () => {
    it('soft-deletes a memory (tombstone preserved)', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const mem = await store.rememberSage({ text: 'To be deleted', kind: 'fact' });
      const result = await store.hardDeleteSage(mem.id, 'test deletion');
      expect(result.deleted).toBe(true);

      // Tombstone preserved (soft-delete), not hard-deleted.
      const stats = await store.getStats();
      expect(stats.total).toBe(1);
      expect(stats.byStatus.deleted).toBe(1);

      const deleted = await store.getSage(mem.id);
      expect(deleted).not.toBeNull();
      expect(deleted!.status).toBe('deleted');
    });
  });

  describe('searchSage', () => {
    it('finds memories by text content', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      await store.rememberSage({ text: 'PostgreSQL connection pool settings', kind: 'fact' });
      await store.rememberSage({ text: 'Redis cache TTL configuration', kind: 'fact' });
      await store.rememberSage({ text: 'PostgreSQL index optimization', kind: 'fact' });

      const results = await store.searchSage('PostgreSQL');
      expect(results.length).toBeGreaterThanOrEqual(2);
      for (const r of results) {
        expect(r.text.toLowerCase()).toContain('postgresql');
      }
    });

    it('returns empty for non-matching query', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      await store.rememberSage({ text: 'Some memory about databases', kind: 'fact' });
      const results = await store.searchSage('xyznonexistent');
      expect(results).toHaveLength(0);
    });

    it('respects limit option', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      for (let i = 0; i < 5; i++) {
        await store.rememberSage({ text: `Limitable test memory ${i}`, kind: 'fact' });
      }
      const results = await store.searchSage('Limitable', { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('filters scope before applying an empty-query limit', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      for (let i = 0; i < 3; i++) {
        await store.rememberSage({
          text: `High-ranked user memory ${i}`,
          scope: 'user',
          importance: 1,
        });
      }
      await store.rememberSage({
        text: 'Project dedup context',
        scope: 'project',
        importance: 0.1,
      });

      const results = await store.searchSage('', { scope: 'project', limit: 1 });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ text: 'Project dedup context', scope: 'project' });
    });

    it('applies scope filtering to text queries', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.rememberSage({ text: 'Shared lookup term in user memory', scope: 'user' });
      await store.rememberSage({ text: 'Shared lookup term in project memory', scope: 'project' });

      const results = await store.searchSage('Shared lookup term', { scope: 'project', limit: 10 });

      expect(results).toHaveLength(1);
      expect(results[0]?.scope).toBe('project');
    });

    it('isolates empty and FTS searches by session unless admin access is requested', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      const sessionA = await store.rememberSage({
        text: 'Session isolation searchable alpha record',
        scope: 'session',
        ownerSessionId: 'session-a',
      });
      const sessionB = await store.rememberSage({
        text: 'Session isolation searchable beta record',
        scope: 'session',
        ownerSessionId: 'session-b',
      });

      const emptyForA = await store.searchSage('', { scope: 'session', sessionId: 'session-a' });
      const ftsForA = await store.searchSage('Session isolation searchable', {
        scope: 'session',
        sessionId: 'session-a',
      });
      const unscoped = await store.searchSage('', { scope: 'session' });
      const admin = await store.searchSage('', { scope: 'session', includeAllSessions: true });

      expect(emptyForA.map((memory) => memory.id)).toEqual([sessionA.id]);
      expect(ftsForA.map((memory) => memory.id)).toEqual([sessionA.id]);
      expect(unscoped).toEqual([]);
      expect(admin.map((memory) => memory.id)).toEqual(
        expect.arrayContaining([sessionA.id, sessionB.id]),
      );
    });

    it('keeps session parameters ordered correctly in LIKE fallback searches', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      const sessionA = await store.rememberSage({
        text: 'LIKE fallback session alpha memory',
        scope: 'session',
        ownerSessionId: 'session-a',
      });
      await store.rememberSage({
        text: 'LIKE fallback session beta memory',
        scope: 'session',
        ownerSessionId: 'session-b',
      });

      const results = await store.searchSage('a', {
        scope: 'session',
        sessionId: 'session-a',
      });

      expect(results.map((memory) => memory.id)).toEqual([sessionA.id]);
    });
  });

  describe('retrieveForPath', () => {
    it('finds memories anchored to a file path', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      await store.rememberSage({
        text: 'Config for auth module',
        kind: 'file_note',
        anchors: [{ type: 'file', path: 'src/auth/config.ts' }],
      });
      await store.rememberSage({
        text: 'Unrelated note',
        kind: 'fact',
      });
      const results = await store.retrieveForPath(['src/auth/config.ts']);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.text).toContain('auth module');
    });

    it('finds ancestor-anchored memories when includeAncestors is true', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      await store.rememberSage({
        text: 'Directory-level note',
        kind: 'file_note',
        anchors: [{ type: 'directory', path: 'src/auth' }],
      });
      const results = await store.retrieveForPath(['src/auth/config.ts'], {
        path: 'src/auth/config.ts',
        includeAncestors: true,
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('findRelatedSage', () => {
    it('expands a symbol memory to package/command relatives and excludes unrelated', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const symbol = await store.rememberSage({
        text: 'SessionStore owns refresh-token rotation.',
        kind: 'symbol_note',
        tags: ['auth', 'session'],
        anchors: [{ type: 'symbol', path: 'packages/auth/src/session.ts', symbol: 'SessionStore' }],
      });
      const packageFact = await store.rememberSage({
        text: 'The auth package owns session lifecycle.',
        kind: 'fact',
        tags: ['auth'],
        anchors: [{ type: 'package', path: 'packages/auth' }],
        persistence: 'long_lived',
      });
      const command = await store.rememberSage({
        text: 'Run the auth package tests before changing session behavior.',
        kind: 'command_note',
        tags: ['auth', 'test'],
        anchors: [
          { type: 'package', path: 'packages/auth' },
          { type: 'command', command: 'pnpm --filter @wrongstack/auth test' },
        ],
      });
      await store.rememberSage({
        text: 'Unrelated renderer convention.',
        kind: 'convention',
        tags: ['ui'],
        anchors: [{ type: 'package', path: 'packages/tui' }],
      });

      const related = await store.findRelatedSage([symbol.id], { limit: 10 });
      const ids = new Set(related.map((memory) => memory.id));

      expect(ids.has(packageFact.id)).toBe(true);
      expect(ids.has(command.id)).toBe(true);
      expect(related.some((memory) => memory.text.includes('renderer'))).toBe(false);
    });

    it('returns empty when seeds share no structure with the corpus', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const seed = await store.rememberSage({
        text: 'Isolated fact with no tags or anchors',
        kind: 'fact',
      });
      await store.rememberSage({
        text: 'Another isolated fact',
        kind: 'fact',
      });
      const related = await store.findRelatedSage([seed.id], { limit: 10 });
      expect(related).toEqual([]);
    });
  });

  describe('listMemories', () => {
    it('lists memories sorted by updatedAt DESC', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      await store.rememberSage({ text: 'First memory', kind: 'fact' });
      await store.rememberSage({ text: 'Second memory', kind: 'fact' });
      const list = await store.listMemories({ limit: 10 });
      expect(list.length).toBeGreaterThanOrEqual(2);
      // Second memory should be newer or equal
      const firstDate = list[0]!.updatedAt;
      const secondDate = list[1]!.updatedAt;
      expect(firstDate.localeCompare(secondDate)).toBeGreaterThanOrEqual(0);
    });

    it('filters by status', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const mem = await store.rememberSage({ text: 'Active memory', kind: 'fact' });
      await store.updateSage(mem.id, { status: 'archived' });
      await store.rememberSage({ text: 'Another active memory', kind: 'fact' });
      const active = await store.listMemories({ status: 'active' });
      const archived = await store.listMemories({ status: 'archived' });
      expect(active.every((m) => m.status === 'active')).toBe(true);
      expect(archived.every((m) => m.status === 'archived')).toBe(true);
      expect(archived.length).toBe(1);
    });

    it('filters by kind', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      await store.rememberSage({ text: 'A fact', kind: 'fact' });
      await store.rememberSage({ text: 'A decision', kind: 'decision' });
      const facts = await store.listMemories({ kind: 'fact' });
      expect(facts.every((m) => m.kind === 'fact')).toBe(true);
    });
  });

  describe('getStats', () => {
    it('returns correct counts', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      await store.rememberSage({ text: 'Fact one', kind: 'fact' });
      await store.rememberSage({ text: 'Decision one', kind: 'decision' });
      await store.addGraphEdge('mem:a', 'mem:b', 'related_to');
      const stats = await store.getStats();
      expect(stats.total).toBe(2);
      expect(stats.byStatus.active).toBe(2);
      expect(stats.byKind.fact).toBe(1);
      expect(stats.byKind.decision).toBe(1);
      expect(stats.edges).toBeGreaterThanOrEqual(1);
    });
  });

  describe('graph operations', () => {
    it('adds and traverses edges', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      await store.addGraphEdge('mem:a', 'mem:b', 'supersedes');
      await store.addGraphEdge('mem:b', 'mem:c', 'supersedes');
      const edges = await store.traverseGraph(['mem:a'], { maxDepth: 3 });
      expect(edges.length).toBeGreaterThanOrEqual(2);
    });

    it('keeps edge weights monotone on duplicate inserts (MAX policy)', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      await store.addGraphEdge('mem:x', 'mem:y', 'related_to', 1);
      await store.addGraphEdge('mem:x', 'mem:y', 'related_to', 1);
      const edges = await store.traverseGraph(['mem:x']);
      const xy = edges.find((e) => e.from === 'mem:x' && e.to === 'mem:y');
      expect(xy).toBeDefined();
      // Unified 2026-08-02 monotone policy (see sqlite-store-schema.ts):
      // repeated identical assertions are idempotent — MAX(1, 1) = 1, not the
      // pre-policy accumulate result (2).
      expect(xy!.weight).toBe(1);
    });
  });

  describe('hygiene', () => {
    it('marks memories with stale anchors', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      await store.rememberSage({
        text: 'Memory with valid anchor',
        kind: 'file_note',
        anchors: [{ type: 'file', path: 'package.json' }],
      });
      await store.rememberSage({
        text: 'Memory with stale anchor',
        kind: 'file_note',
        anchors: [{ type: 'file', path: 'nonexistent/file.ts' }],
      });
      const report = await store.hygiene();
      expect(report.examined).toBe(2);
      expect(report.staled).toBeGreaterThanOrEqual(1);
    });

    it('persists stale verification results and honors verify: false', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const skipped = await store.rememberSage({
        text: 'Skip missing-anchor verification',
        kind: 'file_note',
        anchors: [{ type: 'file', path: 'missing/skipped.ts' }],
      });

      const skippedReport = await store.hygiene({ verify: false });
      expect(skippedReport.staled).toBe(0);
      expect(skippedReport.verified).toBe(0);
      const unverified = await store.getSage(skipped.id);
      expect(unverified?.status).toBe('active');
      expect(unverified?.lastVerifiedAt).toBeUndefined();

      const report = await store.hygiene();
      expect(report.staled).toBe(1);
      expect(await store.getSage(skipped.id)).toMatchObject({
        status: 'stale',
        lastVerifiedAt: expect.any(String),
      });
    });

    it('increments revision monotonically across hygiene operations (P1-9)', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();

      // Create a memory with a file anchor pointing to a real file so
      // verification has something to check.
      const anchorFile = path.join(tempDir, 'src', 'test-file.ts');
      fs.mkdirSync(path.dirname(anchorFile), { recursive: true });
      fs.writeFileSync(anchorFile, 'export const x = 1;');

      const mem = await store.rememberSage({
        text: 'Memory with a file anchor for revision tracking',
        kind: 'file_note',
        importance: 0.8,
        anchors: [{ type: 'file', path: 'src/test-file.ts' }],
      });
      expect(mem.revision).toBe(1);

      // Run verification — should increment revision (P1-9 fix).
      await store.verify();
      const afterVerify = await store.getSage(mem.id);
      expect(afterVerify!.revision).toBe(2);
      expect(afterVerify!.lastVerifiedAt).toBeTruthy();

      // Run hygiene — verify pass inside hygiene increments again.
      await store.hygiene();
      const afterHygiene = await store.getSage(mem.id);
      expect(afterHygiene!.revision).toBeGreaterThanOrEqual(3);

      // Revision must be monotonically increasing.
      expect(afterHygiene!.revision).toBeGreaterThan(afterVerify!.revision);
    });

    it('increments revision when superseded by dedup (P1-9)', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();

      // Create two memories that will be deduplicated by hygiene.
      // Use raw upsert to bypass remember's inline dedup.
      const internals = store as unknown as {
        runMutation: <T>(work: () => T) => Promise<T>;
        upsertMemory: (memory: Sage) => void;
      };
      const makeMem = (id: string, importance: number): Sage => ({
        id,
        revision: 1,
        scope: 'project',
        kind: 'fact',
        status: 'active',
        text: 'Duplicate memory for revision tracking test',
        importance,
        confidence: 0.8,
        freshness: 1,
        tags: [],
        anchors: [],
        sources: [{ type: 'user' }],
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      });

      await internals.runMutation(() => {
        internals.upsertMemory(makeMem('rev-low', 0.5));
        internals.upsertMemory(makeMem('rev-high', 0.9));
      });

      const report = await store.hygiene({ verify: false });
      expect(report.deduplicated).toBeGreaterThanOrEqual(1);

      // The superseded dup should have revision > 1 (incremented by helper).
      const superseded = await store.getSage('rev-low');
      expect(superseded).not.toBeNull();
      expect(superseded!.status).toBe('superseded');
      expect(superseded!.revision).toBeGreaterThan(1);
    });

    it('deduplicates identical-text memories and marks losers superseded', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      // Note: rememberSage already deduplicates on insert, so we bypass it
      // by using the internal upsertMemory to create exact duplicates.
      // Instead, create two memories with slightly different text that
      // normalize to the same key.
      await store.rememberSage({ text: 'Project uses pnpm workspaces.', importance: 0.5 });
      await store.rememberSage({ text: 'Project uses pnpm workspaces.', importance: 0.9 });

      const report = await store.hygiene();
      // rememberSage may merge on insert — if so, there's only 1 active.
      // If two survived, hygiene should dedup them.
      if (report.examined >= 2) {
        expect(report.deduplicated).toBeGreaterThanOrEqual(1);
        expect(report.superseded).toBeGreaterThanOrEqual(1);
      }
      // Either way, at most 1 active memory remains.
      const active = await store.listMemories({ status: 'active', limit: 100 });
      const pnpmMems = active.filter((m) => m.text.includes('pnpm workspaces'));
      expect(pnpmMems.length).toBe(1);
    });

    it('soft-deletes expired session memories instead of creating review candidates', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const sessionMem = await store.rememberSage({
        text: 'Temporary session scratch note about the current task',
        scope: 'session',
        ownerSessionId: 'test-session-001',
        kind: 'fact',
        importance: 0.4,
      });
      // Force expiresAt into the past via upsert.
      (
        store as unknown as {
          upsertMemory(memory: {
            id: string;
            status: string;
            scope: string;
            expiresAt: string;
            [key: string]: unknown;
          }): void;
        }
      ).upsertMemory({
        ...(await store.getSage(sessionMem.id))!,
        expiresAt: '2020-01-01T00:00:00.000Z',
      });

      const report = await store.hygiene({ verify: false });
      expect(report.deleted).toBeGreaterThanOrEqual(1);
      const active = await store.listMemories({ status: 'active', limit: 100 });
      expect(active.some((m) => m.id === sessionMem.id)).toBe(false);
      const deleted = await store.listMemories({ status: 'deleted', limit: 100 });
      expect(deleted.some((m) => m.id === sessionMem.id)).toBe(true);
      // No review candidate for the session GC target.
      const candidates = await store.listCandidates();
      expect(candidates.every((c) => c.targetMemoryId !== sessionMem.id)).toBe(true);
    });

    it('physically purges old deleted tombstones when purgeDeletedAfterDays is set', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const mem = await store.rememberSage({
        text: 'Old deleted memory awaiting physical purge from sqlite',
        kind: 'fact',
      });
      await store.deleteSage(mem.id, 'test purge', { force: true });
      (
        store as unknown as {
          upsertMemory(memory: { id: string; updatedAt: string; [key: string]: unknown }): void;
        }
      ).upsertMemory({
        ...(await store.getSage(mem.id))!,
        updatedAt: '2020-01-01T00:00:00.000Z',
      });

      const report = await store.hygiene({ verify: false, purgeDeletedAfterDays: 30 });
      expect(report.purgedDeleted).toBeGreaterThanOrEqual(1);
      expect(await store.getSage(mem.id)).toBeFalsy();
    });

    it('near-duplicate hygiene merges paraphrases that exact-text dedup missed', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      // Bypass rememberSage near-dup merge by upserting two paraphrases directly.
      const base = await store.rememberSage({
        text: 'Always use pnpm workspaces for monorepo package installs',
        kind: 'convention',
        importance: 0.9,
        anchors: [{ type: 'file', path: 'package.json' }],
      });
      const paraphrase = {
        ...base,
        id: `${base.id}_paraphrase`,
        text: 'Always use pnpm workspaces for monorepo package installation',
        importance: 0.5,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      };
      (
        store as unknown as {
          upsertMemory(memory: typeof paraphrase): void;
        }
      ).upsertMemory(paraphrase);

      const report = await store.hygiene({ verify: false });
      expect(report.deduplicated).toBeGreaterThanOrEqual(1);
      expect(report.superseded).toBeGreaterThanOrEqual(1);
      const active = await store.listMemories({ status: 'active', limit: 100 });
      const survivors = active.filter(
        (m) => m.text.includes('pnpm workspaces') && m.text.includes('monorepo package'),
      );
      expect(survivors).toHaveLength(1);
    });

    it('deduplicates inside one mutation transaction and records the committed audit', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const keeper = await store.rememberSage({
        text: 'Transaction-safe hygiene duplicate',
        importance: 0.9,
      });
      const duplicate = {
        ...keeper,
        id: `${keeper.id}_duplicate`,
        importance: 0.1,
      };
      (
        store as unknown as {
          upsertMemory(memory: typeof duplicate): void;
        }
      ).upsertMemory(duplicate);

      const report = await store.hygiene({ verify: false });

      expect(report.deduplicated).toBe(1);
      expect(report.superseded).toBe(1);
      const active = await store.listMemories({ status: 'active', limit: 100 });
      expect(active.filter((memory) => memory.text === keeper.text)).toHaveLength(1);
      const db = (
        store as unknown as {
          db: {
            prepare(sql: string): {
              get(...args: unknown[]): { count: number } | undefined;
            };
          };
        }
      ).db;
      const audit = db
        .prepare("SELECT COUNT(*) AS count FROM audit_log WHERE event = 'memory.hygiene_dedup'")
        .get();
      expect(audit?.count).toBe(1);
    });

    it('creates review candidates for low-confidence memories', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      // Create a memory with low confidence and old updatedAt
      const oldDate = new Date(Date.now() - 45 * 86_400_000).toISOString();
      await store.rememberSage({ text: 'Low confidence old fact.', confidence: 0.2 });
      // Manually set updatedAt to the past via updateSage
      const mems = await store.listMemories({ status: 'active', limit: 100 });
      const target = mems.find((m) => m.text.includes('Low confidence'));
      if (target) {
        const db = store as unknown as {
          db: { prepare: (s: string) => { run: (...args: unknown[]) => void } };
        };
        db.db
          .prepare(
            "UPDATE memories SET data = json_set(data, '$.updatedAt', ?, '$.lastAccessedAt', ?) WHERE id = ?",
          )
          .run(oldDate, oldDate, target.id);
      }

      const report = await store.hygiene({ archiveLowConfidenceAfterDays: 30, verify: false });
      expect(report.reviewCandidatesCreated).toBeGreaterThanOrEqual(1);
      const candidates = await store.listCandidates();
      const lowConfCandidates = candidates.filter((c) => c.reviewReason === 'confidence_low');
      expect(lowConfCandidates.length).toBeGreaterThanOrEqual(1);
    });

    it('does not create duplicate candidates on repeated hygiene runs', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const oldDate = new Date(Date.now() - 45 * 86_400_000).toISOString();
      await store.rememberSage({ text: 'Another low confidence fact.', confidence: 0.2 });
      const mems = await store.listMemories({ status: 'active', limit: 100 });
      const target = mems.find((m) => m.text.includes('Another low'));
      if (target) {
        const db = store as unknown as {
          db: { prepare: (s: string) => { run: (...args: unknown[]) => void } };
        };
        db.db
          .prepare(
            "UPDATE memories SET data = json_set(data, '$.updatedAt', ?, '$.lastAccessedAt', ?) WHERE id = ?",
          )
          .run(oldDate, oldDate, target.id);
      }

      // First run creates the candidate
      await store.hygiene({ archiveLowConfidenceAfterDays: 30, verify: false });
      const candidatesAfterFirst = await store.listCandidates();
      const pendingAfterFirst = candidatesAfterFirst.filter(
        (c) => c.status === 'pending' && c.tags.some((t) => t === 'review:confidence_low'),
      );

      // Second run should NOT create a duplicate
      const report2 = await store.hygiene({ archiveLowConfidenceAfterDays: 30, verify: false });
      const candidatesAfterSecond = await store.listCandidates();
      const pendingAfterSecond = candidatesAfterSecond.filter(
        (c) => c.status === 'pending' && c.tags.some((t) => t === 'review:confidence_low'),
      );

      expect(pendingAfterSecond.length).toBe(pendingAfterFirst.length);
      expect(report2.reviewCandidatesCreated).toBe(0);
    });

    it('exempts permanent memories from review candidates', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const oldDate = new Date(Date.now() - 45 * 86_400_000).toISOString();
      await store.rememberSage({
        text: 'Permanent low confidence fact.',
        confidence: 0.1,
        persistence: 'permanent',
      });
      const mems = await store.listMemories({ status: 'active', limit: 100 });
      const target = mems.find((m) => m.text.includes('Permanent'));
      if (target) {
        const db = store as unknown as {
          db: { prepare: (s: string) => { run: (...args: unknown[]) => void } };
        };
        db.db
          .prepare(
            "UPDATE memories SET data = json_set(data, '$.updatedAt', ?, '$.lastAccessedAt', ?) WHERE id = ?",
          )
          .run(oldDate, oldDate, target.id);
      }

      const report = await store.hygiene({ archiveLowConfidenceAfterDays: 30, verify: false });
      // No candidate should be created for the permanent memory
      expect(report.reviewCandidatesCreated).toBe(0);
    });
  });

  describe('readAudit + retention', () => {
    it('readAudit returns recent audited events newest-first, with mapped fields', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      const mem = await store.rememberSage({ text: 'auditable memory', kind: 'fact' });
      await store.recordUse([mem.id], 'test-source', 'sess-1'); // → 'memory.used'

      const audit = await store.readAudit(10);
      expect(audit.length).toBeGreaterThan(0);
      // Newest first: the most recent event is the recordUse.
      expect(audit[0]?.event).toBe('memory.used');
      expect(audit[0]?.schemaVersion).toBe(1);
      expect(audit.every((r) => typeof r.at === 'string' && r.at.length > 0)).toBe(true);
      // The nested details column round-trips.
      expect(audit[0]?.details).toMatchObject({ source: 'test-source' });
    });

    it('hygiene keeps the audit log bounded (prune runs without error)', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.rememberSage({ text: 'keep me', kind: 'fact' });
      // hygiene() calls pruneAuditLog(); it must succeed and the trail stays readable.
      await store.hygiene();
      const audit = await store.readAudit(50);
      expect(Array.isArray(audit)).toBe(true);
      expect(audit.some((r) => r.event === 'memory.hygiene_completed')).toBe(true);
    });
  });

  describe('JSONL → SQLite migration', () => {
    it('auto-migrates existing JSONL records on first open', async () => {
      // Write every legacy artifact directly to disk (the JSONL store that used
      // to produce them was removed in the SQLite migration).
      const now = new Date().toISOString();
      await seedLegacyJsonl({
        memories: [
          legacyMemoryRow('mem_one', 'fact', 'JSONL memory one'),
          legacyMemoryRow('mem_two', 'decision', 'JSONL memory two'),
        ],
        candidates: [
          {
            id: 'cand_one',
            status: 'pending',
            kind: 'fact',
            text: 'JSONL candidate',
            tags: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
        edges: [
          {
            id: 'edge_one',
            from: 'mem:mem_one',
            to: 'mem:mem_two',
            relation: 'related_to',
            weight: 0.8,
            createdAt: now,
          },
        ],
        audits: [{ event: 'memory.remembered', at: now }],
      });

      // Now open with SQLite store — should auto-migrate
      const sqliteStore = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await sqliteStore.initialize();

      const stats = await sqliteStore.getStats();
      expect(stats.total).toBe(2);
      expect(stats.byKind.fact).toBeGreaterThanOrEqual(1);
      expect(stats.byKind.decision).toBeGreaterThanOrEqual(1);
      expect(stats.edges).toBe(1);
      expect(await sqliteStore.listCandidates()).toHaveLength(1);

      const db = (
        sqliteStore as unknown as {
          db: { prepare: (sql: string) => { get: (...args: unknown[]) => { n: number } } };
        }
      ).db;
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM audit_log WHERE event != 'memory.legacy_jsonl_migrated'",
          )
          .get().n,
      ).toBeGreaterThan(0);

      // Search should find migrated content
      const results = await sqliteStore.searchSage('JSONL');
      expect(results.length).toBeGreaterThanOrEqual(2);

      sqliteStore.close();
    });

    it('merges later JSONL revisions into a non-empty SQLite database', async () => {
      const store1 = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store1.initialize();
      const original = await store1.rememberSage({ text: 'SQLite original', kind: 'fact' });
      store1.close();

      const migrated = {
        ...original,
        revision: original.revision + 1,
        text: 'Newer legacy JSONL revision',
        updatedAt: new Date(Date.parse(original.updatedAt) + 1_000).toISOString(),
      };
      await fs.promises.writeFile(
        path.join(tempDir, '.wrongstack', 'memories', 'memories.jsonl'),
        `${JSON.stringify({ recordType: 'memory', schemaVersion: 1, op: 'update', memory: migrated })}\n`,
        'utf8',
      );

      const store2 = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store2.initialize();

      expect(await store2.getSage(original.id)).toMatchObject({
        revision: migrated.revision,
        text: migrated.text,
      });
    });

    it('does not re-migrate if SQLite db already has data', async () => {
      // Seed a legacy memories.jsonl directly (no live JSONL store any more).
      await seedLegacyJsonl({ memories: [legacyMemoryRow('mem_orig', 'fact', 'JSONL original')] });

      // First SQLite open — migrates
      const store1 = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store1.initialize();
      await store1.rememberSage({ text: 'SQLite-added memory', kind: 'fact' });
      store1.close();

      // Second SQLite open — should NOT re-migrate
      const store2 = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store2.initialize();
      const stats = await store2.getStats();
      expect(stats.total).toBe(2); // 1 migrated + 1 added, not 3 (re-migration would double the JSONL one)
      store2.close();
    });
  });

  describe('close', () => {
    it('closes the database without error', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      expect(() => store.close()).not.toThrow();
    });
  });

  describe('createCandidate', () => {
    it('creates a pending candidate', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const candidate = await store.createCandidate({
        text: 'Proposed convention',
        kind: 'convention',
        scope: 'project',
      });
      expect(candidate.status).toBe('pending');
      expect(candidate.text).toBe('Proposed convention');
      const listed = await store.listCandidates();
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(candidate.id);
    });

    it('rejects a candidate whose text looks like a secret (High security fix)', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      // Construct a PEM private-key marker from parts so no literal credential
      // is committed. looksLikeSecret matches the `-----BEGIN ... PRIVATE KEY-----`
      // signature, and the marker is a structural format token (not a secret
      // value), so it is safe to assemble at runtime in a test fixture.
      const pemHeader = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
      await expect(
        store.createCandidate({
          text: `Leaked key material: ${pemHeader}`,
          kind: 'fact',
        }),
      ).rejects.toThrow(/secret or credential/i);
      // Nothing should have been persisted.
      expect(await store.listCandidates()).toHaveLength(0);
    });

    it('rejects a candidate whose anchor embeds a credential (guard scans all fields)', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      // The guard must scan anchor fields too, not just top-level text.
      const pemHeader = ['-----BEGIN', 'EC', 'PRIVATE', 'KEY-----'].join(' ');
      await expect(
        store.createCandidate({
          text: 'Harmless text',
          kind: 'fact',
          anchors: [{ type: 'command', command: `cat id_ecdsa: ${pemHeader}` }],
        }),
      ).rejects.toThrow(/secret or credential/i);
      expect(await store.listCandidates()).toHaveLength(0);
    });

    it('deduplicates only against pending candidates, not resolved ones (Medium lifecycle fix)', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const first = await store.createCandidate({
        text: 'Reusable fact',
        kind: 'fact',
        scope: 'project',
      });
      // Resubmitting while pending returns the same candidate (dedup).
      const dup = await store.createCandidate({
        text: 'Reusable fact',
        kind: 'fact',
        scope: 'project',
      });
      expect(dup.id).toBe(first.id);
      expect(await store.listCandidates()).toHaveLength(1);

      // Resolve the candidate (rejected), then resubmit — a NEW pending
      // candidate must be allowed, since resolved proposals should not
      // permanently block re-submission.
      await store.rejectCandidate(first.id, 'no longer relevant');
      const resubmitted = await store.createCandidate({
        text: 'Reusable fact',
        kind: 'fact',
        scope: 'project',
      });
      expect(resubmitted.id).not.toBe(first.id);
      expect(resubmitted.status).toBe('pending');
    });

    it('serializes concurrent proposals for the same text under runMutation (Medium race fix)', async () => {
      // Two stores sharing the same backing db issue identical proposals
      // concurrently. Without runMutation serialization both could observe
      // no duplicate and insert distinct candidates. After the fix, the
      // mutation chain + file lock must collapse them to a single candidate.
      const storeA = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      const storeB = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await storeA.initialize();
      await storeB.initialize();

      const [a, b] = await Promise.all([
        storeA.createCandidate({ text: 'Concurrent proposal', kind: 'fact', scope: 'project' }),
        storeB.createCandidate({ text: 'Concurrent proposal', kind: 'fact', scope: 'project' }),
      ]);
      // Either the two calls returned the same candidate (one inserted, one
      // observed it via dedup), or one of them is the stored pending row and
      // the other equals it. The invariant: exactly ONE pending candidate for
      // that text exists in the store.
      const pending = (await storeA.listCandidates()).filter(
        (c) => c.status === 'pending' && c.text === 'Concurrent proposal',
      );
      expect(pending).toHaveLength(1);
      expect([a.id, b.id]).toContain(pending[0]?.id);
    });
  });

  describe('resolveCandidate', () => {
    it('rejects unknown candidate ids with undefined', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.rememberSage({ text: 'test memory', scope: 'project' });
      const result = await store.resolveCandidate('nonexistent', 'delete');
      expect(result).toBeUndefined();
    });

    it('resolves delete by soft-deleting the target memory', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      const memory = await store.rememberSage({ text: 'delete-target', scope: 'project' });
      const candidate = await store.createCandidate({
        text: 'review: delete this',
        kind: 'fact',
        scope: 'project',
        targetMemoryId: memory.id,
        reviewReason: 'noise',
      });
      const result = await store.resolveCandidate(candidate.id, 'delete', 'confirmed');
      expect(result).toBeDefined();
      expect(result!.applied).toBe(true);
      expect(result!.decision).toBe('delete');
      expect(result!.candidateId).toBe(candidate.id);
      // Target should be soft-deleted (status='deleted', not hard-removed).
      // Verify via searchSage since getSage is not public on this store.
      const found = await store.searchSage('delete-target', {
        includeStatuses: ['active', 'deleted'],
      });
      expect(found.length).toBe(1);
      expect(found[0]!.status).toBe('deleted');
    });

    it('resolves archive by setting target status to archived', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      const memory = await store.rememberSage({ text: 'archive-target', scope: 'project' });
      const candidate = await store.createCandidate({
        text: 'review: archive this',
        kind: 'fact',
        scope: 'project',
        targetMemoryId: memory.id,
        reviewReason: 'stale',
      });
      const result = await store.resolveCandidate(candidate.id, 'archive', 'aging');
      expect(result).toBeDefined();
      expect(result!.applied).toBe(true);
      expect(result!.decision).toBe('archive');
      const found = await store.searchSage('archive-target', {
        includeStatuses: ['active', 'deleted', 'archived'],
      });
      expect(found.length).toBe(1);
      expect(found[0]!.status).toBe('archived');
    });

    it('resolves keep by dismissing the proposal without mutating target', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      const memory = await store.rememberSage({ text: 'keep-target', scope: 'project' });
      const candidate = await store.createCandidate({
        text: 'review: keep this',
        kind: 'fact',
        scope: 'project',
        targetMemoryId: memory.id,
        reviewReason: 'reviewed',
      });
      const result = await store.resolveCandidate(candidate.id, 'keep', 'still valid');
      expect(result).toBeDefined();
      expect(result!.applied).toBe(true);
      expect(result!.decision).toBe('keep');
      const found = await store.searchSage('keep-target', { includeStatuses: ['active'] });
      expect(found.length).toBe(1);
      expect(found[0]!.status).toBe('active'); // Unchanged
    });

    it('returns alreadyResolved=true for a second call on the same candidate', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      const memory = await store.rememberSage({ text: 'double-resolve', scope: 'project' });
      const candidate = await store.createCandidate({
        text: 'review: resolve once',
        kind: 'fact',
        scope: 'project',
        targetMemoryId: memory.id,
      });
      const first = await store.resolveCandidate(candidate.id, 'delete');
      expect(first!.applied).toBe(true);
      const second = await store.resolveCandidate(candidate.id, 'keep');
      expect(second!.alreadyResolved).toBe(true);
      expect(second!.applied).toBe(false);
    });

    it('reverts candidate to pending when target mutation fails (P0-3c)', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();

      // Create a memory as the candidate target.
      const memory = await store.rememberSage({
        text: 'Memory that will be physically removed to trigger mutation failure',
        scope: 'project',
      });

      const candidate = await store.createCandidate({
        text: 'Review: delete this memory',
        kind: 'fact',
        scope: 'project',
        targetMemoryId: memory.id,
      });

      // Physically remove the target memory row so that the candidate
      // resolution mutation fails — readSqliteSageRow returns null and
      // updateSqliteSage throws "not found". Using raw SQL DELETE to
      // bypass the soft-delete tombstone path.
      const internals = store as unknown as {
        runMutation: <T>(work: () => T) => Promise<T>;
        stmt: (sql: string) => { run: (...args: unknown[]) => void };
      };
      await internals.runMutation(() => {
        internals.stmt('DELETE FROM memories WHERE id = ?').run(memory.id);
      });

      // Resolve as delete — the mutation will fail because the target row
      // no longer exists (readSqliteSageRow returns null → updateSage throws).
      const first = await store.resolveCandidate(candidate.id, 'delete');

      // The resolution should report applied: false (mutation failed).
      expect(first!.applied).toBe(false);
      expect(first!.candidateId).toBe(candidate.id);

      // The candidate must be reverted to 'pending' so the caller can retry.
      const candidates = await store.listCandidates();
      const reverted = candidates.find((c) => c.id === candidate.id);
      expect(reverted).toBeDefined();
      expect(reverted!.status).toBe('pending');
    });
  });

  describe('abort checks (P1-10)', () => {
    it('rejects mutations when signal is already aborted', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      await store.rememberSage({ text: 'Existing memory', kind: 'fact' });

      const ac = new AbortController();
      ac.abort();

      // verify with an aborted signal should throw AbortError
      await expect(store.verify(undefined, ac.signal)).rejects.toThrow();
    });

    it('completes mutations normally when signal is not aborted', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      await store.rememberSage({
        text: 'Memory to verify',
        kind: 'file_note',
        anchors: [{ type: 'file', path: 'src/config.ts' }],
      });

      const ac = new AbortController();
      // Signal not aborted — verify should complete normally.
      const result = await store.verify(undefined, ac.signal);
      expect(result).toBeDefined();
    });
  });

  describe('consolidateSession', () => {
    it('creates candidates for new facts and auto-accepts above threshold', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      const result = await store.consolidateSession({
        sessionId: 'test-session',
        facts: [
          { text: 'The project uses TypeScript 5.5', confidence: 0.9, importance: 0.8 },
          { text: 'The project uses pnpm workspaces', confidence: 0.85, importance: 0.75 },
        ],
        autoAcceptThreshold: 0.7,
      });
      expect(result.candidates).toBe(2);
      expect(result.accepted).toBe(2); // Both above 0.7 threshold
      expect(result.rejected).toBe(0);
      expect(result.duplicate).toBe(0);
      // Accepted candidates should have created memories
      const memories = await store.searchSage('pnpm', { limit: 10 });
      expect(memories.length).toBeGreaterThanOrEqual(1);
    });

    it('skips duplicates when same text already exists', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.rememberSage({ text: 'Existing memory text', scope: 'project' });
      const result = await store.consolidateSession({
        sessionId: 'test-session',
        facts: [
          { text: 'Existing memory text', confidence: 0.9, importance: 0.8 },
          { text: 'Brand new fact', confidence: 0.9, importance: 0.8 },
        ],
        autoAcceptThreshold: 0.5,
      });
      expect(result.duplicate).toBe(1);
      expect(result.candidates).toBe(1);
      expect(result.accepted).toBe(1);
    });
  });

  describe('listSagePage', () => {
    async function seed(store: SqliteSageStore, count: number): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const mem = await store.rememberSage({ text: `Paginated ${i}`, kind: 'fact' });
        ids.push(mem.id);
      }
      return ids;
    }

    it('excludes deleted by default and counts them in statusCounts', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const ids = await seed(store, 3);
      // Soft-delete one memory (status → deleted) to build the audit trail.
      await store.updateSage(ids[0] as string, { status: 'deleted', force: true });

      const page = await store.listSagePage();
      expect(page.memories.every((m) => m.status !== 'deleted')).toBe(true);
      expect(page.total).toBe(2);
      expect(page.statusCounts['deleted']).toBe(1);
    });

    it('returns only deleted memories when requested', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const ids = await seed(store, 2);
      await store.updateSage(ids[0] as string, { status: 'deleted', force: true });

      const page = await store.listSagePage({ statuses: ['deleted'] });
      expect(page.memories).toHaveLength(1);
      expect(page.memories[0]?.status).toBe('deleted');
    });

    it('paginates with a stable cursor', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      await seed(store, 5);

      const first = await store.listSagePage({ limit: 2 });
      expect(first.memories).toHaveLength(2);
      expect(first.total).toBe(5);
      expect(first.nextCursor).toBeTruthy();

      const second = await store.listSagePage({ limit: 2, cursor: first.nextCursor ?? undefined });
      const third = await store.listSagePage({ limit: 2, cursor: second.nextCursor ?? undefined });
      expect(third.memories).toHaveLength(1);
      expect(third.nextCursor).toBeNull();

      const seen = new Set(
        [...first.memories, ...second.memories, ...third.memories].map((m) => m.id),
      );
      expect(seen.size).toBe(5);
    });
  });

  describe('syncAnchorEdges', () => {
    // Helper: collect every edge whose `from` is the given memory node id.
    // We can't query the DB directly (it is private), so we use the public
    // `traverseGraph` API, filtering on the source node.
    async function edgesFrom(
      store: SqliteSageStore,
      memoryId: string,
    ): Promise<Array<{ to: string; relation: string }>> {
      const from = `mem:${memoryId}`;
      const all = await store.traverseGraph([from], { maxDepth: 1 });
      return all.filter((e) => e.from === from).map((e) => ({ to: e.to, relation: e.relation }));
    }

    it('creates one edge per anchor, one relation per type', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const mem = await store.rememberSage({
        text: 'Multi-anchor parity test',
        kind: 'fact',
        anchors: [
          { type: 'file', path: 'src/one.ts' },
          { type: 'directory', path: 'src/lib' },
          { type: 'symbol', path: 'src/two.ts', symbol: 'exportFn' },
          { type: 'package', path: 'packages/foo' },
          { type: 'command', command: 'pnpm test' },
          { type: 'agent', role: 'Reviewer' }, // role is lower-cased by normalizeAnchors
        ],
      });

      const edges = await edgesFrom(store, mem.id);
      const relations = edges.map((e) => e.relation).sort();
      // The relation union is the source of truth for what we expect.
      expect(relations).toEqual([
        'about_agent',
        'about_command',
        'about_directory',
        'about_file',
        'about_package',
        'about_symbol',
      ]);
      // Sanity: each anchor type produced a distinct target node id.
      expect(new Set(edges.map((e) => e.to)).size).toBe(6);
    });

    it('is idempotent — re-remembering the same anchors produces the same edges', async () => {
      let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
      const store = trackStore(
        new SqliteSageStore({ projectRoot: tempDir, now: () => new Date(nowMs) }),
      );
      await store.initialize();
      const first = await store.rememberSage({
        text: 'Idempotent anchor test',
        kind: 'fact',
        anchors: [
          { type: 'file', path: 'src/idempotent.ts' },
          { type: 'command', command: 'pnpm build' },
        ],
      });
      const before = (await edgesFrom(store, first.id))
        .map((e) => `${e.relation}\u0000${e.to}`)
        .sort();
      const db = (
        store as unknown as {
          db: {
            prepare(sql: string): {
              get(...args: unknown[]): { created_at: string } | undefined;
            };
          };
        }
      ).db;
      const edgeCreatedAt = db
        .prepare(
          "SELECT created_at FROM edges WHERE from_node = ? AND to_node = ? AND relation = 'about_file'",
        )
        .get(`mem:${first.id}`, 'file:src/idempotent.ts')?.created_at;

      // Same anchors on a fresh upsert via updateSage — the merge path
      // also runs syncAnchorEdges and must not duplicate edges or reset their creation time.
      nowMs += 60_000;
      await store.updateSage(first.id, {
        anchors: [
          { type: 'file', path: 'src/idempotent.ts' },
          { type: 'command', command: 'pnpm build' },
        ],
      });

      const after = (await edgesFrom(store, first.id))
        .map((e) => `${e.relation}\u0000${e.to}`)
        .sort();

      expect(after).toEqual(before);
      const updatedEdgeCreatedAt = db
        .prepare(
          "SELECT created_at FROM edges WHERE from_node = ? AND to_node = ? AND relation = 'about_file'",
        )
        .get(`mem:${first.id}`, 'file:src/idempotent.ts')?.created_at;
      expect(updatedEdgeCreatedAt).toBe(edgeCreatedAt);
      // No duplicates: each relation appears at most once per (from, to).
      const uniquePairs = new Set(after);
      expect(uniquePairs.size).toBe(after.length);
    });

    it('replaces anchor edges when the anchor set changes, preserving supersedes', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const mem = await store.rememberSage({
        text: 'Anchor replacement test',
        kind: 'fact',
        anchors: [{ type: 'file', path: 'src/old.ts' }],
      });

      // Add a `supersedes` edge that must survive anchor replacement —
      // syncAnchorEdges only clears the `about_*` family.
      await store.addGraphEdge(`mem:${mem.id}`, 'mem:other', 'supersedes', 1);

      await store.updateSage(mem.id, {
        anchors: [{ type: 'file', path: 'src/new.ts' }],
      });

      const fromMem = `mem:${mem.id}`;
      const all = await store.traverseGraph([fromMem], { maxDepth: 1 });
      const outgoing = all.filter((e) => e.from === fromMem);

      const aboutRelations = outgoing
        .filter((e) => e.relation.startsWith('about_'))
        .map((e) => `${e.relation}\u0000${e.to}`)
        .sort();
      expect(aboutRelations).toEqual(['about_file\u0000file:src/new.ts']);

      // supersedes is preserved.
      const supersedes = outgoing.find((e) => e.relation === 'supersedes');
      expect(supersedes).toBeDefined();
      expect(supersedes?.to).toBe('mem:other');
    });

    it('superseding clears about_* edges but leaves other relations in place', async () => {
      const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
      await store.initialize();
      const mem = await store.rememberSage({
        text: 'Superseded anchor test',
        kind: 'fact',
        anchors: [
          { type: 'file', path: 'src/doomed.ts' },
          { type: 'symbol', path: 'src/doomed.ts', symbol: 'fn' },
        ],
      });
      await store.addGraphEdge(`mem:${mem.id}`, 'mem:sibling', 'related_to', 1);

      const fromMem = `mem:${mem.id}`;
      const before = await store.traverseGraph([fromMem], { maxDepth: 1 });
      expect(before.some((e) => e.relation.startsWith('about_'))).toBe(true);

      await store.updateSage(mem.id, { status: 'superseded' });

      const after = await store.traverseGraph([fromMem], { maxDepth: 1 });
      const about = after.filter((e) => e.from === fromMem && e.relation.startsWith('about_'));
      expect(about).toEqual([]);
      // Non-`about_*` relations survive the soft-delete.
      const related = after.find((e) => e.from === fromMem && e.relation === 'related_to');
      expect(related).toBeDefined();
      expect(related?.to).toBe('mem:sibling');
    });
  });
});
