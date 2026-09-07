import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAtlas,
  checkAtlasFreshness,
  EXPORT_PACKAGE_LIMIT,
  enrichConcepts,
  renderAtlasHtml,
  runIndexer,
  type SummarizerPort,
  writeAtlas,
} from '../src/codebase-index/index.js';
import { IndexStore, indexStorePool } from '../src/codebase-index/writer.js';

let tmpDir: string;
let indexDir: string;
let store: IndexStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-atlasvis-'));
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
    'export function buildWidget(id: string): string {\n  return id;\n}\n',
  );
  await write(
    'src/leaf.ts',
    "import { buildWidget } from './kernel.js';\nexport function leaf(): void {\n  buildWidget('a');\n}\n",
  );
  await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
  store = new IndexStore(tmpDir, { indexDir });
}

const summariser = (text: (file: string) => string): SummarizerPort => ({
  describeFile: async (input) => ({ summary: text(input.file) }),
  describeSubsystem: async (input) => ({ summary: `The ${input.name} subsystem.` }),
});

describe('atlas graph projection', () => {
  it('projects package edges alongside the ranked files', async () => {
    await seedProject();

    const { document } = buildAtlas(store, tmpDir);

    expect(document.schema).toBe(2);
    expect(document.files.length).toBeGreaterThan(0);
    expect(Array.isArray(document.edges)).toBe(true);
  });

  it('never emits an edge that lands on a package it does not define', async () => {
    await seedProject();

    const { document } = buildAtlas(store, tmpDir);
    const known = new Set(document.packages.map((pkg) => pkg.name));

    for (const edge of document.edges) {
      expect(known.has(edge.from)).toBe(true);
      expect(known.has(edge.to)).toBe(true);
    }
  });

  it('labels every file with a package the document defines', async () => {
    await seedProject();

    const { document } = buildAtlas(store, tmpDir);
    const known = new Set(document.packages.map((pkg) => pkg.name));

    // A file whose package names nothing in `packages[]` cannot be grouped,
    // filtered or drawn — the export's package filter would silently show
    // an empty table.
    for (const file of document.files) expect(known.has(file.package)).toBe(true);
  });

  it('omits concept fields entirely until the concept layer has run', async () => {
    await seedProject();

    const { document } = buildAtlas(store, tmpDir);

    expect(document.files.every((file) => file.concept === undefined)).toBe(true);
    expect(document.packages.every((pkg) => pkg.summary === undefined)).toBe(true);
    expect(JSON.stringify(document)).not.toContain('"concept"');
  });

  it('carries summaries once the concept layer has run', async () => {
    await seedProject();
    await enrichConcepts(
      store,
      summariser((file) => `Describes ${path.basename(file)}.`),
      relativeOf,
      {
        subsystems: true,
      },
    );

    const { document, markdown } = buildAtlas(store, tmpDir);

    expect(document.files.some((file) => file.concept?.startsWith('Describes'))).toBe(true);
    expect(markdown).toContain('## Subsystems');
  });

  it('leaves the subsystems section out of the markdown when nothing is described', async () => {
    await seedProject();

    expect(buildAtlas(store, tmpDir).markdown).not.toContain('## Subsystems');
  });
});

describe('renderAtlasHtml', () => {
  it('produces a self-contained document with no external requests', async () => {
    await seedProject();

    const html = renderAtlasHtml(buildAtlas(store, tmpDir).document, { projectName: 'demo' });

    expect(html.startsWith('<!doctype html>')).toBe(true);
    // Opening from file:// must work, so nothing may be fetched or linked out.
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toContain('fetch(');
    expect(html).not.toContain('http://');
  });

  it('is deterministic for an unchanged document', async () => {
    await seedProject();
    const document = buildAtlas(store, tmpDir).document;

    expect(renderAtlasHtml(document)).toBe(renderAtlasHtml(document));
  });

  it('escapes markup coming from summaries rather than emitting it', async () => {
    await seedProject();
    await enrichConcepts(
      store,
      summariser(() => '</script><img src=x onerror=alert(1)>'),
      relativeOf,
    );

    const html = renderAtlasHtml(buildAtlas(store, tmpDir).document);

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('</script><img');
  });

  it('draws a circle per package and caps how many it draws', async () => {
    await seedProject();
    const document = buildAtlas(store, tmpDir).document;
    document.packages = Array.from({ length: EXPORT_PACKAGE_LIMIT + 12 }, (_, index) => ({
      name: `pkg-${index}`,
      files: 1,
      hub: `pkg-${index}/index.ts`,
      rank: 1 - index / 100,
    }));

    const html = renderAtlasHtml(document);

    expect((html.match(/<circle /g) ?? []).length).toBe(EXPORT_PACKAGE_LIMIT);
  });

  it('renders a readable page for an index with nothing ranked yet', async () => {
    await seedProject();
    const document = buildAtlas(store, tmpDir).document;
    document.packages = [];
    document.files = [];
    document.edges = [];

    const html = renderAtlasHtml(document);

    expect(html).toContain('No ranked packages to draw.');
    expect(html).not.toContain('<circle ');
  });
});

describe('atlas freshness accounting', () => {
  it('reports nothing added immediately after a write', async () => {
    await seedProject();
    await writeAtlas(store, tmpDir);

    const report = await checkAtlasFreshness(store, tmpDir);

    // The manifest stores hashes only for the files the atlas describes, so
    // comparing the live file count against that subset once reported the
    // entire repository as newly added the moment a fresh atlas was written.
    expect(report.fresh).toBe(true);
    expect(report.added).toBe(0);
    expect(report.changed).toEqual([]);
  });

  it('counts a genuinely new file as added', async () => {
    await seedProject();
    await writeAtlas(store, tmpDir);
    store.close();

    await write('src/newcomer.ts', 'export function newcomer(): void {}\n');
    indexStorePool.evict(tmpDir, indexDir);
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
    store = new IndexStore(tmpDir, { indexDir });

    const report = await checkAtlasFreshness(store, tmpDir);

    expect(report.added).toBe(1);
    expect(report.fresh).toBe(false);
  });
});

describe('the atlas is not indexed', () => {
  it('leaves its own projection out of the index', async () => {
    await seedProject();
    await writeAtlas(store, tmpDir);
    store.close();

    indexStorePool.evict(tmpDir, indexDir);
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
    store = new IndexStore(tmpDir, { indexDir });

    // Indexing the atlas makes the index describe its own output: every write
    // would then look like drift on the next run, forever.
    const indexed = store.getAllFileMetas().map((meta) => meta.file.split('\\').join('/'));
    expect(indexed.some((file) => file.includes('.wrongstack/atlas/'))).toBe(false);
  });

  it('stays fresh across a reindex that follows a write', async () => {
    await seedProject();
    await writeAtlas(store, tmpDir);
    store.close();

    indexStorePool.evict(tmpDir, indexDir);
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
    store = new IndexStore(tmpDir, { indexDir });

    const report = await checkAtlasFreshness(store, tmpDir);
    expect(report.fresh).toBe(true);
    expect(report.added).toBe(0);
  });
});
