/**
 * Phase 3: hybrid search engine — vector embedding + RRF fusion tests.
 *
 * Verifies:
 *  - embedText produces deterministic, L2-normalized vectors
 *  - cosine similarity ranks similar symbols higher than dissimilar ones
 *  - RRF correctly merges two ranked lists with the k=60 formula
 *  - encode/decode round-trips a Float32Array through a Buffer losslessly
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildRankMap,
  cosineSimilarity,
  decodeVector,
  embedText,
  encodeVector,
  RRF_K,
  reciprocalRankFusion,
  VECTOR_DIMENSIONS,
} from '../src/codebase-index/vector-search.js';
import { IndexStore } from '../src/codebase-index/writer.js';

describe('embedText', () => {
  it('produces a fixed-length 384-dimensional vector', () => {
    const vec = embedText('verifySession');
    expect(vec.length).toBe(VECTOR_DIMENSIONS);
  });

  it('is deterministic — same input produces the same output', () => {
    const a = embedText('function verifySession(token: string): boolean');
    const b = embedText('function verifySession(token: string): boolean');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('L2-normalizes — the magnitude is 1 (or 0 for empty input)', () => {
    const vec = embedText('some meaningful text content here');
    let mag = 0;
    for (let i = 0; i < vec.length; i++) mag += vec[i]! * vec[i]!;
    expect(Math.sqrt(mag)).toBeCloseTo(1, 5);
  });

  it('produces a zero vector for empty input', () => {
    const vec = embedText('');
    let mag = 0;
    for (let i = 0; i < vec.length; i++) mag += vec[i]! * vec[i]!;
    expect(Math.sqrt(mag)).toBe(0);
  });
});

describe('cosineSimilarity', () => {
  it('is ~1.0 for identical text', () => {
    const a = embedText('verifySession');
    const b = embedText('verifySession');
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it('is higher for similar names than for unrelated names', () => {
    const query = embedText('verifySession');
    const similar = embedText('verifySessionToken');
    const unrelated = embedText('deleteUserAccount');
    expect(cosineSimilarity(query, similar)).toBeGreaterThan(cosineSimilarity(query, unrelated));
  });

  it('is ~0 for completely disjoint character sets', () => {
    const a = embedText('aaa');
    const b = embedText('zzz');
    // Very unlikely to share trigrams, so similarity should be near 0
    expect(cosineSimilarity(a, b)).toBeLessThan(0.1);
  });
});

describe('encode/decode', () => {
  it('round-trips a Float32Array through a Buffer', () => {
    const original = embedText('round trip test');
    const encoded = encodeVector(original);
    const decoded = decodeVector(encoded);
    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i]).toBeCloseTo(original[i]!, 5);
    }
  });
});

describe('reciprocalRankFusion', () => {
  it('assigns higher fused score to symbols present in both lists', () => {
    const bm25 = buildRankMap([10, 20, 30]);
    const vec = buildRankMap([30, 20, 40]);

    const fused = reciprocalRankFusion(bm25, vec);
    const scoreMap = new Map(fused);

    // Symbol 30 is rank 2 in BM25 and rank 0 in vector → highest fused score
    // Symbol 20 is rank 1 in both → second highest
    expect(fused[0]![0]).toBe(30);
    expect(fused[1]![0]).toBe(20);
    expect(scoreMap.get(30)!).toBeGreaterThan(scoreMap.get(20)!);
  });

  it('includes symbols from only one list with a single-source score', () => {
    const bm25 = buildRankMap([10, 20]);
    const vec = buildRankMap([30, 40]);

    const fused = reciprocalRankFusion(bm25, vec);
    const ids = fused.map(([id]) => id);
    expect(ids).toContain(10);
    expect(ids).toContain(40);
  });

  it('uses k=60 by default — the formula is 1/(60+rank)', () => {
    const bm25 = buildRankMap([1]);
    const vec = buildRankMap([1]);

    const fused = reciprocalRankFusion(bm25, vec);
    const score = fused[0]![1];
    // rank 0 in both: 1/60 + 1/60 = 2/60
    expect(score).toBeCloseTo(2 / RRF_K, 5);
  });

  it('returns an empty array when both inputs are empty', () => {
    const fused = reciprocalRankFusion(new Map(), new Map());
    expect(fused).toEqual([]);
  });

  it('sorts results descending by fused score', () => {
    const bm25 = buildRankMap([1, 2, 3, 4, 5]);
    const vec = buildRankMap([5, 4, 3, 2, 1]);

    const fused = reciprocalRankFusion(bm25, vec);
    // All symbols are at complementary ranks — symbol 3 (rank 2 in both) should
    // win because it's consistently high in both lists.
    const scores = fused.map(([, score]) => score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]!);
    }
  });
});

// ─── P4.11 store-level gate tests ────────────────────────────────────────────

const storeRoots: string[] = [];

afterAll(() => {
  for (const root of storeRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeStore(): { store: IndexStore; dbPath: () => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wstack-vector-gate-'));
  storeRoots.push(root);
  const indexDir = path.join(root, '.idx');
  return {
    store: new IndexStore(root, { indexDir }),
    dbPath: () => path.join(indexDir, 'index.db'),
  };
}

/** Raw connection for schema assertions — never reach into IndexStore privates. */
function listTables(dbPath: string): string[] {
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (
      p: string,
    ) => {
      prepare: (sql: string) => { all: () => unknown[] };
      close: () => void;
    };
  };
  const db = new DatabaseSync(dbPath);
  try {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
  } finally {
    db.close();
  }
}

