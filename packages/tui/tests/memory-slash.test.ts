import type {
  MemoryCapability,
  MemoryEntry,
  MemoryPort,
  MemoryScope,
  MemoryStore,
} from '@wrongstack/core/types';
import {
  LegacyMemoryPortAdapter,
  SAGE_SURFACE_CAPABILITY,
  type SageSurface,
} from '@wrongstack/sage';
import { describe, expect, it, vi } from 'vitest';
import { createMemorySlashCommand, type MemorySlashDeps } from '../src/memory-slash.js';

/**
 * Build a fake MemoryStore backed by a mutable array per scope.
 * This does NOT implement `stats`, `listSage`, or `retrieveForPath`,
 * so the command takes the legacy path.
 */
function fakeMemoryStore(entries: Partial<Record<MemoryScope, MemoryEntry[]>>): MemoryPort {
  const store: Partial<Record<MemoryScope, MemoryEntry[]>> = {};
  for (const [scope, list] of Object.entries(entries)) {
    store[scope as MemoryScope] = list ? [...list] : [];
  }
  const legacy: MemoryStore = {
    list: async (scope?: MemoryScope) => store[scope ?? 'project-memory'] ?? [],
    readAll: async () => '',
    read: async (_scope: MemoryScope) => '',
    remember: async () => {},
    forget: async () => 0,
    consolidate: async () => {},
    clear: async () => {},
    search: async () => [],
    withTraceId: () => legacy,
  };
  return new LegacyMemoryPortAdapter(legacy, 'test-legacy');
}

/**
 * Build a fake Sage store. Implements `stats`, `listSage`, and
 * `retrieveForPath` so the command takes the Sage path.
 */
function fakeSageStore(memories: SageTestEntry[]) {
  const port = {
    list: async () => [],
    readAll: async () => '',
    read: async () => '',
    remember: async () => {},
    forget: async () => 0,
    consolidate: async () => {},
    clear: async () => {},
    search: async () => [],
    withTraceId: () => port,
    initialize: async () => {},
    health: async () => ({ status: 'ready' as const, backend: 'test-sage' }),
    dispose: async () => {},
    getCapability: <T>(capability: MemoryCapability<T>): T | undefined =>
      capability.id === SAGE_SURFACE_CAPABILITY.id ? (port as unknown as T) : undefined,

    // ── Sage duck-type methods ──
    stats: async () => {
      const total = memories.length;
      const byStatus: Record<string, number> = {
        active: 0,
        stale: 0,
        superseded: 0,
        contradicted: 0,
        archived: 0,
        deleted: 0,
      };
      const byKind: Record<string, number> = {};
      for (const m of memories) {
        byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
        byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
      }
      return { total, byStatus, byKind, edges: 3 };
    },
    listSage: async () => memories.map(sageEntry),
    retrieveForPath: async (opts: { path: string }) =>
      memories.filter((m) => m.anchors?.some((a) => a.path?.includes(opts.path))).map(sageEntry),
    searchSage: async () => [],
    rememberSage: async (input: { text: string }) =>
      sageEntry({
        id: 'mem_new',
        kind: 'fact',
        status: 'active',
        text: input.text,
        tags: [],
        createdAt: new Date('2026-07-14T12:00:00Z').toISOString(),
      }),
    updateSage: async (id: string) =>
      sageEntry({
        id,
        kind: 'fact',
        status: 'active',
        text: 'updated',
        tags: [],
        createdAt: new Date('2026-07-14T12:00:00Z').toISOString(),
      }),
    deleteSage: async () => {},
    getSage: async (id: string) =>
      sageEntry({
        id,
        kind: 'fact',
        status: 'active',
        text: 'x',
        tags: [],
        createdAt: new Date('2026-07-14T12:00:00Z').toISOString(),
      }),
    graphFor: async () => [],
  };
  return port as typeof port & MemoryPort & SageSurface;
}

