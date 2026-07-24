import { describe, expect, it, vi } from 'vitest';
import { sqliteStoreCoverage as helpers, isSqliteAvailable } from '../src/sqlite-store.js';
import type {
  MemoryAnchor,
  MemoryCandidate,
  MemoryGraphEdge,
  Sage,
  SageAuditRecord,
  SageRecord,
} from '../src/types.js';

function memory(overrides: Partial<Sage> = {}): Sage {
  return {
    id: 'memory-1',
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    text: 'remember this',
    importance: 0.8,
    confidence: 0.8,
    freshness: 1,
    tags: ['tag'],
    anchors: [{ type: 'file', path: 'src/example.ts' }],
    sources: [{ type: 'user' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('SQLite pure helper coverage', () => {
  it('escapes query patterns and normalizes command families', () => {
    expect(helpers.escapeGlobPattern('a*[b]?')).toBe('a[*][[]b[]][?]');
    expect(helpers.escapeLikePattern('a%_\\b')).toBe('a\\%\\_\\\\b');
    expect(helpers.sqliteNormalizeCommand('  PNPM   Test  ')).toBe('pnpm test');
    expect(helpers.sqliteCommandFamily('pnpm test unit extra')).toBe('pnpm test');
    expect(
      helpers.formatLegacyEntry({
        ts: '2026',
        text: 'plain',
        scope: 'project-memory',
      } as never),
    ).toBe('- [2026] plain');
    expect(
      helpers.formatLegacyEntry({
        ts: '2026',
        text: 'typed',
        scope: 'project-memory',
        type: 'fact',
        tags: ['one'],
      } as never),
    ).toBe('- [2026] [fact] typed #one');
  });

  it('decodes valid cursors and safely ignores malformed cursor data', () => {
    expect(helpers.decodePageCursor(undefined)).toBeUndefined();
    expect(helpers.decodePageCursor('invalid')).toBeUndefined();
    expect(
      helpers.decodePageCursor(
        Buffer.from(JSON.stringify({ u: 1, i: 'memory-1' })).toString('base64url'),
      ),
    ).toBeUndefined();
    expect(
      helpers.decodePageCursor(
        Buffer.from(JSON.stringify({ u: '2026', i: 'memory-1' })).toString('base64url'),
      ),
    ).toEqual({ updatedAt: '2026', id: 'memory-1' });
  });

  it('maps every anchor type to nodes and graph relations', () => {
    const cases: Array<[MemoryAnchor, string | undefined, string]> = [
      [{ type: 'file', path: 'src\\a.ts' }, 'file:src/a.ts', 'about_file'],
      [{ type: 'test', path: 'tests/a.ts' }, 'file:tests/a.ts', 'about_file'],
      [{ type: 'git', path: 'src/a.ts' }, 'file:src/a.ts', 'about_file'],
      [{ type: 'directory', path: 'src' }, 'dir:src', 'about_directory'],
      [{ type: 'symbol', path: 'src/a.ts', symbol: 'run' }, 'symbol:src/a.ts#run', 'about_symbol'],
      [{ type: 'package', path: 'packages/sage' }, 'dir:packages/sage', 'about_package'],
      [{ type: 'command', command: ' pnpm   test ' }, 'command:pnpm test', 'about_command'],
      [{ type: 'agent', role: ' Reviewer ' }, 'agent:reviewer', 'about_agent'],
    ];
    for (const [anchor, node, relation] of cases) {
      expect(helpers.sqliteAnchorNode(anchor)).toBe(node);
      expect(helpers.sqliteAnchorRelation(anchor)).toBe(relation);
    }
    for (const anchor of [
      { type: 'file' },
      { type: 'directory' },
      { type: 'symbol', path: 'src/a.ts' },
      { type: 'symbol', symbol: 'run' },
      { type: 'package' },
      { type: 'command' },
      { type: 'agent' },
    ] as MemoryAnchor[]) {
      expect(helpers.sqliteAnchorNode(anchor)).toBeUndefined();
    }
  });

  it('maps priorities and legacy scope labels including defensive fallbacks', () => {
    expect(helpers.importanceFromPriority('critical')).toBe(1);
    expect(helpers.importanceFromPriority('high')).toBe(0.8);
    expect(helpers.importanceFromPriority('low')).toBe(0.3);
    expect(helpers.importanceFromPriority('medium')).toBe(0.6);
    expect(helpers.importanceFromPriority(undefined)).toBe(0.6);
    expect(helpers.importanceFromPriority('future' as never)).toBe(0.6);

    expect(helpers.legacyScopeLabel('project-agents')).toBe('Project AGENTS.md');
    expect(helpers.legacyScopeLabel('project-memory')).toBe('Project Memory');
    expect(helpers.legacyScopeLabel('user-memory')).toBe('User Memory');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(helpers.legacyScopeLabel('future-scope' as never)).toBe('future-scope');
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('matches legacy forget queries against all searchable fields', () => {
    const value = memory({
      id: 'target-id',
      tags: ['useful-tag'],
      anchors: [{ type: 'symbol', path: 'src/target.ts', symbol: 'Target', command: 'pnpm test' }],
    });
    for (const query of [
      'target-id',
      'remember',
      'useful-tag',
      'src/target.ts',
      'target',
      'pnpm',
    ]) {
      expect(helpers.matchesLegacyForget(value, query)).toBe(true);
    }
    expect(helpers.matchesLegacyForget(value, 'absent')).toBe(false);
  });

  it('validates persisted memory records and replacement ordering', () => {
    const current = memory();
    const valid: SageRecord = {
      recordType: 'memory',
      schemaVersion: 1,
      op: 'create',
      memory: current,
    };
    expect(helpers.isMigratableMemoryRecord(valid)).toBe(true);
    for (const invalid of [
      null,
      {},
      { ...valid, recordType: 'other' },
      { ...valid, memory: undefined },
      { ...valid, memory: { ...current, id: 1 } },
      { ...valid, memory: { ...current, revision: 0 } },
      { ...valid, memory: { ...current, status: 1 } },
      { ...valid, memory: { ...current, kind: 1 } },
      { ...valid, memory: { ...current, scope: 1 } },
      { ...valid, memory: { ...current, text: 1 } },
      { ...valid, memory: { ...current, importance: Number.NaN } },
      { ...valid, memory: { ...current, confidence: Number.NaN } },
      { ...valid, memory: { ...current, freshness: Number.NaN } },
      { ...valid, memory: { ...current, tags: null } },
      { ...valid, memory: { ...current, anchors: null } },
      { ...valid, memory: { ...current, sources: null } },
      { ...valid, memory: { ...current, createdAt: 1 } },
      { ...valid, memory: { ...current, updatedAt: 1 } },
    ]) {
      expect(helpers.isMigratableMemoryRecord(invalid)).toBe(false);
    }

    expect(helpers.shouldReplaceMigratedMemory(current, memory({ revision: 2 }))).toBe(true);
    expect(helpers.shouldReplaceMigratedMemory(current, memory({ revision: 0 }))).toBe(false);
    expect(
      helpers.shouldReplaceMigratedMemory(
        memory({ status: 'deleted' }),
        memory({ status: 'active' }),
      ),
    ).toBe(true);
    expect(helpers.shouldReplaceMigratedMemory(current, memory())).toBe(false);
  });

  it('validates candidate, edge, and audit migration shapes', () => {
    const candidate = {
      id: 'candidate',
      status: 'pending',
      text: 'text',
      createdAt: '2026',
      updatedAt: '2026',
    } as MemoryCandidate;
    expect(helpers.isMigratableCandidate(candidate)).toBe(true);
    for (const invalid of [
      null,
      {},
      { ...candidate, id: 1 },
      { ...candidate, status: 1 },
      { ...candidate, text: 1 },
      { ...candidate, createdAt: 1 },
      { ...candidate, updatedAt: 1 },
    ]) {
      expect(helpers.isMigratableCandidate(invalid)).toBe(false);
    }

    const edge = {
      id: 'edge',
      from: 'a',
      to: 'b',
      relation: 'related_to',
      weight: 1,
      createdAt: '2026',
    } as MemoryGraphEdge;
    expect(helpers.isMigratableEdge(edge)).toBe(true);
    for (const invalid of [
      null,
      {},
      { ...edge, id: 1 },
      { ...edge, from: 1 },
      { ...edge, to: 1 },
      { ...edge, relation: 1 },
      { ...edge, weight: Number.NaN },
      { ...edge, createdAt: 1 },
    ]) {
      expect(helpers.isMigratableEdge(invalid)).toBe(false);
    }

    const audit = { event: 'memory.created', at: '2026' } as SageAuditRecord;
    expect(helpers.isMigratableAuditRecord(audit)).toBe(true);
    expect(helpers.isMigratableAuditRecord(null)).toBe(false);
    expect(helpers.isMigratableAuditRecord({ event: 1, at: '2026' })).toBe(false);
    expect(helpers.isMigratableAuditRecord({ event: 'event', at: 1 })).toBe(false);
  });

  it('suppresses SQLite warnings, forwards other warnings, and always cleans up', () => {
    let listener: ((warning: Error, ...args: unknown[]) => void) | undefined;
    const on = vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      callback: typeof listener,
    ) => {
      if (event === 'warning') listener = callback;
      return process;
    }) as typeof process.on);
    const off = vi.spyOn(process, 'off').mockReturnValue(process);
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation((() => {
      listener?.(new Error('nested warning'));
    }) as typeof process.emitWarning);

    expect(
      helpers.withSqliteExperimentalWarningSuppressed(() => {
        listener?.(new Error('SQLite is experimental'));
        listener?.(new Error('ordinary warning'), 'Warning');
        listener?.('plain warning' as never);
        listener?.(undefined as never);
        return 42;
      }),
    ).toBe(42);
    expect(emit).toHaveBeenCalledTimes(3);
    expect(on).toHaveBeenCalled();
    expect(off).toHaveBeenCalled();

    expect(() =>
      helpers.withSqliteExperimentalWarningSuppressed(() => {
        throw new Error('run failed');
      }),
    ).toThrow('run failed');
  });

  it('covers every lazy SQLite loader state and restores the real constructor', () => {
    const original = helpers.getDatabaseSyncCtor();
    try {
      helpers.setDatabaseSyncCtor(null);
      expect(isSqliteAvailable()).toBe(false);

      helpers.setDatabaseSyncCtor(helpers.databaseSyncLoading as never);
      expect(isSqliteAvailable()).toBe(false);
      expect(() => helpers.loadDatabaseSync()).toThrow('Re-entrant');

      class FakeDatabase {}
      helpers.setDatabaseSyncCtor(FakeDatabase as never);
      expect(isSqliteAvailable()).toBe(true);
      expect(helpers.loadDatabaseSync()).toBe(FakeDatabase);

      helpers.setDatabaseSyncCtor(undefined);
      expect(
        helpers.probeSqliteAvailable(() => {
          throw new Error('missing runtime module');
        }),
      ).toBe(false);
      expect(helpers.getDatabaseSyncCtor()).toBeNull();

      helpers.setDatabaseSyncCtor(undefined);
      expect(isSqliteAvailable()).toBe(true);
    } finally {
      helpers.setDatabaseSyncCtor(original);
    }
  });
});
