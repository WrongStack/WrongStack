import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { validateOperationArgs } from '../../src/session-catalog/project-server-operations.js';
import { SessionCatalogStore } from '../../src/session-catalog/store.js';
import { historyPageFromSummaries } from '../../src/storage/session-history-page.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';

it('pages and anchors beyond the legacy 1000-record RPC limit with exact membership/order guards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrongstack-history-pages-'));
  const store = new SessionCatalogStore(root);
  const row = (index: number) => ({
    id: `2026-01-01/sess_page_${String(index).padStart(4, '0')}`,
    title: 'Recorded ' + index,
    provider: 'fixture',
    model: 'model',
    tokenTotal: 0,
    startedAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
  });
  const upsert = (index: number) => {
    const summary = row(index);
    store.upsertSummary(summary, summary.id + '.jsonl', summary.id + '.summary.json');
  };
  try {
    for (let index = 0; index < 1106; index++) upsert(index);
    expect(store.listCatalog({ limit: 5000 })).toHaveLength(1000);
    const excludeId = row(1105).id;
    const first = store.pageCatalog({ limit: 200, excludeId });
    expect(first.total).toBe(1105);
    expect(first.sessions).toHaveLength(200);
    expect(first.nextOffset).toBe(200);
    expect(first.truncated).toBe(false);
    const ids = first.sessions.map((entry) => entry.id);
    let next = first.nextOffset;
    while (next !== null) {
      const page = store.pageCatalog({
        limit: 200,
        offset: next,
        expectedRevision: first.revision,
        excludeId,
      });
      ids.push(...page.sessions.map((entry) => entry.id));
      next = page.nextOffset;
    }
    expect(ids).toHaveLength(1105);
    expect(new Set(ids).size).toBe(1105);
    expect(ids).not.toContain(excludeId);
    expect(ids.at(-1)).toBe(row(0).id);
    const anchor = store.pageCatalog({ limit: 200, anchorId: row(0).id, excludeId });
    expect(anchor.offset).toBe(1000);
    expect(anchor.sessions.some((entry) => entry.id === row(0).id)).toBe(true);
    await store.rename(row(0).id, 'Renamed older record');
    const renamed = store.pageCatalog({
      limit: 200,
      offset: 1000,
      expectedRevision: first.revision,
      excludeId,
    });
    expect(renamed.sessions.find((entry) => entry.id === row(0).id)?.name).toBe(
      'Renamed older record',
    );
    expect(() => store.pageCatalog({ limit: 200, offset: 200, excludeId })).toThrow('requires');
    expect(() => store.pageCatalog({ limit: 201 })).toThrow('1–200');
    expect(() => store.pageCatalog({ anchorId: excludeId, excludeId })).toThrow('no longer');
    validateOperationArgs('page_catalog', { limit: 100, offset: 0, excludeId }, root);
    expect(() =>
      validateOperationArgs('page_catalog', { limit: 100, path: '../outside' }, root),
    ).toThrow('unknown');
    upsert(1106);
    expect(() =>
      store.pageCatalog({ limit: 200, offset: 200, expectedRevision: first.revision, excludeId }),
    ).toThrow('catalog changed');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('preserves legacy file-backed paging and explicitly marks a reached scan budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrongstack-history-pages-'));
  const store = new DefaultSessionStore({ dir: root });
  try {
    for (let index = 0; index < 6; index++) {
      const writer = await store.create({
        id: 'legacy-page-' + index,
        title: 'Legacy',
        provider: 'fixture',
        model: 'model',
      });
      await writer.close();
    }
    const first = await store.listPage({ limit: 2 });
    const second = await store.listPage({
      limit: 2,
      offset: first.nextOffset!,
      expectedRevision: first.revision,
    });
    expect(new Set([...first.sessions, ...second.sessions].map((row) => row.id)).size).toBe(4);
    const bounded = historyPageFromSummaries(await store.list(20), { limit: 2 }, 3);
    expect(bounded.truncated).toBe(true);
    expect(bounded.total).toBe(3);
    const exact = historyPageFromSummaries(await store.list(20), { limit: 10 }, 6);
    expect(exact.total).toBe(6);
    expect(exact.truncated).toBe(false);
    const emptyZero = historyPageFromSummaries([], { limit: 10 }, 0);
    expect(emptyZero.total).toBe(0);
    expect(emptyZero.truncated).toBe(false);
    expect(() => historyPageFromSummaries([], { offset: -1 })).toThrow();
    expect(() => historyPageFromSummaries([], { offset: 1 })).toThrow('requires');
  } finally {
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