interface SageTestEntry {
  id: string;
  kind: string;
  status: string;
  text: string;
  tags: string[];
  createdAt: string;
  anchors?: Array<{ type: string; path?: string; symbol?: string; command?: string }>;
}

function sageEntry(e: SageTestEntry) {
  return {
    id: e.id,
    kind: e.kind,
    status: e.status,
    text: e.text,
    tags: e.tags,
    createdAt: e.createdAt,
    updatedAt: e.createdAt,
    importance: 0.5,
    confidence: 0.8,
    anchors: e.anchors ?? [],
    sources: [{ type: 'user' as const }],
  };
}

function entry(text: string, overrides?: Partial<MemoryEntry>): MemoryEntry {
  return {
    scope: 'project-memory',
    text,
    ts: new Date('2026-07-14T12:00:00Z').toISOString(),
    type: 'fact',
    priority: 'medium',
    tags: ['test'],
    ...overrides,
  };
}

function run(cmd: ReturnType<typeof createMemorySlashCommand>, args = ''): Promise<string> {
  return cmd.run(args).then((r) => (r as { message: string }).message);
}

describe('/memory slash command', () => {
  // ── Legacy path ─────────────────────────────────────────────────────────

  describe('legacy store', () => {
    it('returns empty message with migration hint when all scopes are empty', async () => {
      const deps: MemorySlashDeps = { memoryStore: fakeMemoryStore({}) };
      const cmd = createMemorySlashCommand(deps);
      const out = await run(cmd);
      expect(out).toContain('No memory entries found');
      expect(out).toContain('SAGE');
    });

    it('lists entries from project-memory in rich format', async () => {
      const deps: MemorySlashDeps = {
        memoryStore: fakeMemoryStore({
          'project-memory': [
            entry('A key design decision', {
              type: 'decision',
              priority: 'high',
              tags: ['design', 'arch'],
            }),
          ],
        }),
      };
      const cmd = createMemorySlashCommand(deps);
      const out = await run(cmd);
      // Stats summary
      expect(out).toContain('Memory Overview');
      expect(out).toContain('decision');
      expect(out).toContain('high');
      // Migration hint
      expect(out).toContain('SAGE');
      // Entry content
      expect(out).toContain('A key design decision');
      // Footer
      expect(out).toContain('1 entry');
    });

    it('shows entries from all three scopes when no argument is given', async () => {
      const deps: MemorySlashDeps = {
        memoryStore: fakeMemoryStore({
          'project-agents': [
            entry('Agent coordination fact', { scope: 'project-agents', tags: ['agents'] }),
          ],
          'project-memory': [entry('Project note', { scope: 'project-memory', tags: ['project'] })],
          'user-memory': [entry('Personal preference', { scope: 'user-memory', tags: ['user'] })],
        }),
      };
      const cmd = createMemorySlashCommand(deps);
      const out = await run(cmd);
      expect(out).toContain('AGENTS.md');
      expect(out).toContain('Project memory');
      expect(out).toContain('User memory');
      expect(out).toContain('3 entries across');
    });

    it('filters to a single scope when given as argument', async () => {
      const deps: MemorySlashDeps = {
        memoryStore: fakeMemoryStore({
          'project-agents': [entry('agents-1', { scope: 'project-agents' })],
          'project-memory': [entry('proj-1', { scope: 'project-memory' })],
          'user-memory': [entry('user-1', { scope: 'user-memory' })],
        }),
      };
      const cmd = createMemorySlashCommand(deps);
      const out = await run(cmd, 'user-memory');
      expect(out).toContain('User memory');
      expect(out).not.toContain('Project memory');
      expect(out).not.toContain('AGENTS.md');
      expect(out).toContain('1 entry');
    });

    it('truncates long text previews with ellipsis', async () => {
      const longText =
        'A very long memory entry that should be truncated because it exceeds the one hundred character preview limit in the output for the legacy rich entry renderer';
      const deps: MemorySlashDeps = {
        memoryStore: fakeMemoryStore({
          'project-memory': [entry(longText)],
        }),
      };
      const cmd = createMemorySlashCommand(deps);
      const out = await run(cmd);
      expect(out).toContain('…');
    });

    it('renders empty scope gracefully without crashing on invalid timestamps', async () => {
      const deps: MemorySlashDeps = {
        memoryStore: fakeMemoryStore({
          'project-memory': [{ scope: 'project-memory', text: 'Minimal entry', ts: '' }],
        }),
      };
      const cmd = createMemorySlashCommand(deps);
      const out = await run(cmd);
      // Should not crash — invalid ts renders as '—' placeholder
      expect(out).not.toContain('Failed');
      expect(out).toContain('Minimal entry');
      expect(out).toContain('—');
    });

    it('handles malformed timestamps without crashing', async () => {
      const deps: MemorySlashDeps = {
        memoryStore: fakeMemoryStore({
          'project-memory': [
            { scope: 'project-memory', text: 'Bad date entry', ts: 'not-a-date' },
            { scope: 'project-memory', text: 'Good entry', ts: '2026-07-14T12:00:00Z' },
          ],
        }),
      };
      const cmd = createMemorySlashCommand(deps);
      const out = await run(cmd);
      // Should not crash or say "Failed"
      expect(out).not.toContain('Failed');
      expect(out).toContain('Bad date entry');
      expect(out).toContain('Good entry');
    });

    it('reports an error when memoryStore.list rejects', async () => {
      const brokenLegacy: MemoryStore = {
        list: async () => {
          throw new Error('disk failure');
        },
        readAll: async () => '',
        read: async () => '',
        remember: async () => {},
        forget: async () => 0,
        consolidate: async () => {},
        clear: async () => {},
        search: async () => [],
        withTraceId: () => brokenLegacy,
      };
      const brokenStore = new LegacyMemoryPortAdapter(brokenLegacy, 'test-broken');
      const deps: MemorySlashDeps = { memoryStore: brokenStore };
      const cmd = createMemorySlashCommand(deps);
      const out = await run(cmd);
      expect(out).toContain('Failed to read memory store');
      expect(out).toContain('disk failure');
    });

    it('pluralises "entries" correctly for a single entry', async () => {
      const deps: MemorySlashDeps = {
        memoryStore: fakeMemoryStore({
          'project-memory': [entry('only one')],
        }),
      };
      const cmd = createMemorySlashCommand(deps);
      const out = await run(cmd);
      expect(out).toContain('1 entry');
    });

    it('pluralises "entries" correctly for multiple entries', async () => {
      const deps: MemorySlashDeps = {
        memoryStore: fakeMemoryStore({
          'project-memory': [entry('a'), entry('b')],
        }),
      };
      const cmd = createMemorySlashCommand(deps);
      const out = await run(cmd);
      expect(out).toContain('2 entries');
    });

    it('filters by tag in legacy mode', async () => {
      const deps: MemorySlashDeps = {
        memoryStore: fakeMemoryStore({
          'project-memory': [
            entry('TypeScript config', { tags: ['typescript', 'config'] }),
            entry('Rust setup', { tags: ['rust'] }),
          ],
        }),
      };
      const cmd = createMemorySlashCommand(deps);
      const out = await run(cmd, '--tag rust');
      expect(out).toContain('Rust setup');
      expect(out).not.toContain('TypeScript config');
    });
  });

  // ── Sage path ────────────────────────────────────────────────────

  describe('SAGE store', () => {
    const fixtMemories: SageTestEntry[] = [
      {
        id: 'mem_001',
        kind: 'decision',
        status: 'active',
        text: 'Use pnpm workspaces',
        tags: ['pnpm', 'monorepo'],
        createdAt: '2026-07-14T12:00:00Z',
      },
      {
        id: 'mem_002',
        kind: 'convention',
        status: 'active',
        text: 'ESM-only modules',
        tags: ['esm', 'typescript'],
        createdAt: '2026-07-13T12:00:00Z',
        anchors: [{ type: 'file', path: 'src/config.ts' }],
      },
      {
        id: 'mem_003',
        kind: 'fact',
        status: 'stale',
        text: 'Old node version requirement',
        tags: ['node'],
        createdAt: '2026-06-01T12:00:00Z',
      },
    ];

    it('shows Sage stats panel', async () => {
      const store = fakeSageStore(fixtMemories);
      const cmd = createMemorySlashCommand({ memoryStore: store });
      const out = await run(cmd);
      // Stats panel
      expect(out).toContain('SAGE');
      expect(out).toContain('3 memories');
      expect(out).toContain('active');
      expect(out).toContain('stale');
      expect(out).toContain('Graph edges');
      // By kind breakdown
      expect(out).toContain('decision');
      expect(out).toContain('convention');
      expect(out).toContain('fact');
      // Tag cloud
      expect(out).toContain('pnpm');
      expect(out).toContain('esm');
      // Entry cards
      expect(out).toContain('Use pnpm workspaces');
      expect(out).toContain('ESM-only modules');
      expect(out).toContain('Old node version');
    });

    it('filters by tag', async () => {
      const store = fakeSageStore(fixtMemories);
      const cmd = createMemorySlashCommand({ memoryStore: store });
      const out = await run(cmd, '--tag esm');
      expect(out).toContain('ESM-only modules');
      expect(out).not.toContain('Use pnpm workspaces');
      expect(out).not.toContain('Old node version');
    });

    it('filters by path', async () => {
      const store = fakeSageStore(fixtMemories);
      const cmd = createMemorySlashCommand({ memoryStore: store });
      const out = await run(cmd, '--path src/config.ts');
      expect(out).toContain('ESM-only modules');
      expect(out).not.toContain('Use pnpm workspaces');
      expect(out).not.toContain('Old node version');
    });

    it('shows compact table format with --compact', async () => {
      const store = fakeSageStore(fixtMemories);
      const cmd = createMemorySlashCommand({ memoryStore: store });
      const out = await run(cmd, '--compact');
      expect(out).toContain('mem_001');
      expect(out).toContain('mem_002');
      expect(out).toContain('mem_003');
    });

    it('shows persisted graph edge evidence', async () => {
      const store = fakeSageStore(fixtMemories);
      const graphFor = vi.fn(async () => [
        {
          from: 'mem:mem_001',
          to: 'mem:mem_002',
          relation: 'same_topic',
          weight: 0.82,
          evidence: ['tag:typescript', 'path:src/config.ts'],
        },
      ]);
      (store as unknown as { graphFor: typeof graphFor }).graphFor = graphFor;
      const cmd = createMemorySlashCommand({ memoryStore: store });

      const out = await run(cmd, 'graph mem_001');

      expect(graphFor).toHaveBeenCalledWith('mem_001', 2, 100);
      expect(out).toContain('same_topic:0.82');
      expect(out).toContain('why: tag:typescript, path:src/config.ts');
    });

    it('returns empty message when no super memories exist', async () => {
      const store = fakeSageStore([]);
      const cmd = createMemorySlashCommand({ memoryStore: store });
      const out = await run(cmd);
      expect(out).toContain('SAGE is empty');
    });

    it('remember subcommand forwards structured flags to rememberSage', async () => {
      const store = fakeSageStore([]);
      const rememberSage = vi.fn(async (input: { text: string }) => ({
        id: 'mem_new',
        kind: 'convention',
        status: 'active',
        text: input.text,
        tags: ['pnpm'],
        createdAt: '',
        updatedAt: '',
        importance: 0.9,
        confidence: 0.8,
        anchors: [],
        sources: [],
      }));
      (store as unknown as { rememberSage: typeof rememberSage }).rememberSage = rememberSage;
      const cmd = createMemorySlashCommand({ memoryStore: store });
      const out = await run(
        cmd,
        'remember Project uses pnpm --kind convention --tag pnpm --importance 0.9',
      );
      expect(rememberSage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Project uses pnpm',
          kind: 'convention',
          tags: ['pnpm'],
          importance: 0.9,
        }),
      );
      expect(out).toContain('Remembered');
    });

    it('update and delete subcommands dispatch by id', async () => {
      const store = fakeSageStore([]);
      const updateSage = vi.fn(async (id: string) => ({
        id,
        kind: 'fact',
        status: 'archived',
        text: 'x',
        tags: [],
        createdAt: '',
        updatedAt: '',
        importance: 0.5,
        confidence: 0.8,
        anchors: [],
        sources: [],
      }));
      const deleteSage = vi.fn(async () => {});
      (store as unknown as { updateSage: typeof updateSage }).updateSage = updateSage;
      (store as unknown as { deleteSage: typeof deleteSage }).deleteSage = deleteSage;
      const cmd = createMemorySlashCommand({ memoryStore: store });

      await run(cmd, 'update mem_123 --status archived');
      expect(updateSage).toHaveBeenCalledWith('mem_123', { status: 'archived' });

      const out = await run(cmd, 'delete mem_123 obsolete');
      expect(deleteSage).toHaveBeenCalledWith('mem_123', 'obsolete');
      expect(out).toContain('Deleted');
    });

    it('rejects an invalid --kind without calling rememberSage', async () => {
      const store = fakeSageStore([]);
      const rememberSage = vi.fn();
      (store as unknown as { rememberSage: typeof rememberSage }).rememberSage = rememberSage;
      const cmd = createMemorySlashCommand({ memoryStore: store });
      const out = await run(cmd, 'remember hello --kind bogus');
      expect(out).toContain('--kind must be one of');
      expect(rememberSage).not.toHaveBeenCalled();
    });

    it('handles Sage store errors gracefully', async () => {
      const brokenStore = fakeSageStore([]);
      Object.assign(brokenStore, {
        list: async () => {
          throw new Error('broken');
        },
        readAll: async () => '',
        read: async () => '',
        remember: async () => {},
        forget: async () => 0,
        consolidate: async () => {},
        clear: async () => {},
        search: async () => [],
        stats: async () => {
          throw new Error('stats failure');
        },
        listSage: async () => {
          throw new Error('list failure');
        },
        retrieveForPath: async () => {
          throw new Error('path failure');
        },
        searchSage: async () => [],
      });
      const deps: MemorySlashDeps = { memoryStore: brokenStore };
      const cmd = createMemorySlashCommand(deps);
      const out = await run(cmd);
      expect(out).toContain('Failed to read memory store');
    });

    // ── Bounded display (regression: /memory must not dump every entry) ──

    it('caps displayed SAGE entries to the default limit and reports total', async () => {
      // Seed 200 memories but only expect to see the first 50 by default.
      const many: SageTestEntry[] = [];
      for (let i = 0; i < 200; i++) {
        many.push({
          id: `mem_${String(i).padStart(3, '0')}`,
          kind: 'fact',
          status: 'active',
          text: `Bulk memory ${i}`,
          tags: ['bulk'],
          createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        });
      }
      const store = fakeSageStore(many);
      // listSage returns the full set (mimicking the real backend); the
      // implementation must slice to the default limit, not trust the stub.
      const listSage = vi.fn(async () => many.map(sageEntry));
      (store as unknown as { listSage: typeof listSage }).listSage = listSage;

      const cmd = createMemorySlashCommand({ memoryStore: store });
      const out = await run(cmd);

      // Footer must show "50 of 200" — proves we did not dump all 200.
      expect(out).toContain('50 of 200');
      // Must include the "use /memory --limit" hint because more is available.
      expect(out).toContain('/memory --limit');
      // First entry must be in the output, last must not.
      expect(out).toContain('Bulk memory 0');
      expect(out).not.toContain('Bulk memory 199');
      expect(out).not.toContain('Bulk memory 50');
      // Falls back to listSage when listSagePage is unavailable.
      expect(listSage).toHaveBeenCalled();
    });

    it('uses listSagePage when available and honors --limit', async () => {
      const many: SageTestEntry[] = [];
      for (let i = 0; i < 200; i++) {
        many.push({
          id: `mem_${String(i).padStart(3, '0')}`,
          kind: 'fact',
          status: 'active',
          text: `Paged memory ${i}`,
          tags: ['paged'],
          createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        });
      }
      const store = fakeSageStore(many);
      const listSagePage = vi.fn(async ({ limit }: { limit: number }) => ({
        memories: many.slice(0, limit).map(sageEntry),
        nextCursor: limit < 200 ? 'cursor-next' : null,
        total: 200,
        statusCounts: { active: 200 },
      }));
      (store as unknown as { listSagePage: typeof listSagePage }).listSagePage = listSagePage;

      const cmd = createMemorySlashCommand({ memoryStore: store });
      const out = await run(cmd, '--limit 100');

      // listSagePage called exactly once with the requested limit.
      expect(listSagePage).toHaveBeenCalledTimes(1);
      expect(listSagePage).toHaveBeenCalledWith({ limit: 100 });
      // Footer shows "100 of 200" — proves paging took effect.
      expect(out).toContain('100 of 200');
      expect(out).toContain('Paged memory 0');
      expect(out).not.toContain('Paged memory 199');
      expect(out).not.toContain('Paged memory 100');
    });

    it('clamps an absurd --limit to the maximum', async () => {
      const store = fakeSageStore(fixtMemories);
      const listSagePage = vi.fn(async () => ({
        memories: fixtMemories.map(sageEntry),
        nextCursor: null,
        total: fixtMemories.length,
        statusCounts: { active: 2, stale: 1 },
      }));
      (store as unknown as { listSagePage: typeof listSagePage }).listSagePage = listSagePage;

      const cmd = createMemorySlashCommand({ memoryStore: store });
      await run(cmd, '--limit 99999');

      // 99999 must be clamped — the implementation cap is 500.
      expect(listSagePage).toHaveBeenCalledWith({ limit: 500 });
    });

    it('falls back to listSage when listSagePage is absent', async () => {
      const store = fakeSageStore(fixtMemories);
      // Intentionally do not stub listSagePage — the fake fixture does not
      // provide it, so the implementation should call listSage().
      const listSage = vi.fn(async () => fixtMemories.map(sageEntry));
      (store as unknown as { listSage: typeof listSage }).listSage = listSage;

      const cmd = createMemorySlashCommand({ memoryStore: store });
      const out = await run(cmd);

      expect(listSage).toHaveBeenCalled();
      expect(out).toContain('Use pnpm workspaces');
    });
  });

  describe('legacy bounded display', () => {
    it('caps displayed legacy entries across scopes and hints to use --limit', async () => {
      // Seed 60 project-memory entries — well above the per-scope default
      // budget of floor(50 / 3) = 16.
      const lots = Array.from({ length: 60 }, (_, i) => entry(`legacy-${i}`, { tags: ['legacy'] }));
      const deps: MemorySlashDeps = {
        memoryStore: fakeMemoryStore({
          'project-memory': lots,
        }),
      };
      const cmd = createMemorySlashCommand(deps);
      const out = await run(cmd);

      // Footer should announce a subset shown.
      expect(out).toContain('of 60');
      expect(out).toContain('/memory --limit');
      // First entry should be in the output...
      expect(out).toContain('legacy-0');
      // ...and late entries (beyond the per-scope budget) should be hidden.
      expect(out).not.toContain('legacy-59');
    });

    it('honors --limit for legacy entries', async () => {
      const lots = Array.from({ length: 30 }, (_, i) => entry(`item-${i}`, { tags: ['x'] }));
      const deps: MemorySlashDeps = {
        memoryStore: fakeMemoryStore({
          'project-memory': lots,
        }),
      };
      const cmd = createMemorySlashCommand(deps);
      const out = await run(cmd, '--limit 5');
      expect(out).toContain('item-0');
      expect(out).toContain('item-4');
      expect(out).not.toContain('item-5');
      expect(out).not.toContain('item-29');
    });
  });
});
