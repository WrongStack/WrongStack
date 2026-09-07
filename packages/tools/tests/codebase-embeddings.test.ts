import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type EmbeddingPort,
  embedFiles,
  embedProjectFiles,
  enrichConcepts,
  MAX_EMBED_CHARS,
  runIndexer,
  type SummarizerPort,
} from '../src/codebase-index/index.js';
import { IndexStore, indexStorePool } from '../src/codebase-index/writer.js';

let tmpDir: string;
let indexDir: string;
let store: IndexStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-embed-'));
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

/**
 * A deterministic stand-in for a real model: hashes each text into a unit
 * vector. Two identical texts embed identically; different texts almost never
 * collide — enough to test the plumbing without a model download.
 */
function fakePort(
  opts: { id?: string; dimensions?: number; fail?: boolean } = {},
): EmbeddingPort & { texts: string[] } {
  const dimensions = opts.dimensions ?? 384;
  const texts: string[] = [];
  return {
    id: opts.id ?? 'fake:v1',
    dimensions,
    texts,
    embed: vi.fn(async (batch: string[]) => {
      if (opts.fail === true) throw new Error('inference failed');
      texts.push(...batch);
      return batch.map((text) => {
        const vector = new Float32Array(dimensions);
        for (let i = 0; i < text.length; i++) {
          vector[text.charCodeAt(i) % dimensions] += 1;
        }
        let norm = 0;
        for (const value of vector) norm += value * value;
        norm = Math.sqrt(norm);
        if (norm > 0) for (let i = 0; i < dimensions; i++) vector[i] /= norm;
        return vector;
      });
    }),
  };
}

const summariser = (text: (file: string) => string): SummarizerPort => ({
  describeFile: async (input) => ({ summary: text(input.file) }),
});

async function seedProject(): Promise<void> {
  await write('src/kernel.ts', 'export function buildWidget(id: string): string { return id; }\n');
  await write(
    'src/leaf.ts',
    "import { buildWidget } from './kernel.js';\nexport function leaf(): void { buildWidget('a'); }\n",
  );
  await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
  store = new IndexStore(tmpDir, { indexDir });
}