function symbolRow(overrides: Partial<Parameters<IndexStore['insertSymbols']>[0][number]>) {
  return {
    id: 0,
    lang: 'ts' as const,
    kind: 'function' as const,
    name: 'placeholder',
    file: 'src/placeholder.ts',
    line: 1,
    col: 1,
    signature: '',
    docComment: '',
    scope: '',
    text: '',
    ...overrides,
  };
}

describe('P4.11 vector gate (WRONGSTACK_INDEX_VECTORS)', () => {
  describe('default off', () => {
    beforeAll(() => {
      delete process.env['WRONGSTACK_INDEX_VECTORS'];
    });

    it('does not create the symbol_vectors table and never writes vectors', () => {
      const { store, dbPath } = makeStore();
      const inserted = store.insertSymbols([
        symbolRow({ name: 'alpha' }),
        symbolRow({ name: 'beta' }),
      ]);
      expect(inserted.length).toBe(2);
      expect(listTables(dbPath())).not.toContain('symbol_vectors');
      store.close();
    });

    it('drops a legacy symbol_vectors table on open', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wstack-vector-legacy-'));
      storeRoots.push(root);
      const indexDir = path.join(root, '.idx');
      // Open once with the gate ON to create and populate the table…
      process.env['WRONGSTACK_INDEX_VECTORS'] = '1';
      try {
        const seeded = new IndexStore(root, { indexDir });
        seeded.insertSymbols([symbolRow({ name: 'legacyOne' })]);
        seeded.close();
      } finally {
        delete process.env['WRONGSTACK_INDEX_VECTORS'];
      }
      // …then reopen with the gate OFF: the legacy table must be dropped.
      const reopened = new IndexStore(root, { indexDir });
      reopened.close();
      expect(listTables(path.join(indexDir, 'index.db'))).not.toContain('symbol_vectors');
    });

    it('search still returns ranked results without the vector layer', () => {
      const { store } = makeStore();
      store.insertSymbols([
        symbolRow({ name: 'verifySessionToken' }),
        symbolRow({ name: 'unrelatedThing' }),
      ]);
      const result = store.searchRanked('verify', undefined, 5);
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0]!.name).toBe('verifySessionToken');
      store.close();
    });
  });

  describe('opt-in (WRONGSTACK_INDEX_VECTORS=1)', () => {
    beforeAll(() => {
      process.env['WRONGSTACK_INDEX_VECTORS'] = '1';
    });
    afterAll(() => {
      delete process.env['WRONGSTACK_INDEX_VECTORS'];
    });

    it('creates the table, writes vectors, and keeps search working', () => {
      const { store, dbPath } = makeStore();
      store.insertSymbols([symbolRow({ name: 'alphaOne' }), symbolRow({ name: 'betaTwo' })]);
      expect(listTables(dbPath())).toContain('symbol_vectors');
      const { DatabaseSync } = require('node:sqlite') as {
        DatabaseSync: new (
          p: string,
        ) => {
          prepare: (sql: string) => { all: () => unknown[] };
          close: () => void;
        };
      };
      const raw = new DatabaseSync(dbPath());
      try {
        const rows = raw.prepare('SELECT symbol_id, vector FROM symbol_vectors').all() as Array<{
          symbol_id: number;
          vector: Uint8Array;
        }>;
        expect(rows.length).toBe(2);
        expect(rows[0]!.vector.byteLength).toBe(384 * 4);
      } finally {
        raw.close();
      }
      const result = store.searchRanked('alpha', undefined, 5);
      expect(result.results[0]!.name).toBe('alphaOne');
      store.close();
    });

    // Regression (Chimera, post-P4.11): on a same-version DB where vectors
    // were JUST enabled, symbol_vectors does not exist yet when the FTS
    // drift-repair block runs. The purge there must not throw — the FTS try's
    // broad catch would flip ftsAvailable=false, silently disabling FTS
    // because a vector table was missing. Prove FTS survives the drift repair.
    it('keeps FTS available when FTS drift repairs with no symbol_vectors table', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wstack-vector-drift-'));
      storeRoots.push(root);
      const indexDir = path.join(root, '.idx');
      const dbPath = path.join(indexDir, 'index.db');

      // Seed with the gate OFF: symbols + FTS exist, symbol_vectors does not.
      delete process.env['WRONGSTACK_INDEX_VECTORS'];
      const seeded = new IndexStore(root, { indexDir });
      seeded.insertSymbols([symbolRow({ name: 'driftMarker' })]);
      seeded.close();
      expect(listTables(dbPath)).not.toContain('symbol_vectors');

      // Now enable vectors and corrupt FTS (delete rows without touching
      // symbols) so the drift-repair branch fires on reopen.
      process.env['WRONGSTACK_INDEX_VECTORS'] = '1';
      const { DatabaseSync } = require('node:sqlite') as {
        DatabaseSync: new (
          p: string,
        ) => {
          exec: (sql: string) => void;
          close: () => void;
        };
      };
      const corruptor = new DatabaseSync(dbPath);
      try {
        corruptor.exec('DELETE FROM symbols_fts');
      } finally {
        corruptor.close();
      }

      // Reopen: drift repair runs (ftsCount 0 !== symbolCount 1), vector table
      // still absent at that moment. FTS must remain functional after open.
      const reopened = new IndexStore(root, { indexDir });
      try {
        const result = reopened.searchRanked('drift', undefined, 5);
        expect(result.results.length).toBeGreaterThan(0);
        expect(result.results[0]!.name).toBe('driftMarker');
      } finally {
        reopened.close();
      }
    });
  });
});
