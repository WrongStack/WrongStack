import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import { SessionCatalogStore } from '../../src/session-catalog/store.js';
import type { SessionEvent } from '../../src/types/session.js';

let tmp: string;
let store: DefaultSessionStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sess-archive-'));
  store = new DefaultSessionStore({
    dir: tmp,
    storage: { hotKeepSessions: 1, archiveAfterDays: 0, autoArchive: false, includeSubagents: true },
  });
});

afterEach(async () => {
  await store.dispose?.();
  await fs.rm(tmp, { recursive: true, force: true });
});

function startEvent(id: string, ts: string): SessionEvent {
  return { type: 'session_start', ts, id, model: 'm', provider: 'p' };
}

async function writeClosedSession(id: string, ts: string, user: string): Promise<void> {
  const writer = await store.create({ id, model: 'm', provider: 'p' });
  await writer.append(startEvent(id, ts));
  await writer.append({ type: 'user_input', ts, content: user });
  await writer.append({
    type: 'llm_response',
    ts,
    content: [{ type: 'text', text: 'ok' }],
    stopReason: 'end_turn',
    usage: { input: 10, output: 4 },
    model: 'm',
    provider: 'p',
  });
  await writer.append({
    type: 'session_end',
    ts,
    usage: { input: 10, output: 4 },
  });
  await writer.close();
}