describe('embedFiles', () => {
  it('embeds every indexed file on a first pass', async () => {
    await seedProject();
    const port = fakePort();

    const result = await embedFiles(store, port, relativeOf);

    expect(result.embedded).toBe(2);
    expect(store.countFileVectors()).toBe(2);
  });

  it('embeds the concept summary when one exists', async () => {
    await seedProject();
    await enrichConcepts(
      store,
      summariser(() => 'Builds widgets from an id.'),
      relativeOf,
    );
    const port = fakePort();

    const result = await embedFiles(store, port, relativeOf);

    expect(result.fromDeclarations).toBe(0);
    expect(port.texts.join('\n')).toContain('Builds widgets from an id.');
  });

  it('falls back to declaration names when there is no summary', async () => {
    await seedProject();
    const port = fakePort();

    const result = await embedFiles(store, port, relativeOf);

    expect(result.fromDeclarations).toBe(2);
    expect(port.texts.join('\n')).toContain('buildWidget');
  });

  it('always includes the path, so identical summaries do not collapse', async () => {
    await seedProject();
    await enrichConcepts(
      store,
      summariser(() => 'Identical description.'),
      relativeOf,
    );
    const port = fakePort();

    await embedFiles(store, port, relativeOf);

    expect(port.texts.some((t) => t.startsWith('src/kernel.ts'))).toBe(true);
    expect(port.texts.some((t) => t.startsWith('src/leaf.ts'))).toBe(true);
  });

  it('re-embeds nothing when the text is unchanged', async () => {
    await seedProject();
    await embedFiles(store, fakePort(), relativeOf);

    const second = fakePort();
    const result = await embedFiles(store, second, relativeOf);

    expect(second.texts).toEqual([]);
    expect(result.cached).toBe(2);
  });

  it('re-embeds a file whose summary changed', async () => {
    await seedProject();
    await enrichConcepts(
      store,
      summariser(() => 'First description.'),
      relativeOf,
    );
    await embedFiles(store, fakePort(), relativeOf);

    await enrichConcepts(
      store,
      summariser((f) => `Rewritten for ${f}.`),
      relativeOf,
      {
        force: true,
      },
    );
    const port = fakePort();
    const result = await embedFiles(store, port, relativeOf);

    expect(result.embedded).toBe(2);
    expect(port.texts.join('\n')).toContain('Rewritten for');
  });

  it('wipes every vector when the model changes', async () => {
    await seedProject();
    await embedFiles(store, fakePort({ id: 'model-a' }), relativeOf);

    const result = await embedFiles(store, fakePort({ id: 'model-b' }), relativeOf);

    // Two models produce incomparable spaces; a partial swap would silently
    // rank one half of the index against the other.
    expect(result.providerChanged).toBe(true);
    expect(result.cached).toBe(0);
    expect(result.embedded).toBe(2);
  });

  it('rejects vectors of the wrong width instead of storing them', async () => {
    await seedProject();

    const result = await embedFiles(
      store,
      { id: 'bad', dimensions: 384, embed: async (b) => b.map(() => new Float32Array(16)) },
      relativeOf,
    );

    expect(result.embedded).toBe(0);
    expect(store.countFileVectors()).toBe(0);
  });

  it('records an inference failure without failing the pass', async () => {
    await seedProject();

    const result = await embedFiles(store, fakePort({ fail: true }), relativeOf);

    expect(result.embedded).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('inference failed');
  });

  it('honours maxFiles and an abort signal', async () => {
    await seedProject();

    expect((await embedFiles(store, fakePort(), relativeOf, { maxFiles: 1 })).embedded).toBe(1);

    const controller = new AbortController();
    controller.abort();
    const port = fakePort();
    await embedFiles(store, port, relativeOf, { signal: controller.signal, force: true });
    expect(port.texts).toEqual([]);
  });

  it('truncates very long text', async () => {
    await seedProject();
    await enrichConcepts(
      store,
      summariser(() => 'x'.repeat(9000)),
      relativeOf,
    );
    const port = fakePort();

    await embedFiles(store, port, relativeOf);

    for (const text of port.texts) expect(text.length).toBeLessThanOrEqual(MAX_EMBED_CHARS);
  });

  it('drops vectors for files that left the index', async () => {
    await seedProject();
    await embedFiles(store, fakePort(), relativeOf);

    store.close();
    await fs.rm(path.join(tmpDir, 'src/leaf.ts'));
    indexStorePool.evict(tmpDir, indexDir);
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
    store = new IndexStore(tmpDir, { indexDir });

    const result = await embedFiles(store, fakePort(), relativeOf);

    expect(result.pruned).toBe(1);
    expect(store.countFileVectors()).toBe(1);
  });
});

describe('searchFileVectors', () => {
  it('ranks the file whose text matches the query closest', async () => {
    await seedProject();
    await enrichConcepts(
      store,
      summariser((file) =>
        file.endsWith('kernel.ts') ? 'Constructs widget values.' : 'Unrelated leaf helper.',
      ),
      relativeOf,
    );
    const port = fakePort();
    await embedFiles(store, port, relativeOf);

    const [query] = await port.embed(['src/kernel.ts\nConstructs widget values.']);
    const hits = store.searchFileVectors(query as Float32Array, 5, 0);

    expect(relativeOf(hits[0]?.file ?? '')).toBe('src/kernel.ts');
    expect(hits[0]?.score).toBeGreaterThan(0.9);
  });

  it('applies the score floor', async () => {
    await seedProject();
    const port = fakePort();
    await embedFiles(store, port, relativeOf);

    expect(store.searchFileVectors(new Float32Array(384), 5, 0.99)).toEqual([]);
  });

  it('ignores vectors of a different width rather than throwing', async () => {
    await seedProject();
    await embedFiles(store, fakePort(), relativeOf);

    expect(store.searchFileVectors(new Float32Array(16), 5, 0)).toEqual([]);
  });

  it('returns nothing when nothing has been embedded', async () => {
    await seedProject();

    expect(store.countFileVectors()).toBe(0);
    expect(store.searchFileVectors(new Float32Array(384).fill(0.05), 5, 0)).toEqual([]);
  });
});

describe('embedProjectFiles', () => {
  it('refuses to run — and to create a database — without an index', async () => {
    await write('src/index.ts', 'export const a = 1;\n');

    const result = await embedProjectFiles(tmpDir, fakePort(), { indexDir });

    expect(result).toEqual({ indexed: false });
    await expect(fs.access(path.join(indexDir, 'index.db'))).rejects.toThrow();
  });
});
