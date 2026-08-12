import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';

/**
 * The command-family candidate source used to read every `about_command` edge
 * in the graph into JS and filter there. That scan grows with usage — the
 * outcome-capture middleware writes a command anchor for each captured command
 * — and it sits on the per-tool-call retrieval path: 10k edges cost ~16ms,
 * 50k ~96ms, 200k ~310ms in a seeded measurement. The family filter now runs in
 * SQL as a prefilter while the exact comparison stays in JS, so these cases pin
 * that the prefilter never narrows what the JS predicate would have accepted.
 */
describe('command-family candidate collection', () => {
  let dir: string;
  let store: SqliteSageStore;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sage-cmd-'));
    store = new SqliteSageStore({ projectRoot: dir });
    await store.initialize();
  });

  afterEach(async () => {
    await store.close?.();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold the sqlite handle; the temp dir is disposable.
    }
  });

  const withCommand = (text: string, command: string) =>
    store.rememberSage({
      text,
      kind: 'tool_outcome',
      scope: 'project',
      importance: 0.8,
      confidence: 0.8,
      anchors: [{ type: 'command', command }],
    });

  it('finds a same-family command whose casing differs from the seed', async () => {
    // Nodes keep their original case; the family comparison lowercases. The SQL
    // prefilter has to be case-insensitive or this candidate disappears.
    const seed = await withCommand('Seed run', 'pnpm run build');
    const other = await withCommand('Same family, different case', 'PNPM RUN test');

    const related = await store.findRelatedSage([seed.id], { limit: 20 });

    expect(related.map((memory) => memory.id)).toContain(other.id);
  });

  it('finds a same-family command whose family folds only under NFKC', async () => {
    // `ｐ` (fullwidth) folds to `p`, so the family comparison sees `pnpm run`
    // while the stored node keeps the fullwidth character — an ASCII LIKE
    // prefix cannot match it. Only admitting non-ASCII nodes outright keeps the
    // prefilter a superset of what JS accepts.
    const seed = await withCommand('Seed run', 'pnpm run build');
    const folded = await withCommand('Same family after NFKC folding', 'ｐnpm run test');

    const related = await store.findRelatedSage([seed.id], { limit: 20 });

    expect(related.map((memory) => memory.id)).toContain(folded.id);
  });

  it('does not relate a command that merely shares the family prefix as text', async () => {
    // `LIKE 'command:pnpm run%'` admits `pnpm running-x`; the exact family
    // comparison must still reject it.
    const seed = await withCommand('Seed run', 'pnpm run build');
    const lookalike = await withCommand('Different family that starts the same', 'pnpm running-x');

    const related = await store.findRelatedSage([seed.id], { limit: 20 });

    expect(related.map((memory) => memory.id)).not.toContain(lookalike.id);
  });

  it('relates commands whose family contains LIKE metacharacters', async () => {
    // What this pins is that a `%`/`_`-bearing family still matches its sibling
    // — the prefilter must not mangle the pattern into something that misses.
    // It deliberately does NOT claim to pin the escaping itself: because the JS
    // family comparison is the authority, an unescaped pattern only widens what
    // the prefilter admits and the wrong rows are rejected downstream anyway.
    // The escaping is a tightness measure (an unescaped family of `%` would
    // degenerate to the old full scan), not a correctness gate.
    const seed = await withCommand('Seed with wildcards', 'make %_target build');
    const sibling = await withCommand('Same wildcard family', 'make %_target test');
    const decoy = await withCommand('Different family, similar shape', 'make xytarget test');

    const related = await store.findRelatedSage([seed.id], { limit: 20 });
    const ids = related.map((memory) => memory.id);

    expect(ids).toContain(sibling.id);
    expect(ids).not.toContain(decoy.id);
  });
});
