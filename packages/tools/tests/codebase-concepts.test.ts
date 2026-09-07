import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONCEPT_RELATIONS,
  enrichConcepts,
  enrichProjectConcepts,
  isConceptRelation,
  MAX_CRUX_LINES,
  MAX_SUMMARY_CHARS,
  runIndexer,
  type SummarizerPort,
} from '../src/codebase-index/index.js';
import { IndexStore, indexStorePool } from '../src/codebase-index/writer.js';

let tmpDir: string;
let indexDir: string;
let store: IndexStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-concepts-'));
  indexDir = path.join(tmpDir, '.idx');
});

afterEach(async () => {
  store?.close();
  indexStorePool.evict(tmpDir, indexDir);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function write(rel: string, body: string): Promise<void> {
  const full = path.join(tmpDir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, 'utf8');
}

const relativeOf = (file: string): string => {
  const rel = path.relative(tmpDir, file);
  return (rel && !rel.startsWith('..') ? rel : file).split('\\').join('/');
};

async function seedProject(): Promise<void> {
  await write(
    'src/kernel.ts',
    `export interface Widget { id: string; }
export function buildWidget(id: string): Widget { return { id }; }
`,
  );
  await write(
    'src/leaf.ts',
    `import { buildWidget } from './kernel.js';
export function leaf(): void { buildWidget('a'); }
`,
  );
  await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
  store = new IndexStore(tmpDir, { indexDir });
}

/** A summariser that records what it was asked and answers deterministically. */
function fakePort(
  overrides: Partial<{
    summary: (file: string) => string | null;
    cruxStart: number;
    cruxEnd: number;
  }> = {},
): SummarizerPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    describeFile: vi.fn(async (input) => {
      calls.push(input.file);
      const summary = overrides.summary ? overrides.summary(input.file) : `About ${input.file}`;
      if (summary === null) return null;
      return {
        summary,
        cruxStart: overrides.cruxStart ?? 1,
        cruxEnd: overrides.cruxEnd ?? 2,
        model: 'fake-model',
      };
    }),
  };
}

