import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ATLAS_DIR,
  ATLAS_JSON,
  ATLAS_MANIFEST,
  ATLAS_MARKDOWN,
  ATLAS_SCHEMA,
  type AtlasManifest,
  buildAtlas,
  checkAtlasFreshness,
  checkProjectAtlasFreshness,
  runIndexer,
  writeAtlas,
  writeProjectAtlas,
} from '../src/codebase-index/index.js';
import { IndexStore, indexStorePool } from '../src/codebase-index/writer.js';

let tmpDir: string;
let indexDir: string;
let store: IndexStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-atlas-'));
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

const atlasPath = (name: string) => path.join(tmpDir, ATLAS_DIR, name);
const readAtlas = (name: string) => fs.readFile(atlasPath(name), 'utf8');

async function seedProject(): Promise<void> {
  await write(
    'src/kernel.ts',
    `export interface Widget { id: string; }
export function buildWidget(id: string): Widget { return { id }; }
export class WidgetRegistry {
  public add(w: Widget): void { void w; }
}
`,
  );
  for (let i = 0; i < 4; i++) {
    await write(
      `src/leaf-${i}.ts`,
      `import { buildWidget, WidgetRegistry } from './kernel.js';
export function leaf${i}(): void {
  new WidgetRegistry().add(buildWidget('${i}'));
}
`,
    );
  }
  await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
  store = new IndexStore(tmpDir, { indexDir });
}

