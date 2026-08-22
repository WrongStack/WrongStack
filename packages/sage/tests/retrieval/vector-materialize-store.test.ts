/**
 * Integration tests for the store-wired vector-only materialization path.
 *
 * `SqliteSageStore.searchSage` passes `materializeSageByIdFactory` into
 * `augmentLexicalWithVectorRecall`, so vector-only hits (memories the FTS
 * channel missed) are admitted ONLY under the same visibility clauses the
 * lexical channel applied: status, scope, audience, session ownership, and
 * contextPolicy-`never`. These tests pin that contract with a real store
 * and a scripted VectorRecallProvider.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SageSearchOptions, VectorRecallProvider } from '../../src/types.js';
import { SqliteSageStore } from '../../src/sqlite-store.js';

let tempDir: string;
let store: SqliteSageStore;

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sage-vecmat-'));
  store = new SqliteSageStore({ projectRoot: tempDir });
  await store.initialize();
});

afterEach(async () => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  await new Promise((r) => setTimeout(r, 10));
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

/**
 * Provider that returns exactly the scripted hits regardless of query, in
 * the given order. Mirrors the production adapter: each hit carries
 * `metadata.sageId` so the fusion can map it back to a SAGE memory.
 */
function scriptedProvider(
  hits: Array<{ sageId: string; score: number }>,
): VectorRecallProvider {
  return {
    async search(_query, opts) {
      return hits.slice(0, opts.limit).map((h) => ({
        id: `vec-${h.sageId}`,
        score: h.score,
        text: 'scripted',
        tags: [],
        metadata: { sageId: h.sageId },
      }));
    },
  };
}

/** Seed a project memory with no owner session. */
function rememberProject(text: string, extra: Record<string, unknown> = {}) {
  return store.rememberSage({
    text,
    kind: 'fact',
    scope: 'project',
    ...extra,
  });
}

describe('searchSage vector-only materialization (store wiring)', () => {
  it('admits a lexically-missed memory via a high-score vector-only hit', async () => {
    // The paraphrase shares NO token with the query ('apple', 'crumble',
    // 'oven'), so the FTS channel cannot reach it — only the scripted
    // vector-only hit can admit it. The control call proves the lexical
    // channel really does miss it.
    const lexicalHit = await rememberProject('apple crumble baking temperatures');
    const paraphrase = await rememberProject(
      'warm fruit dessert baked under buttery pastry with caramel drizzle',
    );
    const control = await store.searchSage('apple crumble oven');
    // Assert the outcome, not the dispatch: exactly the lexical hit returns.
    // (`length === 1` + identity holds under FTS or the LIKE fallback alike —
    // a `not.toContain(paraphrase.id)` here would pass even if the channel
    // were broken, and couples the pin to FTS/LIKE internals.)
    expect(control).toHaveLength(1);
    expect(control[0]?.id).toBe(lexicalHit.id);

    const results = await store.searchSage('apple crumble oven', {
      vectorRecall: scriptedProvider([{ sageId: paraphrase.id, score: 0.88 }]),
      vectorRecallThreshold: 0.7,
    });
    expect(results.map((m) => m.id)).toContain(lexicalHit.id);
    expect(results.map((m) => m.id)).toContain(paraphrase.id);
  });

  it('drops a vector-only hit whose memory is filtered by visibility (audience)', async () => {
    const plain = await rememberProject('apple crumble baking temperatures');
    const scoped = await store.rememberSage({
      text: 'reviewer-only note about apple dessert pastry assembly',
      kind: 'fact',
      scope: 'project',
      audience: { roles: ['reviewer'] },
    });
    // includeAudienceScoped defaults to true for plain searchSage calls —
    // the JS safety net strips audience rows the SQL clause lets through.
    // The materializer must apply the identical SQL-level rule.
    const results = await store.searchSage('apple crumble oven', {
      includeAudienceScoped: false,
      vectorRecall: scriptedProvider([
        { sageId: scoped.id, score: 0.95 },
        { sageId: plain.id, score: 0.9 },
      ]),
      vectorRecallThreshold: 0.7,
    } as SageSearchOptions);
    const ids = results.map((m) => m.id);
    expect(ids).toContain(plain.id);
    expect(ids).not.toContain(scoped.id);
  });

  it('drops a vector-only hit owned by another session', async () => {
    const mine = await store.rememberSage({
      text: 'apple crumble baking temperatures for session A',
      kind: 'fact',
      scope: 'session',
      ownerSessionId: 'session-a',
    });
    const theirs = await store.rememberSage({
      text: 'apple dessert pastry notes private to session B',
      kind: 'fact',
      scope: 'session',
      ownerSessionId: 'session-b',
    });
    const results = await store.searchSage('apple crumble oven', {
      sessionId: 'session-a',
      vectorRecall: scriptedProvider([
        { sageId: theirs.id, score: 0.95 },
        { sageId: mine.id, score: 0.9 },
      ]),
      vectorRecallThreshold: 0.7,
    } as SageSearchOptions);
    const ids = results.map((m) => m.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });

  it('drops vector-only hits below the caller threshold', async () => {
    // Zero lexical overlap with the query — absence can only be explained
    // by the vector-only threshold gate.
    const paraphrase = await rememberProject(
      'warm fruit dessert baked under buttery pastry with caramel drizzle',
    );
    const results = await store.searchSage('apple crumble oven', {
      vectorRecall: scriptedProvider([{ sageId: paraphrase.id, score: 0.4 }]),
      vectorRecallThreshold: 0.7,
    });
    expect(results.map((m) => m.id)).not.toContain(paraphrase.id);
  });

  it('resolves unknown sageIds to a silent drop, not an error', async () => {
    const plain = await rememberProject('apple crumble baking temperatures');
    const results = await store.searchSage('apple crumble oven', {
      vectorRecall: scriptedProvider([
        { sageId: '01DOESNOTEXIST', score: 0.99 },
        { sageId: plain.id, score: 0.9 },
      ]),
      vectorRecallThreshold: 0.7,
    });
    const ids = results.map((m) => m.id);
    expect(ids).toContain(plain.id);
    expect(ids).not.toContain('01DOESNOTEXIST');
  });
});
