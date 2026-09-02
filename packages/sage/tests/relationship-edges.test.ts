import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';

/**
 * `supersedes` / `contradicts` are declared relations and accepted write input,
 * but only hygiene and the admin helper ever asserted the edge. The ordinary
 * write path stored the ids in the row JSON and left the graph blind, so
 * `findRelatedSage` could not expand through them.
 */
describe('relationship edge materialization', () => {
  let dir: string;
  let store: SqliteSageStore;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sage-rel-'));
    store = new SqliteSageStore({ projectRoot: dir });
    await store.initialize();
  });

  afterEach(async () => {
    await store.close?.();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold the sqlite handle briefly; the temp dir is disposable.
    }
  });

  const edges = (): Array<{
    from_node: string;
    to_node: string;
    relation: string;
    weight: number;
  }> => {
    const db = new DatabaseSync(path.join(dir, '.wrongstack', 'memories', 'sage.db'), {
      readOnly: true,
    });
    try {
      return db
        .prepare('SELECT from_node, to_node, relation, weight FROM edges')
        .all() as ReturnType<typeof edges>;
    } finally {
      db.close();
    }
  };

  const remember = (text: string, extra: Record<string, unknown> = {}) =>
    store.rememberSage({
      text,
      kind: 'fact',
      scope: 'project',
      importance: 0.9,
      confidence: 0.9,
      ...extra,
    });

  it('writes a supersedes edge when a new memory declares one', async () => {
    const older = await remember('The build script lives in scripts/build.mjs');
    const newer = await remember('The build script moved to scripts/build.ts', {
      supersedes: [older.id],
    });
    await store.close?.();

    expect(edges()).toContainEqual(
      expect.objectContaining({
        from_node: `mem:${newer.id}`,
        to_node: `mem:${older.id}`,
        relation: 'supersedes',
        weight: 1,
      }),
    );
  });

  it('writes a contradicts edge, which had no writer on the ordinary path', async () => {
    const claim = await remember('The daemon shuts down on idle');
    const counter = await remember('The daemon stays resident after idle', {
      contradicts: [claim.id],
    });
    await store.close?.();

    expect(edges()).toContainEqual(
      expect.objectContaining({
        from_node: `mem:${counter.id}`,
        to_node: `mem:${claim.id}`,
        relation: 'contradicts',
      }),
    );
  });

  it('materializes a relationship introduced by a merge that changes nothing else', async () => {
    // The merge path skipped the graph sync unless anchors, text or confidence
    // changed — so a re-remember whose only new information is the relationship
    // used to land in the row JSON and nowhere else.
    const older = await remember('Retry budget is three attempts');
    const first = await remember('Cache eviction runs every ten minutes');
    const merged = await store.rememberSage({
      text: 'Cache eviction runs every ten minutes',
      kind: 'fact',
      scope: 'project',
      importance: 0.9,
      confidence: 0.9,
      supersedes: [older.id],
    });
    await store.close?.();

    expect(merged.id).toBe(first.id);
    expect(merged.supersedes).toContain(older.id);
    expect(edges()).toContainEqual(
      expect.objectContaining({
        from_node: `mem:${first.id}`,
        to_node: `mem:${older.id}`,
        relation: 'supersedes',
      }),
    );
  });

  it('never asserts a self-edge', async () => {
    const memory = await remember('A memory that names itself');
    await store.updateSage(memory.id, { supersedes: [memory.id] });
    await store.close?.();

    const self = edges().filter(
      (edge) => edge.from_node === edge.to_node && edge.relation === 'supersedes',
    );
    expect(self).toEqual([]);
  });

  it('is idempotent across repeated assertions', async () => {
    const older = await remember('Original claim about the parser');
    const newer = await remember('Revised claim about the parser', { supersedes: [older.id] });
    await store.updateSage(newer.id, { supersedes: [older.id] });
    await store.updateSage(newer.id, { supersedes: [older.id] });
    await store.close?.();

    const matching = edges().filter(
      (edge) => edge.relation === 'supersedes' && edge.from_node === `mem:${newer.id}`,
    );
    expect(matching).toHaveLength(1);
  });

  it('leaves relationship edges alone when the anchor sync rebuilds about_* edges', async () => {
    // The anchor sync deletes and rebuilds its own `about_*` edges. Relationship
    // edges are asserted by hygiene and admin too, so they must survive that.
    const older = await remember('Superseded note about the router');
    const newer = await remember('Current note about the router', {
      supersedes: [older.id],
      anchors: [{ type: 'file', path: 'src/router.ts' }],
    });
    await store.updateSage(newer.id, {
      anchors: [{ type: 'file', path: 'src/router/index.ts' }],
    });
    await store.close?.();

    const all = edges();
    expect(all).toContainEqual(
      expect.objectContaining({ from_node: `mem:${newer.id}`, relation: 'supersedes' }),
    );
    // The anchor rebuild did happen — the stale file edge is gone.
    expect(all.some((edge) => edge.to_node === 'file:src/router.ts')).toBe(false);
    expect(all.some((edge) => edge.to_node === 'file:src/router/index.ts')).toBe(true);
  });
});
