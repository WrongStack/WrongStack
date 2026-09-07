import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { retrieveContext } from '../src/codebase-index/context-retrieval.js';
import { clearWiringSnapshot } from '../src/codebase-index/graph-adjacency-cache.js';
import { runIndexer } from '../src/codebase-index/index.js';
import { IndexStore, indexStorePool } from '../src/codebase-index/writer.js';

let tmpDir: string;
let indexDir: string;
let store: IndexStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-ctx-'));
  indexDir = path.join(tmpDir, '.idx');
  clearWiringSnapshot();
});

afterEach(async () => {
  store?.close();
  indexStorePool.evict(tmpDir, indexDir);
  clearWiringSnapshot();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function write(rel: string, body: string): Promise<void> {
  const full = path.join(tmpDir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, 'utf8');
}

const relativeOf = (file: string): string => {
  const rel = path.relative(tmpDir, file);
  return (rel && !rel.startsWith('..') ? rel : file).replace(/\\/g, '/');
};

function ask(query: string, options: { limit?: number; pathPrefix?: string } = {}) {
  return retrieveContext(store, tmpDir, indexDir, { query, ...options }, relativeOf);
}

/**
 * A retry policy nothing names "retry" in its own file, reached only through
 * the graph: `runProviderRequest` calls `shouldRetryStatus`, which lives in a
 * module whose name the query never mentions.
 */
async function seedProject(): Promise<void> {
  await write(
    'src/backoff-policy.ts',
    `export function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}
export function backoffDelayMs(attempt: number): number {
  return 2 ** attempt * 100;
}
`,
  );
  await write(
    'src/provider-runner.ts',
    `import { backoffDelayMs, shouldRetryStatus } from './backoff-policy.js';
export async function runProviderRequest(status: number, attempt: number): Promise<number> {
  if (shouldRetryStatus(status)) return backoffDelayMs(attempt);
  return 0;
}
`,
  );
  await write(
    'src/unrelated-widgets.ts',
    `export function renderWidget(label: string): string {
  return label.toUpperCase();
}
`,
  );
  await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
  store = new IndexStore(tmpDir, { indexDir });
}

describe('retrieveContext', () => {
  it('returns the file that matched the query', async () => {
    await seedProject();

    const result = ask('shouldRetryStatus');

    expect(result.indexStatus).toBe('ok');
    expect(result.seedCount).toBeGreaterThan(0);
    expect(result.entries.map((e) => e.file)).toContain('src/backoff-policy.ts');
  });

  it('normalises the top result to relevance 1.0', async () => {
    await seedProject();

    const result = ask('shouldRetryStatus');

    expect(result.entries[0]?.relevance).toBeCloseTo(1, 10);
  });

  it('reaches files the query never named, through the graph', async () => {
    await seedProject();

    const result = ask('shouldRetryStatus');
    const files = result.entries.map((e) => e.file);

    // provider-runner.ts contains no token from the query; only the call edge
    // connects it. This is the whole point of walking rather than searching.
    expect(files).toContain('src/provider-runner.ts');
  });

  it('marks lexically matched files apart from graph-reached ones', async () => {
    await seedProject();

    const result = ask('shouldRetryStatus');
    const byFile = new Map(result.entries.map((e) => [e.file, e]));

    expect(byFile.get('src/backoff-policy.ts')?.matched).toBe(true);
    expect(byFile.get('src/provider-runner.ts')?.matched).toBe(false);
  });

  it('puts directly matched symbols first inside a file', async () => {
    await seedProject();

    const result = ask('shouldRetryStatus');
    const entry = result.entries.find((e) => e.file === 'src/backoff-policy.ts');

    expect(entry?.symbols[0]?.name).toBe('shouldRetryStatus');
    expect(entry?.symbols[0]?.seed).toBe(true);
    expect(entry?.symbols[0]?.line).toBeGreaterThan(0);
    expect(entry?.symbols[0]?.signature).toContain('shouldRetryStatus');
  });

  it('leaves unrelated files out of the answer', async () => {
    await seedProject();

    const result = ask('shouldRetryStatus');

    expect(result.entries.map((e) => e.file)).not.toContain('src/unrelated-widgets.ts');
  });

  it('honours the file limit and reports what was truncated', async () => {
    await seedProject();

    const result = ask('shouldRetryStatus', { limit: 1 });

    expect(result.entries).toHaveLength(1);
    expect(result.totalCandidates).toBeGreaterThan(1);
  });

  it('restricts results to a path prefix', async () => {
    await seedProject();

    const result = ask('shouldRetryStatus', { pathPrefix: 'src/unrelated-widgets.ts' });

    expect(result.entries).toEqual([]);
  });

  it('does not treat a sibling directory as a prefix match', async () => {
    await write('src/a/one.ts', 'export function alpha(): void {}\n');
    await write('src/ab/two.ts', 'export function alphaTwo(): void {}\n');
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
    store = new IndexStore(tmpDir, { indexDir });

    const result = ask('alpha', { pathPrefix: 'src/a' });

    // `src/ab` starts with `src/a` as a string but is a different directory.
    expect(result.entries.every((e) => e.file.startsWith('src/a/'))).toBe(true);
  });

  it('reports no-matches for a query nothing matches', async () => {
    await seedProject();

    const result = ask('zzzz-nothing-matches-this-zzzz');

    expect(result.indexStatus).toBe('no-matches');
    expect(result.entries).toEqual([]);
  });

  it('reports no-matches for an empty query rather than walking', async () => {
    await seedProject();

    expect(ask('   ').indexStatus).toBe('no-matches');
  });

  it('reports no-index when nothing has been indexed', async () => {
    store = new IndexStore(tmpDir, { indexDir });

    const result = ask('anything');

    expect(result.indexStatus).toBe('no-index');
  });
});

describe('semantic seeding', () => {
  it('reports zero semantic seeds when none are supplied', async () => {
    await seedProject();

    expect(ask('shouldRetryStatus').semanticSeedCount).toBe(0);
  });

  it('reaches a file the query matches neither by name nor through the graph', async () => {
    await seedProject();
    // Nothing in this file shares a token with the query, and no ref connects
    // it — only a semantic match can put it in the answer. This is the whole
    // reason embeddings exist.
    const lexicalOnly = ask('renderWidget');
    expect(lexicalOnly.entries.map((e) => e.file)).not.toContain('src/backoff-policy.ts');

    const withVectors = retrieveContext(
      store,
      tmpDir,
      indexDir,
      {
        query: 'renderWidget',
        vectorFiles: [{ file: path.join(tmpDir, 'src', 'backoff-policy.ts'), score: 0.9 }],
      },
      relativeOf,
    );

    expect(withVectors.semanticSeedCount).toBe(1);
    expect(withVectors.entries.map((e) => e.file)).toContain('src/backoff-policy.ts');
  });

  it('answers from semantic hits alone when nothing matches lexically', async () => {
    await seedProject();

    const result = retrieveContext(
      store,
      tmpDir,
      indexDir,
      {
        query: 'zzzz-nothing-matches-this-zzzz',
        vectorFiles: [{ file: path.join(tmpDir, 'src', 'backoff-policy.ts'), score: 0.8 }],
      },
      relativeOf,
    );

    expect(result.indexStatus).toBe('ok');
    expect(result.entries.map((e) => e.file)).toContain('src/backoff-policy.ts');
  });

  it('ignores a non-positive semantic score', async () => {
    await seedProject();

    const result = retrieveContext(
      store,
      tmpDir,
      indexDir,
      {
        query: 'shouldRetryStatus',
        vectorFiles: [{ file: path.join(tmpDir, 'src', 'unrelated-widgets.ts'), score: 0 }],
      },
      relativeOf,
    );

    expect(result.entries.map((e) => e.file)).not.toContain('src/unrelated-widgets.ts');
  });

  it('does not let a semantic hit outrank a direct lexical match', async () => {
    await seedProject();

    const result = retrieveContext(
      store,
      tmpDir,
      indexDir,
      {
        query: 'shouldRetryStatus',
        vectorFiles: [{ file: path.join(tmpDir, 'src', 'unrelated-widgets.ts'), score: 1 }],
      },
      relativeOf,
    );

    // An exact name match is stronger evidence than a paraphrase, so the
    // semantically-seeded file must not lead. (Which of the lexically-reached
    // files leads can shift: extra restart mass renormalises the whole
    // distribution, so asserting an exact winner would pin noise.)
    expect(result.entries[0]?.file).not.toBe('src/unrelated-widgets.ts');
    expect(result.entries.slice(0, 3).map((e) => e.file)).toContain('src/backoff-policy.ts');
  });
});

describe('wiring snapshot cache', () => {
  it('reuses the graph across queries and rebuilds after a reindex', async () => {
    await seedProject();

    const first = ask('shouldRetryStatus');
    const second = ask('shouldRetryStatus');
    expect(second.entries.map((e) => e.file)).toEqual(first.entries.map((e) => e.file));

    // A new file with a new edge must show up, which it only can if the
    // content stamp invalidated the cached graph.
    store.close();
    await write(
      'src/second-caller.ts',
      `import { shouldRetryStatus } from './backoff-policy.js';
export function alsoRetries(status: number): boolean {
  return shouldRetryStatus(status);
}
`,
    );
    indexStorePool.evict(tmpDir, indexDir);
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
    store = new IndexStore(tmpDir, { indexDir });

    const third = ask('shouldRetryStatus');
    expect(third.entries.map((e) => e.file)).toContain('src/second-caller.ts');
  });
});
