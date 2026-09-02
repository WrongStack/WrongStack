import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';
import type { MemoryCandidate, Sage } from '../src/types.js';

let directory: string;
let stores: SqliteSageStore[];

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-sqlite-public-'));
  stores = [];
});

afterEach(async () => {
  for (const store of stores) store.close();
  await fs.rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function createStore(overrides: Record<string, unknown> = {}): SqliteSageStore {
  const store = new SqliteSageStore({ projectRoot: directory, ...overrides });
  stores.push(store);
  return store;
}

function database(store: SqliteSageStore): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

describe('SQLite public API completion coverage', () => {
  it('rejects empty memories and merges all duplicate metadata', async () => {
    const store = createStore();
    await expect(store.rememberSage({ text: '   ' })).rejects.toThrow('must not be empty');
    const first = await store.rememberSage({
      text: 'Duplicate metadata',
      tags: ['first'],
      anchors: [{ type: 'file', path: 'src/a.ts' }],
      sources: [{ type: 'user' }],
      supersedes: ['old-1'],
      contradicts: ['conflict-1'],
      audience: { roles: ['reviewer'] },
    });
    const merged = await store.rememberSage({
      text: ' duplicate   metadata ',
      tags: ['second'],
      anchors: [{ type: 'command', command: 'pnpm test' }],
      sources: [{ type: 'session', sessionId: 'session' }],
      supersedes: ['old-2'],
      contradicts: ['conflict-2'],
      audience: { roles: ['reviewer'] },
    });
    expect(merged.id).toBe(first.id);
    expect(merged.tags).toEqual(['first', 'second']);
    expect(merged.anchors).toHaveLength(2);
    expect(merged.sources).toHaveLength(2);
    expect(merged.supersedes).toEqual(['old-1', 'old-2']);
    expect(merged.contradicts).toEqual(['conflict-1', 'conflict-2']);
    expect(merged.audience).toEqual({ roles: ['reviewer'] });
  });

  it('updates every optional field and emits deletion status transitions', async () => {
    const events = { emit: vi.fn() };
    const store = createStore({ events: events as never });
    const value = await store.rememberSage({
      text: 'Update every field',
      anchors: [{ type: 'file', path: 'src/old.ts' }],
    });
    const updated = await store.updateSage(value.id, {
      text: ' Updated text ',
      kind: 'decision',
      status: 'stale',
      tags: ['#One'],
      anchors: [{ type: 'symbol', path: 'src/new.ts', symbol: 'run' }],
      importance: 2,
      confidence: -1,
      freshness: 0.5,
      audience: { modes: ['review'] },
      supersedes: ['old'],
      contradicts: ['conflict'],
    });
    expect(updated).toMatchObject({
      text: 'Updated text',
      kind: 'decision',
      status: 'stale',
      tags: ['one'],
      importance: 1,
      confidence: 0,
      freshness: 0.5,
      audience: { modes: ['review'] },
      supersedes: ['old'],
      contradicts: ['conflict'],
    });
    await store.updateSage(value.id, { status: 'deleted', force: true });
    expect(events.emit).toHaveBeenCalledWith(
      'memory.deleted',
      expect.objectContaining({ contextPolicy: 'eligible' }),
    );

    const never = await store.rememberSage({ text: 'Never policy transition' });
    const db = database(store);
    const neverValue = { ...(await store.getSage(never.id))!, contextPolicy: 'never' as const };
    db.prepare('UPDATE memories SET data = ? WHERE id = ?').run(
      JSON.stringify(neverValue),
      never.id,
    );
    await store.updateSage(never.id, { status: 'deleted', force: true });
    expect(events.emit).toHaveBeenCalledWith(
      'memory.deleted',
      expect.objectContaining({ contextPolicy: 'never' }),
    );
  });

  it('uses LIKE fallback searches and filters audience, scope, and never-inject records', async () => {
    const store = createStore();
    await store.rememberSage({ text: 'Punctuation !! memory', scope: 'user' });
    await store.rememberSage({
      text: 'Scoped audience memory',
      audience: { roles: ['reviewer'] },
    });
    const never = await store.rememberSage({ text: 'Never inject memory' });
    const db = database(store);
    db.prepare('UPDATE memories SET data = json_set(data, ?, ?) WHERE id = ?').run(
      '$.contextPolicy',
      'never',
      never.id,
    );

    await expect(store.searchSage('!!')).resolves.toHaveLength(1);
    await expect(store.searchSage('', { scope: 'user' })).resolves.toHaveLength(1);
    await expect(store.searchSage('', { includeAudienceScoped: false })).resolves.toHaveLength(1);
    await expect(
      store.searchSage('', {
        includeAudienceScoped: true,
        includeStatuses: ['active'],
      }),
    ).resolves.toHaveLength(3);
  });

  it('handles empty/outside path retrieval and audience retrieval boundaries', async () => {
    const store = createStore();
    await expect(store.retrieveForPath([])).resolves.toEqual([]);
    await expect(store.retrieveForPath(['../outside.ts'])).resolves.toEqual([]);
    const general = await store.rememberSage({
      text: 'General path memory',
      anchors: [{ type: 'file', path: 'src/a.ts' }],
    });
    await store.rememberSage({
      text: 'Audience path memory',
      anchors: [{ type: 'file', path: 'src/a.ts' }],
      audience: { roles: ['reviewer'] },
    });
    await expect(
      store.retrieveForPath(['src/a.ts'], {
        path: 'src/a.ts',
        includeAncestors: false,
        includeAudienceScoped: false,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: general.id })]);
    await expect(store.retrieveForAudience({ role: 'missing' })).resolves.toEqual([]);
    await expect(store.retrieveForAudience({ role: 'reviewer' }, 1)).resolves.toHaveLength(1);
  });

  it('filters and cursors paginated listings by status, kind, and escaped query', async () => {
    const store = createStore();
    await store.rememberSage({ text: 'Alpha_100% match', kind: 'decision' });
    await store.rememberSage({ text: 'Second decision', kind: 'decision' });
    await store.rememberSage({ text: 'Other fact', kind: 'fact' });
    await expect(
      store.listSagePage({
        statuses: ['active'],
        kind: 'decision',
        query: 'alpha_100%',
        limit: 1,
      }),
    ).resolves.toMatchObject({
      total: 1,
      memories: [expect.objectContaining({ kind: 'decision' })],
    });
    const first = await store.listSagePage({ statuses: ['active'], limit: 1 });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await store.listSagePage({
      statuses: ['active'],
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.memories[0]?.id).not.toBe(first.memories[0]?.id);
    await expect(store.listSagePage({ statuses: ['invalid' as never] })).resolves.toMatchObject({
      total: 3,
    });
  });

  it('covers graph traversal node forms, limits, and empty starts', async () => {
    const store = createStore();
    const first = await store.rememberSage({
      text: 'Graph source',
      anchors: [{ type: 'symbol', path: 'src/a.ts', symbol: 'run' }],
    });
    const second = await store.rememberSage({
      text: 'Graph sibling',
      anchors: [{ type: 'file', path: 'src/a.ts' }],
    });
    await store.addGraphEdge(`mem:${first.id}`, `mem:${second.id}`, 'related_to');
    await store.addGraphEdge(`mem:${first.id}`, 'tool:test', 'validated_by');
    await expect(store.traverseGraph([], { maxDepth: 0, limit: 0 })).resolves.toEqual([]);
    await expect(
      store.traverseGraph([`mem:${first.id}`], { maxDepth: 3, limit: 1 }),
    ).resolves.toHaveLength(1);
    await expect(store.graphFor(`mem:${first.id}`, 2, 20)).resolves.toEqual(expect.any(Array));
    await expect(store.graphFor(first.id, 2, 20)).resolves.toEqual(expect.any(Array));
    await expect(store.graphFor('src/a.ts', 2, 20)).resolves.toEqual(expect.any(Array));
    await expect(store.graphFor('../outside path with spaces', 2, 20)).resolves.toEqual([]);
  });

  it('maps malformed database and audit rows to safe null/partial records', async () => {
    const store = createStore({ traceId: 'trace' });
    const value = await store.rememberSage({ text: 'Corrupt later' });
    const db = database(store);
    db.exec('DROP TRIGGER IF EXISTS memories_au');
    db.prepare('UPDATE memories SET data = ? WHERE id = ?').run('{broken', value.id);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(store.getSage(value.id)).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalled();

    db.prepare('INSERT INTO audit_log (event, at, trace_id, data) VALUES (?, ?, ?, ?)').run(
      'broken',
      '2026',
      null,
      '{broken',
    );
    db.prepare('INSERT INTO audit_log (event, at, trace_id, data) VALUES (?, ?, ?, ?)').run(
      'primitive',
      '2026',
      null,
      '42',
    );
    db.prepare('INSERT INTO audit_log (event, at, trace_id, data) VALUES (?, ?, ?, ?)').run(
      'mapped',
      '2026',
      'row-trace',
      JSON.stringify({
        memoryId: 'memory',
        source: 'test',
        reason: 'reason',
        details: { value: 1 },
      }),
    );
    const audit = await store.readAudit(10);
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'mapped',
          memoryId: 'memory',
          source: 'test',
          reason: 'reason',
          details: { value: 1 },
          traceId: 'row-trace',
        }),
        expect.objectContaining({ event: 'broken' }),
      ]),
    );
  });

  it('cleans every relationship and reports only deleted edges', async () => {
    const events = { emit: vi.fn() };
    const store = createStore({ events: events as never });
    const target = await store.rememberSage({ text: 'Delete target' });
    const other = await store.rememberSage({ text: 'References target' });
    await store.addGraphEdge(`mem:${target.id}`, `mem:${other.id}`, 'related_to');
    await store.addGraphEdge(`mem:${target.id}`, `mem:${other.id}`, 'contradicts');
    const db = database(store);
    const otherValue: Sage = {
      ...(await store.getSage(other.id))!,
      supersedes: [target.id, 'keep-supersedes'],
      contradicts: [target.id, 'keep-contradicts'],
      supersededBy: target.id,
    };
    db.prepare('UPDATE memories SET data = ? WHERE id = ?').run(
      JSON.stringify(otherValue),
      other.id,
    );
    await store.deleteSage(target.id, 'cleanup', { force: true });
    const cleaned = await store.getSage(other.id);
    expect(cleaned).toMatchObject({
      supersedes: ['keep-supersedes'],
      contradicts: ['keep-contradicts'],
    });
    expect(cleaned?.supersededBy).toBeUndefined();
    expect(events.emit).toHaveBeenCalledWith(
      'memory.deleted',
      expect.objectContaining({ removedEdges: 1 }),
    );
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM edges WHERE relation = 'related_to'").get() as {
        n: number;
      },
    ).toEqual({ n: 1 });
  });

  it('covers candidate empty text, duplicate scope, and missing accept targets', async () => {
    const store = createStore();
    await expect(store.createCandidate({ text: ' ' })).rejects.toThrow('must not be empty');
    const first = await store.createCandidate({ text: 'Duplicate candidate', scope: 'project' });
    await expect(
      store.createCandidate({ text: ' duplicate candidate ', scope: 'project' }),
    ).resolves.toEqual(expect.objectContaining({ id: first.id }));
    const otherScope = await store.createCandidate({ text: 'Duplicate candidate', scope: 'user' });
    expect(otherScope.id).not.toBe(first.id);

    const db = database(store);
    const missingTarget: MemoryCandidate = {
      ...(await store.createCandidate({ text: 'Missing target candidate' })),
      targetMemoryId: 'missing',
    };
    db.prepare('UPDATE candidates SET data = ? WHERE id = ?').run(
      JSON.stringify(missingTarget),
      missingTarget.id,
    );
    await expect(store.acceptCandidate(missingTarget.id)).resolves.toEqual(
      expect.objectContaining({ text: 'Missing target candidate' }),
    );
    await expect(store.acceptCandidate(missingTarget.id)).resolves.toBeUndefined();
    await expect(store.rejectCandidate('missing', 'reason')).resolves.toBe(false);
  });

  it('drains rejected mutation chains', async () => {
    const store = createStore();
    const queue = (
      store as unknown as {
        mutationQueue: { mutationChain: Promise<unknown> };
      }
    ).mutationQueue;
    queue.mutationChain = Promise.reject(new Error('failed mutation'));
    await expect(store.drainMutations()).resolves.toBeUndefined();
  });
});
