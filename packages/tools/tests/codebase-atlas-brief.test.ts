import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BRIEF_HUB_LIMIT,
  buildAtlasBrief,
  buildProjectAtlasBrief,
  enrichConcepts,
  runIndexer,
  type SummarizerPort,
  writeAtlas,
} from '../src/codebase-index/index.js';
import { IndexStore, indexStorePool } from '../src/codebase-index/writer.js';

let tmpDir: string;
let indexDir: string;
let store: IndexStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-brief-'));
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

const summariser = (text: (file: string) => string): SummarizerPort => ({
  describeFile: async (input) => ({ summary: text(input.file) }),
  describeSubsystem: async (input) => ({ summary: `The ${input.name} subsystem.` }),
});

async function seedProject(): Promise<void> {
  await write(
    'src/kernel.ts',
    'export function buildWidget(id: string): string {\n  return id;\n}\n',
  );
  await write(
    'src/leaf.ts',
    "import { buildWidget } from './kernel.js';\nexport function leaf(): void {\n  buildWidget('a');\n}\n",
  );
  await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
  store = new IndexStore(tmpDir, { indexDir });
}

describe('buildAtlasBrief', () => {
  it('reports the ranked hubs and the counts', async () => {
    await seedProject();

    const brief = await buildAtlasBrief(store, tmpDir);

    expect(brief.ranked).toBe(true);
    expect(brief.counts.files).toBeGreaterThan(0);
    expect(brief.hubs[0]?.path).toBe('src/kernel.ts');
    expect(brief.hubs.length).toBeLessThanOrEqual(BRIEF_HUB_LIMIT);
  });

  it('names a hub for each package', async () => {
    await seedProject();

    const brief = await buildAtlasBrief(store, tmpDir);

    expect(brief.packages.length).toBeGreaterThan(0);
    for (const pkg of brief.packages) expect(pkg.hub.length).toBeGreaterThan(0);
  });

  it('says it is unranked rather than guessing from filenames', async () => {
    await seedProject();
    store.replaceRanks([], []);

    const brief = await buildAtlasBrief(store, tmpDir);

    // The whole point of the layer is that a filename heuristic is not
    // centrality. With no ranks it must report nothing, not something.
    expect(brief.ranked).toBe(false);
    expect(brief.hubs).toEqual([]);
    expect(brief.packages).toEqual([]);
  });

  it('carries concept summaries and subsystems once enriched', async () => {
    await seedProject();
    await enrichConcepts(
      store,
      summariser((f) => `Explains ${path.basename(f)}.`),
      relativeOf,
      {
        subsystems: true,
      },
    );

    const brief = await buildAtlasBrief(store, tmpDir);

    expect(brief.hubs.some((hub) => hub.concept?.startsWith('Explains'))).toBe(true);
    expect(brief.subsystems.length).toBeGreaterThan(0);
  });

  it('reports no drift when no atlas has been written', async () => {
    await seedProject();

    // Absent is not stale: a project that never ran `--write` has no
    // projection to have drifted from.
    expect((await buildAtlasBrief(store, tmpDir)).staleFiles).toBeUndefined();
  });

  it('reports drift after the code changes under a written atlas', async () => {
    await seedProject();
    await writeAtlas(store, tmpDir);
    store.close();

    await write(
      'src/kernel.ts',
      'export function buildWidget(id: string): string {\n  return `${id}!`;\n}\n',
    );
    indexStorePool.evict(tmpDir, indexDir);
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
    store = new IndexStore(tmpDir, { indexDir });

    const brief = await buildAtlasBrief(store, tmpDir);

    expect(brief.staleFiles).toBeGreaterThan(0);
  });
});

describe('buildProjectAtlasBrief', () => {
  it('refuses to run — and to create a database — without an index', async () => {
    await write('src/index.ts', 'export const a = 1;\n');

    const result = await buildProjectAtlasBrief(tmpDir, { indexDir });

    expect(result).toEqual({ indexed: false });
    await expect(fs.access(path.join(indexDir, 'index.db'))).rejects.toThrow();
  });
});
