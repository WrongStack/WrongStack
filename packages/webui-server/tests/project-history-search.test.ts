import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { searchProjectHistory } from '../src/server/project-history-search.js';

const owned: string[] = [];
afterEach(async () => {
  for (const root of owned.splice(0)) {
    const target = resolve(root);
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('wrongstack-content-search-')
    )
      throw Error('Unsafe search fixture cleanup');
    await rm(target, { recursive: true, force: true });
  }
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'wrongstack-content-search-'));
  owned.push(dir);
  const store = new DefaultSessionStore({ dir });
  const add = async (id: string, content: string) => {
    const writer = await store.create({ id, title: '', model: 'test', provider: 'test' });
    await writer.append({
      type: 'message_appended',
      version: 1,
      ts: new Date().toISOString(),
      message: { role: 'user', content },
    });
    await writer.close();
  };
  return { dir, store, add };
}
describe('project retained conversation search', () => {
  it('searches an older-than-500 record through catalog continuation with bound query and pool revisions', async () => {
    const h = await fixture();
    await h.add('paged-oldest', 'unique-deep-catalog-needle');
    const writer = await h.store.create({
      id: 'paged-newer-0',
      title: '',
      provider: 'test',
      model: 'test',
    });
    await writer.close();
    // This tests retained-file discovery/search, not hundreds of create/close fsyncs.
    // Seed what the writer leaves on disk (transcript plus its close-time summary
    // manifest) and let the production store discover them. Without the manifests,
    // list() rebuilds and re-hardens 505 of them, and on Windows each 0o600 write
    // spawns icacls: hundreds of process launches that dominate the test.
    const template = await readFile(join(h.dir, 'paged-newer-0.jsonl'), 'utf8');
    const summaryTemplate = await readFile(join(h.dir, 'paged-newer-0.summary.json'), 'utf8');
    for (let index = 1; index < 506; index++) {
      const id = `paged-newer-${index}`;
      await writeFile(join(h.dir, `${id}.jsonl`), template.replaceAll('paged-newer-0', id));
      await writeFile(
        join(h.dir, `${id}.summary.json`),
        summaryTemplate.replaceAll('paged-newer-0', id),
      );
    }
    const pool = await h.store.list(1000);
    const cursor = pool.findIndex((row) => row.id === 'paged-oldest');
    expect(cursor).toBeGreaterThan(500);
    const first = await searchProjectHistory(
      h.store,
      { query: 'unique-deep-catalog-needle', window: 'catalog' },
      '',
    );
    expect(first.total).toBe(507);
    expect(first.results).toHaveLength(0);
    const deep = await searchProjectHistory(
      h.store,
      {
        query: 'unique-deep-catalog-needle',
        window: 'catalog',
        cursor,
        expectedRevision: first.revision,
        catalogRevision: first.catalogRevision,
      },
      '',
    );
    expect(deep.results[0]?.id).toBe('paged-oldest');
    expect(deep.results[0]?.hits[0]?.excerpt).toContain('unique-deep-catalog-needle');
    await expect(
      searchProjectHistory(
        h.store,
        {
          query: 'different query',
          window: 'catalog',
          cursor,
          expectedRevision: first.revision,
          catalogRevision: first.catalogRevision,
        },
        '',
      ),
    ).rejects.toThrow('catalog changed');
    await expect(
      searchProjectHistory(
        h.store,
        {
          query: 'unique-deep-catalog-needle',
          window: 'catalog',
          cursor,
          expectedRevision: first.revision,
        },
        '',
      ),
    ).rejects.toThrow('catalog revision');
    await h.add('paged-new-member', 'new membership');
    await expect(
      searchProjectHistory(
        h.store,
        {
          query: 'unique-deep-catalog-needle',
          window: 'catalog',
          cursor,
          expectedRevision: first.revision,
          catalogRevision: first.catalogRevision,
        },
        '',
      ),
    ).rejects.toThrow('catalog changed');
    await expect(
      searchProjectHistory(
        { list: h.store.list.bind(h.store), load: h.store.load.bind(h.store) },
        { query: 'needle', window: 'catalog' },
        '',
      ),
    ).rejects.toThrow('Update');
  });
  it('keeps exact match counts while bounding each conversation to three excerpts', async () => {
    const h = await fixture();
    const writer = await h.store.create({
      id: 'many-hits',
      title: '',
      model: 'test',
      provider: 'test',
    });
    for (let i = 0; i < 6; i++)
      await writer.append({
        type: 'message_appended',
        version: 1,
        ts: new Date().toISOString(),
        message: { role: 'assistant', content: `Needle message ${i}` },
      });
    await writer.close();
    const found = await searchProjectHistory(h.store, { query: 'needle' }, '');
    expect(found.results[0]?.matching).toBe(6);
    expect(found.results[0]?.hits.map((hit) => hit.messageIndex)).toEqual([0, 1, 2]);
  });
  it('pages a stable project catalog and refuses a changed search or candidate pool', async () => {
    const h = await fixture();
    for (let i = 0; i < 7; i++) await h.add(`record-${i}`, `Needle ${i}`);
    const before = await readFile(join(h.dir, 'record-0.jsonl'), 'utf8');
    const first = await searchProjectHistory(h.store, { query: 'Needle', window: 100 }, 'record-0');
    expect(first.total).toBe(6);
    expect(first.scanned).toBe(5);
    expect(first.nextCursor).toBe(5);
    expect(first.results).toHaveLength(5);
    expect(first.results.every((row) => row.id !== 'record-0')).toBe(true);
    const next = await searchProjectHistory(
      h.store,
      { query: 'Needle', window: 100, cursor: 5, expectedRevision: first.revision },
      'record-0',
    );
    expect(next.nextCursor).toBeNull();
    expect(next.results).toHaveLength(1);
    expect(new Set([...first.results, ...next.results].map((row) => row.id)).size).toBe(6);
    await expect(
      searchProjectHistory(
        h.store,
        { query: 'other', cursor: 5, expectedRevision: first.revision },
        'record-0',
      ),
    ).rejects.toThrow('catalog changed');
    await h.add('new-record', 'Needle');
    await expect(
      searchProjectHistory(
        h.store,
        { query: 'Needle', cursor: 5, expectedRevision: first.revision },
        'record-0',
      ),
    ).rejects.toThrow('catalog changed');
    expect(await readFile(join(h.dir, 'record-0.jsonl'), 'utf8')).toBe(before);
  });
  it('searches retained messages beyond excerpts, excluding replaced text and opaque media', async () => {
    const h = await fixture();
    const writer = await h.store.create({
      id: 'retained',
      title: '',
      model: 'test',
      provider: 'test',
    });
    await writer.append({
      type: 'message_appended',
      version: 1,
      ts: new Date().toISOString(),
      message: { role: 'user', content: 'Discarded secret-needle' },
    });
    await writer.append({
      type: 'messages_replaced',
      version: 1,
      ts: new Date().toISOString(),
      messages: [
        { role: 'assistant', content: 'x'.repeat(70000) + ' Visible needle 🌈' },
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'opaque-needle' },
            },
          ],
        },
      ],
    });
    await writer.close();
    expect(
      (await searchProjectHistory(h.store, { query: 'secret-needle' }, '')).results,
    ).toHaveLength(0);
    expect(
      (await searchProjectHistory(h.store, { query: 'opaque-needle' }, '')).results,
    ).toHaveLength(0);
    const found = await searchProjectHistory(
      h.store,
      { query: 'visible needle', role: 'assistant' },
      '',
    );
    expect(found.results[0]?.hits[0]?.messageIndex).toBe(0);
    expect(found.results[0]?.hits[0]?.excerpt).toContain('Visible needle 🌈');
    expect(found.results[0]?.hits[0]?.excerpt.length).toBeLessThanOrEqual(360);
    expect(
      (await searchProjectHistory(h.store, { query: 'visible needle', role: 'user' }, '')).results,
    ).toHaveLength(0);
  });
  it('reports unreadable journals and rejects invalid or unversioned continuation requests', async () => {
    const h = await fixture();
    await h.add('unreadable', 'needle');
    await unlink(join(h.dir, 'unreadable.jsonl'));
    const result = await searchProjectHistory(h.store, { query: 'needle' }, '');
    expect(result.errors.map((row) => row.id)).toEqual(['unreadable']);
    expect(result.results).toHaveLength(0);
    for (const options of [
      { query: 'x' },
      { query: 'ok', window: 501 },
      { query: 'ok', cursor: -1 },
      { query: 'ok', role: 'bad' },
      { query: 'ok', cursor: 1 },
    ])
      await expect(searchProjectHistory(h.store, options, '')).rejects.toThrow();
  });
});
