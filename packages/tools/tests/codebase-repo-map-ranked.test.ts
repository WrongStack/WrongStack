import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateRepoMap, runIndexer } from '../src/codebase-index/index.js';
import { IndexStore, indexStorePool } from '../src/codebase-index/writer.js';

let tmpDir: string;
let indexDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-repomap-'));
  indexDir = path.join(tmpDir, '.idx');
});

afterEach(async () => {
  // The pool keeps the SQLite handle warm; on Windows an open handle makes the
  // temp-dir removal fail with EBUSY.
  indexStorePool.evict(tmpDir, indexDir);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function write(rel: string, body: string): Promise<void> {
  const full = path.join(tmpDir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, 'utf8');
}

/**
 * A hub every leaf imports, plus leaves nothing imports. Centrality must put
 * the hub first even though its filename carries no entry-point cue and the
 * leaves are alphabetically earlier.
 */
async function seedProject(leafCount = 6): Promise<void> {
  await write(
    'src/aaa-shared-kernel.ts',
    `export interface Widget { id: string; }
export function buildWidget(id: string): Widget { return { id }; }
export class WidgetRegistry {
  private items: Widget[] = [];
  public add(w: Widget): void { this.items.push(w); }
}
`,
  );
  for (let i = 0; i < leafCount; i++) {
    await write(
      `src/zz-leaf-${i}.ts`,
      `import { buildWidget, WidgetRegistry } from './aaa-shared-kernel.js';
export function leaf${i}(): void {
  const r = new WidgetRegistry();
  r.add(buildWidget('${i}'));
}
`,
    );
  }
  await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
}

describe('generateRepoMap on a ranked index', () => {
  it('ranks the graph hub above the leaves that import it', async () => {
    await seedProject();

    const result = await generateRepoMap({ projectRoot: tmpDir, indexDir, maxTokens: 1500 });

    expect(result.rankedFiles.length).toBeGreaterThan(0);
    // The old filename heuristic had no way to know this; the graph does.
    expect(result.rankedFiles[0]).toBe('src/aaa-shared-kernel.ts');
  });

  it('opens with a cluster and hotspot header', async () => {
    await seedProject();

    const result = await generateRepoMap({ projectRoot: tmpDir, indexDir, maxTokens: 1500 });

    expect(result.map).toContain('ranked by graph centrality');
    expect(result.map).toContain('// Clusters');
    expect(result.map).toContain('// Hotspots');
    expect(result.map).toContain('hub: src/aaa-shared-kernel.ts');
  });

  it('still emits navigable signatures below the header', async () => {
    await seedProject();

    const result = await generateRepoMap({ projectRoot: tmpDir, indexDir, maxTokens: 1500 });

    expect(result.map).toContain('src/aaa-shared-kernel.ts (ts):');
    expect(result.map).toContain('WidgetRegistry');
  });

  it('reports the ranked-file total, not the rendered count', async () => {
    await seedProject();

    const result = await generateRepoMap({ projectRoot: tmpDir, indexDir, maxTokens: 1500 });

    // 1 hub + 6 leaves all carry symbols, so all seven get ranked even when
    // the budget renders fewer.
    expect(result.totalFilesScanned).toBe(7);
    expect(result.filesCount).toBeLessThanOrEqual(result.totalFilesScanned);
  });

  it('promotes focus files ahead of more central ones', async () => {
    await seedProject();

    const result = await generateRepoMap({
      projectRoot: tmpDir,
      indexDir,
      maxTokens: 1500,
      focusFiles: ['src/zz-leaf-3.ts'],
    });

    expect(result.rankedFiles[0]).toBe('src/zz-leaf-3.ts');
  });

  it('honours a tight token budget', async () => {
    await seedProject();

    const tight = await generateRepoMap({ projectRoot: tmpDir, indexDir, maxTokens: 60 });

    expect(tight.estimatedTokens).toBeLessThanOrEqual(90);
    expect(tight.filesCount).toBeLessThan(7);
  });

  it('keeps the header from crowding out every signature', async () => {
    await seedProject();

    const result = await generateRepoMap({ projectRoot: tmpDir, indexDir, maxTokens: 400 });

    // Header is capped at a share of the budget, so a body still renders.
    expect(result.filesCount).toBeGreaterThan(0);
  });
});

describe('generateRepoMap falls back cleanly', () => {
  it('uses the filesystem heuristic when the project was never indexed', async () => {
    await write('src/index.ts', 'export function main(): void {}\n');

    const result = await generateRepoMap({ projectRoot: tmpDir, indexDir, maxTokens: 500 });

    expect(result.map).toContain('src/index.ts');
    // No index means no centrality, so no header is claimed.
    expect(result.map).not.toContain('graph centrality');
  });

  it('does not create an index database as a side effect', async () => {
    await write('src/index.ts', 'export function main(): void {}\n');

    await generateRepoMap({ projectRoot: tmpDir, indexDir, maxTokens: 500 });

    // Generating a map must never be the thing that indexes a project.
    await expect(fs.access(path.join(indexDir, 'index.db'))).rejects.toThrow();
  });

  it('falls back when the index exists but carries no ranks', async () => {
    await write('src/index.ts', 'export function main(): void {}\n');
    // An index opened but never rank-passed — the shape of a first run in
    // flight, or an index written by an older build.
    const store = new IndexStore(tmpDir, { indexDir });
    store.close();

    const result = await generateRepoMap({ projectRoot: tmpDir, indexDir, maxTokens: 500 });

    expect(result.map).toContain('src/index.ts');
    expect(result.map).not.toContain('graph centrality');
  });

  it('reports an empty project without throwing', async () => {
    const result = await generateRepoMap({ projectRoot: tmpDir, indexDir, maxTokens: 500 });

    expect(result.filesCount).toBe(0);
    expect(result.rankedFiles).toEqual([]);
    expect(result.map).toContain('No indexable source files found');
  });

  it('walks past the old 500-file ceiling', async () => {
    // The previous implementation stopped scanning at ~500 files, so on any
    // real repo the map described whichever directories it reached first.
    for (let i = 0; i < 620; i++) {
      await write(`src/pkg${i % 20}/mod${i}.ts`, `export const v${i} = ${i};\n`);
    }

    const result = await generateRepoMap({ projectRoot: tmpDir, indexDir, maxTokens: 200 });

    expect(result.totalFilesScanned).toBe(620);
  });
});
