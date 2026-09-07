import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  enrichConcepts,
  runGraphRankPass,
  runIndexer,
  type SummarizerPort,
} from '../src/codebase-index/index.js';
import { IndexStore, indexStorePool } from '../src/codebase-index/writer.js';

let tmpDir: string;
let indexDir: string;
let store: IndexStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-graphenrich-'));
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

/** `kernel.ts` is called from two places, so it must outrank both callers. */
async function seedProject(): Promise<void> {
  await write(
    'src/kernel.ts',
    'export function buildWidget(id: string): string {\n  return id;\n}\n',
  );
  await write(
    'src/leaf.ts',
    "import { buildWidget } from './kernel.js';\nexport function leaf(): void {\n  buildWidget('a');\n}\n",
  );
  await write(
    'src/other.ts',
    "import { buildWidget } from './kernel.js';\nexport function other(): void {\n  buildWidget('b');\n}\n",
  );
  await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
  store = new IndexStore(tmpDir, { indexDir });
}

const summariser = (text: (file: string) => string): SummarizerPort => ({
  describeFile: async (input) => ({
    summary: text(input.file),
    cruxStart: 1,
    cruxEnd: 2,
  }),
  describeSubsystem: async (input) => ({ summary: `All about ${input.name}.` }),
});

/** These fixtures carry no manifest, so every file lands in the `(root)` package. */
const ROOT_PACKAGE = '(root)';

function fileNode(file: string) {
  return store.getFileGraph(ROOT_PACKAGE).nodes.find((node) => node.file?.endsWith(file));
}

describe('graph node enrichment', () => {
  it('stamps rank onto file nodes', async () => {
    await seedProject();

    const kernel = fileNode('kernel.ts');
    expect(kernel?.rank).toBeGreaterThan(0);
    expect(fileNode('leaf.ts')?.rank ?? 0).toBeLessThan(kernel?.rank ?? 0);
  });

  it('normalises rank to 1.0 within the level being rendered', async () => {
    await seedProject();

    const ranks = store
      .getFileGraph(ROOT_PACKAGE)
      .nodes.map((node) => node.rank)
      .filter((rank): rank is number => rank !== undefined);

    expect(Math.max(...ranks)).toBeCloseTo(1, 10);
    // A client sizing nodes by rank must never be handed a value above 1.
    expect(ranks.every((rank) => rank <= 1)).toBe(true);
  });

  it('leaves every enrichment field absent on an index with no rank pass', async () => {
    await seedProject();
    store.replaceRanks([], []);

    for (const node of store.getFileGraph(ROOT_PACKAGE).nodes) {
      expect(node.rank).toBeUndefined();
      expect(node.concept).toBeUndefined();
      expect(node.subsystem).toBeUndefined();
    }
  });

  it('carries the concept summary and its crux span on file nodes', async () => {
    await seedProject();
    await enrichConcepts(
      store,
      summariser((f) => `Explains ${path.basename(f)}.`),
      relativeOf,
    );

    const kernel = fileNode('kernel.ts');
    expect(kernel?.concept).toBe('Explains kernel.ts.');
    expect(kernel?.crux).toEqual({ start: 1, end: 2 });
  });

  it('does not repeat the file summary on every symbol inside it', async () => {
    await seedProject();
    await enrichConcepts(
      store,
      summariser(() => 'A description.'),
      relativeOf,
    );

    const symbols = store.getSymbolGraph(path.join(tmpDir, 'src', 'kernel.ts')).nodes;
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols.every((node) => node.concept === undefined)).toBe(true);
    // Rank, unlike the summary, is per symbol and belongs on every node.
    expect(symbols.some((node) => node.rank !== undefined)).toBe(true);
  });

  it('labels nodes with their subsystem once one is derived', async () => {
    await seedProject();
    await enrichConcepts(
      store,
      summariser(() => 'Described.'),
      relativeOf,
      { subsystems: true },
    );

    expect(fileNode('kernel.ts')?.subsystem).toBeDefined();
  });

  it('gives a package node the summed centrality of its files', async () => {
    await seedProject();

    const packages = store.getPackageGraph().nodes;
    expect(packages.length).toBeGreaterThan(0);
    // Normalised within the level, so the single package here is the maximum.
    expect(Math.max(...packages.map((node) => node.rank ?? 0))).toBeCloseTo(1, 10);
  });

  it('reports the file mtime so the client can shade by recency', async () => {
    await seedProject();

    expect(fileNode('kernel.ts')?.lastModifiedMs).toBeGreaterThan(0);
  });

  it('re-reads enrichment after a rank refresh rather than caching it', async () => {
    await seedProject();
    store.replaceRanks([], []);
    expect(fileNode('kernel.ts')?.rank).toBeUndefined();

    runGraphRankPass(store, []);

    expect(fileNode('kernel.ts')?.rank).toBeGreaterThan(0);
  });
});

describe('rank normalisation scope', () => {
  /**
   * `lib/` imports from `app/`, so drilling into `lib` returns `app`'s files as
   * external neighbours — and `app/core.ts` is the more central file globally.
   */
  async function seedTwoPackages(): Promise<void> {
    await write('app/package.json', '{"name":"app","version":"1.0.0"}\n');
    await write('lib/package.json', '{"name":"lib","version":"1.0.0"}\n');
    await write('app/core.ts', 'export function core(): number {\n  return 1;\n}\n');
    await write(
      'app/second.ts',
      "import { core } from './core.js';\nexport function second(): number {\n  return core();\n}\n",
    );
    await write(
      'lib/one.ts',
      "import { core } from '../app/core.js';\nexport function one(): number {\n  return core();\n}\n",
    );
    await write(
      'lib/two.ts',
      "import { one } from './one.js';\nexport function two(): number {\n  return one();\n}\n",
    );
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
    store = new IndexStore(tmpDir, { indexDir });
  }

  it('gives the scope its own 1.0 rather than handing it to an outside hub', async () => {
    await seedTwoPackages();

    const graph = store.getFileGraph('lib');
    const local = graph.nodes.filter((node) => node.external !== true);
    expect(local.length).toBeGreaterThan(0);

    // A view of a package in which nothing from that package looks central is
    // not a view of that package.
    expect(Math.max(...local.map((node) => node.rank ?? 0))).toBeCloseTo(1, 10);
  });

  it('clamps an outside node that outranks the scope instead of exceeding the scale', async () => {
    await seedTwoPackages();

    const graph = store.getFileGraph('lib');

    for (const node of graph.nodes) {
      if (node.rank !== undefined) expect(node.rank).toBeLessThanOrEqual(1);
    }
  });

  it('still scales a package-level graph, where nothing is external', async () => {
    await seedTwoPackages();

    const ranks = store
      .getPackageGraph()
      .nodes.map((node) => node.rank)
      .filter((rank): rank is number => rank !== undefined);

    expect(ranks.length).toBeGreaterThan(0);
    expect(Math.max(...ranks)).toBeCloseTo(1, 10);
  });
});
