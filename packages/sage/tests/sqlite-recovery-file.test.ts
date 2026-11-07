import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('recovering a tombstone already restored by backfill returns the successor, not a second copy', async () => {
    const store = await createStore();
    const created = await store.rememberSage({
      text: 'Backfill successor contract',
      sources: [{ type: 'test' }],
    });
    await store.deleteSage(created.id, 'test deletion', { force: true });
    const applied = await store.backfillRecoverable({ dryRun: false });
    const successorId = applied.recoverableRecords[0]?.newActiveId;
    expect(successorId).toBeDefined();

    const recovered = await store.recoverSage(created.id, 'late manual recovery');

    expect(recovered.id).toBe(successorId);
    expect((await store.getSage(created.id))?.status).toBe('deleted');
    const live = (await store.listSage(['active'])).filter(
      (m) => m.text === 'Backfill successor contract',
    );
    expect(live).toHaveLength(1);
  });

  it('overlapping backfill applies never create a second active copy', async () => {
    const store = await createStore();
    const created = await store.rememberSage({
      text: 'Overlapping backfill contract',
      sources: [{ type: 'test' }],
    });
    await store.deleteSage(created.id, 'test deletion', { force: true });

    // Two applies started together both scan the tombstone before either write
    // pass runs (runMutation defers behind the file lock), so the write pass
    // must re-check for an already-created successor under the lock.
    const [a, b] = await Promise.all([
      store.backfillRecoverable({ dryRun: false }),
      store.backfillRecoverable({ dryRun: false }),
    ]);

    const live = (await store.listSage(['active'])).filter(
      (m) => m.text === 'Overlapping backfill contract',
    );
    expect(live).toHaveLength(1);
    expect(a.recovered + b.recovered).toBe(1);
    expect((a.byReason['race_lost'] ?? 0) + (b.byReason['race_lost'] ?? 0)).toBe(1);
  });

  it('backfill does not restore a deleted memory whose knowledge is already active', async () => {
    const store = await createStore();
    const first = await store.rememberSage({
      text: 'Auth tokens rotate every 24 hours',
      sources: [{ type: 'test' }],
    });
    await store.deleteSage(first.id, 'test deletion', { force: true });
    await store.rememberSage({
      text: 'Auth tokens rotate every 24 hours',
      sources: [{ type: 'test' }],
    });

    const preview = await store.backfillRecoverable({ dryRun: true });

    expect(preview.recoverable).toBe(0);
    expect(preview.byReason['duplicate_active']).toBe(1);
  });

  it('backfill clears a carried stale reason and announces each restored memory', async () => {
    const store = await createStore();
    const events: Array<{ memoryId?: unknown }> = [];
    (store as unknown as { events?: { emit: (e: string, p: unknown) => void } }).events = {
      emit: (event, payload) => {
        if (event === 'memory.recovered') events.push(payload as { memoryId?: unknown });
      },
    };
    const created = await store.rememberSage({
      text: 'Stale then deleted contract',
      sources: [{ type: 'test' }],
    });
    await store.updateSage(created.id, { status: 'stale' });
    await store.deleteSage(created.id, 'test deletion', { force: true });

    const applied = await store.backfillRecoverable({ dryRun: false });
    const successorId = applied.recoverableRecords[0]?.newActiveId;

    const successor = await store.getSage(successorId!);
    expect(successor?.status).toBe('active');
    expect(successor?.staleReason).toBeUndefined();
    expect(events.map((e) => e.memoryId)).toContain(successorId);
  });

  it('recoverSage clears a carried staleReason when restoring a deleted memory in place', async () => {
    const store = await createStore();
    const created = await store.rememberSage({
      text: 'Stale then deleted in-place recovery contract',
      sources: [{ type: 'test' }],
    });
    await store.updateSage(created.id, { status: 'stale' });
    await store.deleteSage(created.id, 'test deletion', { force: true });

    const recovered = await store.recoverSage(created.id, 'test recovery');
    expect(recovered.status).toBe('active');
    expect(recovered.staleReason).toBeUndefined();
    expect((await store.getSage(created.id))?.staleReason).toBeUndefined();
  });

  it('supersededBy records the chain head so recovery can resolve it', async () => {
    const store = await createStore();
    const loser = await store.rememberSage({
      text: 'Merged loser contract',
      sources: [{ type: 'test' }],
    });
    const keeper = await store.rememberSage({
      text: 'Merged keeper contract',
      sources: [{ type: 'test' }],
    });

    await store.updateSage(loser.id, { status: 'superseded', supersededBy: keeper.id });

    expect((await store.getSage(loser.id))?.supersededBy).toBe(keeper.id);
    expect((await store.recoverSage(loser.id)).id).toBe(keeper.id);

    await store.updateSage(loser.id, { status: 'active' });
    expect((await store.getSage(loser.id))?.supersededBy).toBeUndefined();
  });

  it('rejects an invalid supersededBy', async () => {
    const store = await createStore();
    const memory = await store.rememberSage({
      text: 'Supersede guard contract',
      sources: [{ type: 'test' }],
    });
    const other = await store.rememberSage({
      text: 'Supersede guard other',
      sources: [{ type: 'test' }],
    });

    await expect(store.updateSage(memory.id, { supersededBy: other.id })).rejects.toThrow(
      /requires status "superseded"/,
    );
    await expect(
      store.updateSage(memory.id, { status: 'superseded', supersededBy: memory.id }),
    ).rejects.toThrow(/cannot supersede itself/);
    await expect(
      store.updateSage(memory.id, { status: 'superseded', supersededBy: 'missing-id' }),
    ).rejects.toThrow(/not found/);
    expect((await store.getSage(memory.id))?.status).toBe('active');
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

// Static source-hygiene detector (anchored regression). Commit 3bbe66a22 wrote
// raw NUL (U+0000) bytes into duplicateKey()'s template literal, which made
// this file binary to git, ripgrep, and text readers — the recovery rewrite
// shipped as an unreviewable "Bin 7692 -> 9952" diff and formatters skipped
// the file. The separators must stay written as `\u0000` escape sequences.
describe('sqlite-store-recovery source hygiene', () => {
  const recoverySourceUrl = new URL('../src/sqlite-store-recovery.ts', import.meta.url);

  it('contains no raw NUL bytes (valid UTF-8 text source)', async () => {
    const source = await fs.readFile(fileURLToPath(recoverySourceUrl));
    expect(
      source.includes(0),
      'raw NUL byte in sqlite-store-recovery.ts — write the separator as the \\u0000 escape, not a literal U+0000',
    ).toBe(false);
  });

  it('keeps the duplicateKey separator as the \\u0000 escape sequence', async () => {
    const source = await fs.readFile(fileURLToPath(recoverySourceUrl), 'utf8');
    expect(source).toContain('\\u0000');
  });
});