describe('enrichConcepts', () => {
  it('summarises every indexed file on a first pass', async () => {
    await seedProject();
    const port = fakePort();

    const result = await enrichConcepts(store, port, relativeOf);

    expect(result.summarised).toBe(2);
    expect(result.cached).toBe(0);
    expect(result.failed).toBe(0);
    expect(new Set(port.calls)).toEqual(new Set(['src/kernel.ts', 'src/leaf.ts']));
  });

  it('stores the summary, the crux span and the model', async () => {
    await seedProject();
    await enrichConcepts(store, fakePort({ cruxStart: 2, cruxEnd: 2 }), relativeOf);

    const concept = store.getAllFileConcepts().find((c) => c.file.endsWith('kernel.ts'));

    expect(concept?.summary).toContain('kernel.ts');
    expect(concept?.state).toBe('ready');
    expect(concept?.model).toBe('fake-model');
    expect(concept?.cruxStart).toBe(2);
    expect(concept?.cruxEnd).toBe(2);
  });

  it('sends nothing to the model on a second pass', async () => {
    await seedProject();
    await enrichConcepts(store, fakePort(), relativeOf);

    const second = fakePort();
    const result = await enrichConcepts(store, second, relativeOf);

    // The content hash is the cache key; unchanged bytes must never be re-sent.
    expect(second.calls).toEqual([]);
    expect(result.summarised).toBe(0);
    expect(result.cached).toBe(2);
  });

  it('re-summarises only the file that changed', async () => {
    await seedProject();
    await enrichConcepts(store, fakePort(), relativeOf);

    store.close();
    await write('src/leaf.ts', 'export function leaf(): void { /* rewritten */ }\n');
    indexStorePool.evict(tmpDir, indexDir);
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
    store = new IndexStore(tmpDir, { indexDir });

    const port = fakePort();
    const result = await enrichConcepts(store, port, relativeOf);

    expect(port.calls).toEqual(['src/leaf.ts']);
    expect(result.markedStale).toBe(1);
    expect(result.cached).toBe(1);
  });

  it('re-sends everything when forced', async () => {
    await seedProject();
    await enrichConcepts(store, fakePort(), relativeOf);

    const port = fakePort();
    await enrichConcepts(store, port, relativeOf, { force: true });

    expect(port.calls).toHaveLength(2);
  });

  it('offers the outdated summary back as a hint', async () => {
    await seedProject();
    await enrichConcepts(store, fakePort({ summary: () => 'original description' }), relativeOf);

    store.close();
    await write('src/leaf.ts', 'export function leaf(): void { /* rewritten */ }\n');
    indexStorePool.evict(tmpDir, indexDir);
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
    store = new IndexStore(tmpDir, { indexDir });

    const seen: Array<string | undefined> = [];
    await enrichConcepts(
      store,
      {
        describeFile: async (input) => {
          seen.push(input.staleSummary);
          return { summary: 'new description' };
        },
      },
      relativeOf,
    );

    expect(seen).toEqual(['original description']);
  });

  it('summarises files the reference graph never reached', async () => {
    // `file_rank` only contains files with resolved refs. A standalone module
    // — a script, a config, any leaf nothing imports — has no rank at all, and
    // driving the walk from the ranking rather than from the file list made
    // every such file permanently invisible to enrichment.
    await write('standalone.ts', 'export const nothingImportsThis = 1;\n');
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
    store = new IndexStore(tmpDir, { indexDir });
    expect(store.getRankedFiles(50).map((r) => relativeOf(r.file))).not.toContain('standalone.ts');

    const port = fakePort();
    await enrichConcepts(store, port, relativeOf);

    expect(port.calls).toContain('standalone.ts');
  });

  it('orders the walk most-central-first', async () => {
    await seedProject();
    const port = fakePort();

    // Serial, because with parallel workers the completion order says nothing
    // about the queue order this test is actually about.
    await enrichConcepts(store, port, relativeOf, { concurrency: 1 });

    // kernel.ts is what leaf.ts imports, so a budget that runs out should run
    // out on the leaf, not the hub.
    expect(port.calls).toEqual(['src/kernel.ts', 'src/leaf.ts']);
  });

  it('stops at maxFiles', async () => {
    await seedProject();
    const port = fakePort();

    const result = await enrichConcepts(store, port, relativeOf, { maxFiles: 1 });

    expect(result.summarised).toBe(1);
    expect(port.calls).toHaveLength(1);
  });

  it('counts a declined file as failed and keeps going', async () => {
    await seedProject();
    const port = fakePort({ summary: (file) => (file.endsWith('leaf.ts') ? null : 'ok') });

    const result = await enrichConcepts(store, port, relativeOf);

    expect(result.summarised).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('records a throwing summariser as an error rather than failing the pass', async () => {
    await seedProject();

    const result = await enrichConcepts(
      store,
      {
        describeFile: async (input) => {
          if (input.file.endsWith('leaf.ts')) throw new Error('model refused');
          return { summary: 'ok' };
        },
      },
      relativeOf,
    );

    expect(result.summarised).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors.join(' ')).toContain('model refused');
  });

  it('clamps an out-of-range crux to the file', async () => {
    await seedProject();

    await enrichConcepts(store, fakePort({ cruxStart: 9999, cruxEnd: 99999 }), relativeOf);
    const concept = store.getAllFileConcepts()[0];

    expect(concept?.cruxStart).toBeGreaterThan(0);
    expect(concept?.cruxEnd).toBeGreaterThanOrEqual(concept?.cruxStart ?? 0);
    // A "crux" longer than a screen is not a pointer any more.
    expect((concept?.cruxEnd ?? 0) - (concept?.cruxStart ?? 0)).toBeLessThan(MAX_CRUX_LINES);
  });

  it('truncates a runaway summary', async () => {
    await seedProject();

    await enrichConcepts(store, fakePort({ summary: () => 'x'.repeat(5000) }), relativeOf);

    for (const concept of store.getAllFileConcepts()) {
      expect(concept.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    }
  });

  it('honours an abort signal', async () => {
    await seedProject();
    const controller = new AbortController();
    controller.abort();

    const port = fakePort();
    const result = await enrichConcepts(store, port, relativeOf, { signal: controller.signal });

    expect(port.calls).toEqual([]);
    expect(result.summarised).toBe(0);
  });

  it('drops summaries for files that left the index', async () => {
    await seedProject();
    await enrichConcepts(store, fakePort(), relativeOf);

    store.close();
    await fs.rm(path.join(tmpDir, 'src/leaf.ts'));
    indexStorePool.evict(tmpDir, indexDir);
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
    store = new IndexStore(tmpDir, { indexDir });

    const result = await enrichConcepts(store, fakePort(), relativeOf);

    expect(result.pruned).toBe(1);
    expect(store.getAllFileConcepts().map((c) => relativeOf(c.file))).toEqual(['src/kernel.ts']);
  });

  it('reports coverage', async () => {
    await seedProject();
    await enrichConcepts(store, fakePort(), relativeOf);

    expect(store.getConceptCoverage()).toMatchObject({ ready: 2, stale: 0 });
    expect(store.getReadyConceptSummaries().size).toBe(2);
  });
});

describe('subsystem derivation', () => {
  it('derives a subsystem per package and keeps only known, vocabulary relations', async () => {
    await seedProject();

    const port: SummarizerPort = {
      describeFile: async (input) => ({ summary: `About ${input.file}` }),
      describeSubsystem: async (input) => ({
        summary: `The ${input.name} subsystem.`,
        relations: [
          { to: input.name, relation: 'uses' }, // self — dropped
          { to: 'nonexistent-package', relation: 'uses' }, // unknown — dropped
          { to: input.name, relation: 'frobnicates' }, // off-vocabulary — dropped
        ],
      }),
    };

    const result = await enrichConcepts(store, port, relativeOf, { subsystems: true });

    expect(result.subsystems).toBeGreaterThan(0);
    expect(store.getSubsystems()[0]?.summary).toContain('subsystem');
    expect(store.getConceptEdges()).toEqual([]);
  });

  it('skips subsystems when the port cannot derive them', async () => {
    await seedProject();

    const result = await enrichConcepts(store, fakePort(), relativeOf, { subsystems: true });

    expect(result.subsystems).toBe(0);
  });
});

describe('relation vocabulary', () => {
  it('is closed', () => {
    for (const relation of CONCEPT_RELATIONS) expect(isConceptRelation(relation)).toBe(true);
    expect(isConceptRelation('initialises')).toBe(false);
    expect(isConceptRelation('')).toBe(false);
  });
});

describe('enrichProjectConcepts', () => {
  it('refuses to run — and to create a database — without an index', async () => {
    await write('src/index.ts', 'export const a = 1;\n');

    const result = await enrichProjectConcepts(tmpDir, fakePort(), { indexDir });

    expect(result).toEqual({ indexed: false });
    // Spending money summarising an index that does not exist helps nobody.
    await expect(fs.access(path.join(indexDir, 'index.db'))).rejects.toThrow();
  });

  it('enriches through the project-level API', async () => {
    await seedProject();
    store.close();
    indexStorePool.evict(tmpDir, indexDir);

    const result = await enrichProjectConcepts(tmpDir, fakePort(), { indexDir });

    expect(result).toMatchObject({ summarised: 2 });
    store = new IndexStore(tmpDir, { indexDir });
  });
});
