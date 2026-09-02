import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';

let tempDir: string;
let store: SqliteSageStore;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-edge-weight-'));
  store = new SqliteSageStore({ projectRoot: tempDir });
  await store.initialize();
});

afterAll(async () => {
  store.close();
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function edgeOf(
  from: string,
  to: string,
  relation: string,
): Promise<{ weight: number } | undefined> {
  const edges = await store.graphFor(from, 1, 20);
  return edges.find((e) => e.from === from && e.to === to && e.relation === relation);
}

describe('edge-weight merge policy (unified 2026-08-02)', () => {
  it('addGraphEdge is monotone (MAX): repeated identical assertions do not inflate weight', async () => {
    await store.addGraphEdge('mem:pol-a', 'mem:pol-b', 'supersedes', 1);
    await store.addGraphEdge('mem:pol-a', 'mem:pol-b', 'supersedes', 1);
    await store.addGraphEdge('mem:pol-a', 'mem:pol-b', 'supersedes', 1);
    const edge = await edgeOf('mem:pol-a', 'mem:pol-b', 'supersedes');
    expect(edge).toBeDefined();
    expect(edge?.weight).toBe(1);
  });

  it('addGraphEdge never erodes a higher prior weight', async () => {
    await store.addGraphEdge('mem:pol-c', 'mem:pol-d', 'related_to', 3);
    await store.addGraphEdge('mem:pol-c', 'mem:pol-d', 'related_to', 1);
    const edge = await edgeOf('mem:pol-c', 'mem:pol-d', 'related_to');
    expect(edge).toBeDefined();
    expect(edge?.weight).toBe(3);
  });

  it('anchor edges mirror the memory confidence and re-sync follows confidence changes', async () => {
    const memory = await store.rememberSage({
      text: 'anchor weight probe alpha unique',
      kind: 'file_note',
      importance: 0.8,
      confidence: 0.9,
      anchors: [{ type: 'file', path: 'src/weight-probe.ts' }],
    });
    let edge = await edgeOf(`mem:${memory.id}`, 'file:src/weight-probe.ts', 'about_file');
    expect(edge?.weight).toBeCloseTo(0.9, 5);

    await store.updateSage(memory.id, { confidence: 0.4 });
    edge = await edgeOf(`mem:${memory.id}`, 'file:src/weight-probe.ts', 'about_file');
    expect(edge?.weight).toBeCloseTo(0.4, 5);
  });
});
