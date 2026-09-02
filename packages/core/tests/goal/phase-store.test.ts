import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PhaseStore } from '../../src/goal/phase-store.js';
import { PhaseGraphBuilder } from '../../src/goal/phase-graph-builder.js';

describe('PhaseStore', () => {
  let tmpDir: string;
  let store: PhaseStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-test-'));
    store = new PhaseStore({ baseDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should save and load a phase graph', async () => {
    const builder = new PhaseGraphBuilder({
      title: 'Store Test',
      phases: [
        {
          name: 'Phase A',
          description: 'A',
          priority: 'high',
          estimateHours: 2,
          parallelizable: false,
        },
        {
          name: 'Phase B',
          description: 'B',
          priority: 'medium',
          estimateHours: 1,
          parallelizable: false,
        },
      ],
    });

    const graph = await builder.build();
    await store.save(graph);

    const loaded = await store.load(graph.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe('Store Test');
    expect(loaded!.phases.size).toBe(2);
    expect(loaded!.autonomous).toBe(true);
  });

  it('should list saved graphs', async () => {
    const builder = new PhaseGraphBuilder({
      title: 'List Test',
      phases: [
        {
          name: 'P1',
          description: 'P1',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
        },
      ],
    });

    const graph = await builder.build();
    await store.save(graph);

    const list = await store.list();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.some((g) => g.title === 'List Test')).toBe(true);
  });

  it('should delete a graph', async () => {
    const builder = new PhaseGraphBuilder({
      title: 'Delete Test',
      phases: [
        {
          name: 'P1',
          description: 'P1',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
        },
      ],
    });

    const graph = await builder.build();
    await store.save(graph);
    await store.delete(graph.id);

    const loaded = await store.load(graph.id);
    expect(loaded).toBeNull();
  });

  it('should return null for non-existent graph', async () => {
    const loaded = await store.load('non-existent-id');
    expect(loaded).toBeNull();
  });

  it('migrates legacy goal.json directory checkpoints into autophase', async () => {
    const legacyDir = path.join(tmpDir, 'goal.json');
    const currentDir = path.join(tmpDir, 'autophase');
    const legacy = new PhaseStore({ baseDir: legacyDir });
    const builder = new PhaseGraphBuilder({
      title: 'Legacy checkpoint',
      phases: [
        {
          name: 'P1',
          description: 'P1',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
        },
      ],
    });
    const graph = await builder.build();
    await legacy.save(graph);

    const migrating = new PhaseStore({
      baseDir: currentDir,
      legacyBaseDirs: [legacyDir],
    });
    expect((await migrating.load(graph.id))?.title).toBe('Legacy checkpoint');
    expect(fs.existsSync(path.join(currentDir, `${graph.id}.json`))).toBe(true);
    expect(fs.existsSync(legacyDir)).toBe(false);
  });
});
