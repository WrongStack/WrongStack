import type {
  MemoryCapability,
  MemoryEntry,
  MemoryPort,
  MemoryRelevanceContext,
  ScoredEntry,
} from '@wrongstack/core/types';

/**
 * Minimal in-memory {@link MemoryStore} for tests. Replaces the deleted
 * `DefaultMemoryStore` as a lightweight, file-I/O-free store stub. Deterministic
 * and isolated per instance — no persistence, no cross-test contamination.
 */
export function makeFakeMemoryStore(): MemoryPort {
  const entries: MemoryEntry[] = [];
  const store: MemoryPort = {
    async initialize() {},
    getCapability<T>(_capability: MemoryCapability<T>): T | undefined {
      return undefined;
    },
    async health() {
      return { status: 'ready', backend: 'test-memory' };
    },
    async dispose() {},
    async remember(text, scope = 'project-memory', metadata) {
      entries.unshift({
        scope,
        text,
        ts: new Date().toISOString(),
        ...(metadata?.type !== undefined && { type: metadata.type }),
        ...(metadata?.tags !== undefined && { tags: metadata.tags }),
        ...(metadata?.priority !== undefined && { priority: metadata.priority }),
      });
    },
    async forget(query, scope = 'project-memory') {
      const before = entries.length;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e && e.scope === scope && e.text.toLowerCase().includes(query.toLowerCase())) {
          entries.splice(i, 1);
        }
      }
      return before - entries.length;
    },
    async list(scope = 'project-memory', limit) {
      const filtered = entries.filter((e) => e.scope === scope);
      return limit === undefined ? filtered : filtered.slice(0, limit);
    },
    async search(query, scope = 'project-memory', limit) {
      const q = query.toLowerCase();
      const hits = entries.filter((e) => e.scope === scope && e.text.toLowerCase().includes(q));
      return limit === undefined ? hits : hits.slice(0, limit);
    },
    async scoreRelevant(
      _ctx: MemoryRelevanceContext,
      scope = 'project-memory',
      limit = 8,
    ): Promise<ScoredEntry[]> {
      return entries
        .filter((e) => e.scope === scope)
        .slice(0, limit)
        .map((e) => ({ ...e, score: 1, matchReason: 'fake relevance' }));
    },
    async readAll() {
      return entries.map((e) => `- ${e.text}`).join('\n');
    },
    async read(scope) {
      return entries
        .filter((e) => e.scope === scope)
        .map((e) => `- ${e.text}`)
        .join('\n');
    },
    async consolidate() {},
    async clear(scope) {
      if (scope === undefined) entries.length = 0;
      else
        for (let i = entries.length - 1; i >= 0; i--)
          if (entries[i]?.scope === scope) entries.splice(i, 1);
    },
    withTraceId() {
      return store;
    },
  };
  return store;
}
