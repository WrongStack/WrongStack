import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';

describe('SQLite recovery and file memory operations', () => {
  const stores: SqliteSageStore[] = [];
  const directories: string[] = [];

  async function createStore(): Promise<SqliteSageStore> {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-recovery-'));
    directories.push(projectRoot);
    const store = new SqliteSageStore({ projectRoot });
    stores.push(store);
    await store.initialize();
    return store;
  }

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    await Promise.all(
      directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  it('recovers a deleted memory in place with a new revision', async () => {
    const store = await createStore();
    const created = await store.rememberSage({
      text: 'Recovery contract',
      anchors: [{ type: 'file', path: 'src/recovery.ts' }],
    });
    await store.deleteSage(created.id, 'test deletion', { force: true });

    const recovered = await store.recoverSage(created.id, 'test recovery');

    expect(recovered.status).toBe('active');
    expect(recovered.revision).toBe(created.revision + 2);
    expect((await store.getSage(created.id))?.status).toBe('active');
  });

  it('dry-runs then applies recoverable backfill idempotently', async () => {
    const store = await createStore();
    const created = await store.rememberSage({
      text: 'Backfill contract',
      sources: [{ type: 'test' }],
    });
    await store.deleteSage(created.id, 'test deletion', { force: true });

    const preview = await store.backfillRecoverable({ dryRun: true });
    expect(preview.recoverable).toBe(1);
    expect(preview.recovered).toBe(0);

    const applied = await store.backfillRecoverable({ dryRun: false });
    expect(applied.recovered).toBe(1);
    expect(applied.recoverableRecords[0]?.newActiveId).toBeDefined();

    const repeated = await store.backfillRecoverable({ dryRun: false });
    expect(repeated.recovered).toBe(0);
    expect(repeated.byReason['already_recovered']).toBe(1);
  });

  it('groups exact file, symbol, and textual matches for WebUI consumers', async () => {
    const store = await createStore();
    await store.rememberSage({
      text: 'Exact file memory',
      scope: 'file',
      anchors: [{ type: 'file', path: 'src/widget.ts' }],
    });
    await store.rememberSage({
      text: 'Widget symbol memory',
      scope: 'symbol',
      anchors: [
        {
          type: 'symbol',
          path: 'src/widget.ts',
          symbol: 'renderWidget',
          lineStart: 10,
          lineEnd: 20,
        },
      ],
    });
    await store.rememberSage({ text: 'Remember to inspect widget.ts when debugging.' });

    const result = await store.findMemoriesForFile('src/widget.ts', {
      lineStart: 12,
      lineEnd: 14,
    });

    expect(result.filePath).toBe('src/widget.ts');
    expect(result.primaryMatches).toHaveLength(1);
    expect(result.symbolMatches).toHaveLength(1);
    expect(result.symbolMatches[0]?.matchStrength).toBe(1);
    expect(result.relatedMatches).toHaveLength(1);
    expect(result.totalCount).toBe(3);
  });
});