describe('buildAtlas', () => {
  it('describes the graph hub first', async () => {
    await seedProject();

    const { document } = buildAtlas(store, tmpDir);

    expect(document.schema).toBe(ATLAS_SCHEMA);
    expect(document.files[0]?.path).toBe('src/kernel.ts');
    expect(document.files[0]?.rank).toBe(1);
  });

  it('carries declarations in source order', async () => {
    await seedProject();

    const { document } = buildAtlas(store, tmpDir);
    const kernel = document.files.find((f) => f.path === 'src/kernel.ts');

    expect(kernel?.symbols.map((s) => s.name)).toContain('WidgetRegistry');
    const lines = (kernel?.symbols ?? []).map((s) => s.line);
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
  });

  it('emits paths as project-relative POSIX, never absolute', async () => {
    await seedProject();

    const { document } = buildAtlas(store, tmpDir);

    for (const file of document.files) {
      expect(file.path.includes('\\')).toBe(false);
      expect(path.isAbsolute(file.path)).toBe(false);
    }
  });

  it('rounds ranks to a fixed precision', async () => {
    await seedProject();

    const { document } = buildAtlas(store, tmpDir);

    for (const file of document.files) {
      // Four decimals: two runs must not differ in the last floating-point bit.
      expect(String(file.rank).replace(/^\d+\.?/, '').length).toBeLessThanOrEqual(4);
    }
  });

  it('records a manifest hash for every file it describes', async () => {
    await seedProject();

    const { document, manifest } = buildAtlas(store, tmpDir);

    expect(Object.keys(manifest.files).sort()).toEqual(document.files.map((f) => f.path).sort());
    expect(manifest.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('atlas determinism', () => {
  it('produces byte-identical output from an unchanged index', async () => {
    await seedProject();

    await writeAtlas(store, tmpDir);
    const first = await Promise.all(
      [ATLAS_JSON, ATLAS_MANIFEST, ATLAS_MARKDOWN].map((name) => readAtlas(name)),
    );
    await writeAtlas(store, tmpDir);
    const second = await Promise.all(
      [ATLAS_JSON, ATLAS_MANIFEST, ATLAS_MARKDOWN].map((name) => readAtlas(name)),
    );

    // Any per-run variation would make every index run a merge conflict.
    expect(second).toEqual(first);
  });

  it('writes LF line endings and a trailing newline', async () => {
    await seedProject();
    await writeAtlas(store, tmpDir);

    for (const name of [ATLAS_JSON, ATLAS_MANIFEST, ATLAS_MARKDOWN]) {
      const body = await readAtlas(name);
      expect(body.includes('\r')).toBe(false);
      expect(body.endsWith('\n')).toBe(true);
    }
  });

  it('carries no timestamps', async () => {
    await seedProject();
    await writeAtlas(store, tmpDir);

    const json = await readAtlas(ATLAS_JSON);
    const manifest = await readAtlas(ATLAS_MANIFEST);
    for (const body of [json, manifest]) {
      expect(body).not.toMatch(/lastIndexed|generatedAt|mtime|\d{13}/);
    }
  });
});

describe('checkAtlasFreshness', () => {
  it('reports missing before anything is written', async () => {
    await seedProject();

    const report = await checkAtlasFreshness(store, tmpDir);

    expect(report.fresh).toBe(false);
    expect(report.reason).toBe('missing');
  });

  it('reports fresh immediately after a write', async () => {
    await seedProject();
    await writeAtlas(store, tmpDir);

    const report = await checkAtlasFreshness(store, tmpDir);

    expect(report.fresh).toBe(true);
    expect(report.digestMatches).toBe(true);
    expect(report.changed).toEqual([]);
  });

  it('names the atlas file whose content changed', async () => {
    await seedProject();
    await writeAtlas(store, tmpDir);

    store.close();
    await write('src/kernel.ts', 'export interface Widget { id: string; renamed: true }\n');
    indexStorePool.evict(tmpDir, indexDir);
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
    store = new IndexStore(tmpDir, { indexDir });

    const report = await checkAtlasFreshness(store, tmpDir);

    expect(report.fresh).toBe(false);
    expect(report.reason).toBe('drift');
    expect(report.changed).toContain('src/kernel.ts');
  });

  it('detects a change to a file the atlas does not itself describe', async () => {
    await seedProject();
    await writeAtlas(store, tmpDir);

    store.close();
    await write('src/newcomer.ts', 'export const newcomer = 1;\n');
    indexStorePool.evict(tmpDir, indexDir);
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
    store = new IndexStore(tmpDir, { indexDir });

    const report = await checkAtlasFreshness(store, tmpDir);

    // The repo-wide digest is what catches this; no atlas file changed.
    expect(report.digestMatches).toBe(false);
    expect(report.fresh).toBe(false);
  });

  it('rejects a manifest from an unknown schema instead of misreading it', async () => {
    await seedProject();
    await writeAtlas(store, tmpDir);
    const manifest = JSON.parse(await readAtlas(ATLAS_MANIFEST)) as AtlasManifest;
    await fs.writeFile(
      atlasPath(ATLAS_MANIFEST),
      JSON.stringify({ ...manifest, schema: ATLAS_SCHEMA + 99 }),
      'utf8',
    );

    const report = await checkAtlasFreshness(store, tmpDir);

    expect(report.reason).toBe('schema');
  });

  it('reports an unreadable manifest rather than throwing', async () => {
    await seedProject();
    await writeAtlas(store, tmpDir);
    await fs.writeFile(atlasPath(ATLAS_MANIFEST), '{ not json', 'utf8');

    expect((await checkAtlasFreshness(store, tmpDir)).reason).toBe('unreadable');
  });
});

describe('project-level entry points', () => {
  it('refuse to run — and refuse to create a database — without an index', async () => {
    await write('src/index.ts', 'export const a = 1;\n');

    const written = await writeProjectAtlas(tmpDir, { indexDir });
    const checked = await checkProjectAtlasFreshness(tmpDir, { indexDir });

    expect(written).toEqual({ indexed: false });
    expect(checked).toEqual({ indexed: false });
    // Writing an atlas must never be the thing that indexes a project.
    await expect(fs.access(path.join(indexDir, 'index.db'))).rejects.toThrow();
  });

  it('write and then verify through the project-level API', async () => {
    await seedProject();
    store.close();
    indexStorePool.evict(tmpDir, indexDir);

    const written = await writeProjectAtlas(tmpDir, { indexDir });
    expect(written).not.toHaveProperty('indexed');

    const report = await checkProjectAtlasFreshness(tmpDir, { indexDir });
    expect(report).toMatchObject({ fresh: true });

    store = new IndexStore(tmpDir, { indexDir });
  });
});
