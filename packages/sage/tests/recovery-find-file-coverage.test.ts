/**
 * Coverage for sage recovery and find-file paths via SqliteSageStore.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';

let tempDir: string;
let store: SqliteSageStore;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-rec-'));
  store = new SqliteSageStore({ projectRoot: tempDir });
});

afterEach(async () => {
  store.close();
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

describe('SqliteSageStore recovery', () => {
  it('recoverSage throws for non-existent id', async () => {
    await expect(store.recoverSage('non-existent')).rejects.toThrow();
  });

  it('recoverSage returns active memory as-is', async () => {
    const m = await store.rememberSage({
      text: 'active memory',
      scope: 'project',
      kind: 'fact',
      importance: 0.8,
      confidence: 0.8,
    });
    const recovered = await store.recoverSage(m.id);
    expect(recovered.status).toBe('active');
  });

  it('recoverSage restores a force-deleted memory', async () => {
    const m = await store.rememberSage({
      text: 'to be deleted and recovered',
      scope: 'project',
      kind: 'fact',
      importance: 0.8,
      confidence: 0.8,
    });
    await store.deleteSage(m.id, 'test', { force: true });
    const afterDelete = await store.getSage(m.id);
    expect(afterDelete?.status).toBe('deleted');
    const recovered = await store.recoverSage(m.id, 'manually recovered');
    expect(recovered.status).toBe('active');
  });
});

describe('SqliteSageStore backfillRecoverable', () => {
  it('returns a report', async () => {
    const report = await store.backfillRecoverable();
    expect(report).toBeDefined();
  });
});

describe('SqliteSageStore findMemoriesForFile', () => {
  it('returns empty result for unknown file', async () => {
    const result = await store.findMemoriesForFile('src/nonexistent.ts');
    expect(result).toBeDefined();
    expect(result.totalCount).toBe(0);
  });

  it('matches memories anchored to a file', async () => {
    await store.rememberSage({
      text: 'memory about src/index.ts',
      scope: 'project',
      kind: 'fact',
      importance: 0.8,
      confidence: 0.8,
      anchors: [{ type: 'file', path: 'src/index.ts' }],
    });
    const result = await store.findMemoriesForFile('src/index.ts');
    expect(result.totalCount).toBeGreaterThanOrEqual(1);
  });

  it('does not match memories anchored to a different file', async () => {
    await store.rememberSage({
      text: 'memory about src/other.ts',
      scope: 'project',
      kind: 'fact',
      importance: 0.8,
      confidence: 0.8,
      anchors: [{ type: 'file', path: 'src/other.ts' }],
    });
    const result = await store.findMemoriesForFile('src/different.ts');
    expect(result.primaryMatches.length).toBe(0);
  });

  it('respects limit option', async () => {
    for (let i = 0; i < 5; i++) {
      await store.rememberSage({
        text: `memory ${i} about src/batch.ts`,
        scope: 'project',
        kind: 'fact',
        importance: 0.8,
        confidence: 0.8,
        anchors: [{ type: 'file', path: 'src/batch.ts' }],
      });
    }
    const result = await store.findMemoriesForFile('src/batch.ts', { limit: 2 });
    expect(result.primaryMatches.length).toBeLessThanOrEqual(2);
  });

  it('includes deleted memories when includeDeleted is true', async () => {
    const m = await store.rememberSage({
      text: 'deleted memory about src/del.ts',
      scope: 'project',
      kind: 'fact',
      importance: 0.8,
      confidence: 0.8,
      anchors: [{ type: 'file', path: 'src/del.ts' }],
    });
    await store.deleteSage(m.id, 'test', { force: true });
    const result = await store.findMemoriesForFile('src/del.ts', { includeDeleted: true });
    expect(result.totalCount).toBeGreaterThanOrEqual(1);
  });

  it('excludes deleted memories by default', async () => {
    const m = await store.rememberSage({
      text: 'deleted memory about src/exc.ts',
      scope: 'project',
      kind: 'fact',
      importance: 0.8,
      confidence: 0.8,
      anchors: [{ type: 'file', path: 'src/exc.ts' }],
    });
    await store.deleteSage(m.id, 'test', { force: true });
    const result = await store.findMemoriesForFile('src/exc.ts');
    expect(result.totalCount).toBe(0);
  });
});