describe('session transcript archive', () => {
  it('loads a gzip-only journal without rehydrating', async () => {
    const id = '2020-01-01/cold-load';
    await writeClosedSession(id, '2020-01-01T00:00:00.000Z', 'remember this prompt');
    const archived = await store.archive(id);
    expect(archived.action).toBe('archived');
    expect(archived.compressedBytes).toBeGreaterThan(0);
    await expect(fs.stat(path.join(tmp, `${id}.jsonl`))).rejects.toBeDefined();
    await expect(fs.stat(path.join(tmp, `${id}.jsonl.gz`))).resolves.toMatchObject({ size: expect.any(Number) });

    const data = await store.load(id);
    expect(
      data.events.some(
        (event) => event.type === 'user_input' && String(event.content).includes('remember this prompt'),
      ),
    ).toBe(true);
    await expect(fs.stat(path.join(tmp, `${id}.jsonl.gz`))).resolves.toBeDefined();
    await expect(fs.stat(path.join(tmp, `${id}.jsonl`))).rejects.toBeDefined();
  });

  it('replaces a leftover gzip dest atomically (Windows rename-over-file)', async () => {
    const id = 'replace-dest';
    await writeClosedSession(id, '2020-01-01T00:00:00.000Z', 'replace dest');
    const dest = path.join(tmp, `${id}.jsonl.gz`);
    await fs.writeFile(dest, 'stale-not-gzip');
    const archived = await store.archive(id);
    expect(archived.action).toBe('archived');
    const data = await store.load(id);
    expect(
      data.events.some(
        (event) => event.type === 'user_input' && String(event.content).includes('replace dest'),
      ),
    ).toBe(true);
  });

  it('rehydrates on resume so the writer can append', async () => {
    const id = '2020-01-01/cold-resume';
    await writeClosedSession(id, '2020-01-01T00:00:00.000Z', 'resume me');
    await store.archive(id);
    const resumed = await store.resume(id);
    await expect(fs.stat(path.join(tmp, `${id}.jsonl`))).resolves.toBeDefined();
    await expect(fs.stat(path.join(tmp, `${id}.jsonl.gz`))).rejects.toBeDefined();
    await resumed.writer.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'continued',
    });
    await resumed.writer.close();
    const data = await store.load(id);
    expect(data.events.some((event) => event.type === 'session_resumed')).toBe(true);
  });

  it('keeps list() storage state in sync across archive and rehydrate', async () => {
    const id = '2020-01-01/storage-state-sync';
    await writeClosedSession(id, '2020-01-01T00:00:00.000Z', 'state sync');
    await store.archive(id);
    // list() merges scanned rows (built from the per-session manifests) over
    // index rows, so the manifest itself must carry the cold decoration or the
    // archive state is invisible to every picker.
    const cold = (await store.list(10)).find((row) => row.id === id);
    expect(cold?.storageState).toBe('cold');
    expect(cold?.codec).toBe('gzip');

    await store.rehydrate(id);
    const hot = (await store.list(10)).find((row) => row.id === id);
    expect(hot?.storageState).toBe('hot');
    expect(hot?.codec).toBeUndefined();
  });

  it('archiveIdle keeps the newest session hot and gzips the rest', async () => {
    await writeClosedSession('old-a', '2020-01-01T00:00:00.000Z', 'old a');
    await writeClosedSession('old-b', '2020-01-02T00:00:00.000Z', 'old b');
    await writeClosedSession('new-c', new Date().toISOString(), 'new c');
    const result = await store.archiveIdle();
    expect(result.archived).toBeGreaterThanOrEqual(2);
    await expect(fs.stat(path.join(tmp, 'old-a.jsonl.gz'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(tmp, 'old-b.jsonl.gz'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(tmp, 'new-c.jsonl'))).resolves.toBeDefined();
  });

  it('backfill gzips existing logs immediately, ignoring the 7-day window', async () => {
    const delayed = new DefaultSessionStore({
      dir: tmp,
      storage: { hotKeepSessions: 1, archiveAfterDays: 7, autoArchive: false, includeSubagents: true },
    });
    await writeClosedSession('recent-a', new Date().toISOString(), 'recent a');
    await writeClosedSession('recent-b', new Date().toISOString(), 'recent b');
    const withoutBackfill = await delayed.archiveIdle();
    expect(withoutBackfill.archived).toBe(0);
    await expect(fs.stat(path.join(tmp, 'recent-a.jsonl'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(tmp, 'recent-b.jsonl'))).resolves.toBeDefined();

    const withBackfill = await delayed.archiveIdle({ backfill: true });
    expect(withBackfill.archived).toBeGreaterThanOrEqual(1);
    const aGz = await fs.stat(path.join(tmp, 'recent-a.jsonl.gz')).then(
      () => true,
      () => false,
    );
    const bGz = await fs.stat(path.join(tmp, 'recent-b.jsonl.gz')).then(
      () => true,
      () => false,
    );
    expect(aGz || bGz).toBe(true);
    await delayed.dispose?.();
  });

  it('skips live sessions', async () => {
    await writeClosedSession('live-old', '2020-01-01T00:00:00.000Z', 'live');
    const guarded = new DefaultSessionStore({
      dir: tmp,
      isSessionInUse: async (id) => (id === 'live-old' ? 'owner' : null),
      storage: { hotKeepSessions: 1, archiveAfterDays: 0, autoArchive: false },
    });
    const result = await guarded.archive('live-old');
    expect(result.action).toBe('skipped');
    await expect(fs.stat(path.join(tmp, 'live-old.jsonl'))).resolves.toBeDefined();
    await guarded.dispose?.();
  });

  it('rebuilds the catalog from gzip transcripts when a summary sidecar exists', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-catalog-gz-'));
    const id = '2020-01-01/catalog-gz';
    const sessionsDir = path.join(root, 'sessions');
    const catalog = new SessionCatalogStore(root);
    const nested = path.join(sessionsDir, '2020-01-01');
    await fs.mkdir(nested, { recursive: true });
    const jsonl = path.join(nested, 'catalog-gz.jsonl');
    await fs.writeFile(
      jsonl,
      `${JSON.stringify(startEvent(id, '2020-01-01T00:00:00.000Z'))}\n`,
    );
    await fs.writeFile(
      path.join(nested, 'catalog-gz.summary.json'),
      JSON.stringify({
        id,
        title: 'gzip catalog',
        startedAt: '2020-01-01T00:00:00.000Z',
        model: 'm',
        provider: 'p',
        tokenTotal: 0,
      }),
    );
    const local = new DefaultSessionStore({ dir: sessionsDir, storage: { autoArchive: false } });
    await local.archive(id);
    await local.dispose?.();
    const rebuilt = catalog.rebuildCatalog();
    expect(rebuilt.indexed).toBe(1);
    const row = catalog.getSummary(id);
    expect(row?.storageState).toBe('cold');
    expect(row?.transcriptRelativePath).toBe(`${id}.jsonl.gz`);
    catalog.close();
    await fs.rm(root, { recursive: true, force: true });
  });
});
