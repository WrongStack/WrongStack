import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';
import { PhaseStore } from '../src/phase-store.js';

/**
 * F5: the legacy copy is the recovery source for an unparseable current graph
 * file — load() heals from it. migration (list()) used mere existence of the
 * current file to decide the legacy was redundant, so a corrupt current made
 * it delete the only valid copy and the Goal was permanently lost. The legacy
 * is redundant only once the current copy LOADS.
 */
describe('PhaseStore legacy migration preserves the recovery source (F5)', () => {
  let tmpDir: string;
  let baseDir: string;
  let legacyDir: string;
  let store: PhaseStore;
  let graphId: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-migration-'));
    baseDir = path.join(tmpDir, 'current');
    legacyDir = path.join(tmpDir, 'legacy');
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(legacyDir, { recursive: true });
    store = new PhaseStore({ baseDir, legacyBaseDirs: [legacyDir] });
    const graph = await new PhaseGraphBuilder({
      title: 'Migration goal',
      phases: [
        {
          name: 'Phase A',
          description: 'A',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
        },
      ],
    }).build();
    graphId = graph.id;
    await new PhaseStore({ baseDir: legacyDir }).save(graph);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const corruptCurrent = () => {
    fs.writeFileSync(path.join(baseDir, `${graphId}.json`), '{this is not json');
  };
  const currentUsable = () => {
    try {
      return (
        JSON.parse(fs.readFileSync(path.join(baseDir, `${graphId}.json`), 'utf8')).id === graphId
      );
    } catch {
      return false;
    }
  };
  const legacyPresent = () => fs.existsSync(path.join(legacyDir, `${graphId}.json`));

  it('heals a corrupt current from the legacy copy during list()', async () => {
    corruptCurrent();
    const listed = await store.list();
    expect(currentUsable()).toBe(true);
    expect(listed.some((goal) => goal.id === graphId)).toBe(true);
    expect((await store.load(graphId))?.id).toBe(graphId);
  });

  it('is idempotent across repeated list() calls and removes the legacy once healed', async () => {
    corruptCurrent();
    await store.list();
    await store.list();
    await store.list();
    expect(currentUsable()).toBe(true);
    expect(legacyPresent()).toBe(false);
    expect((await store.load(graphId))?.id).toBe(graphId);
  });

  it('loses nothing when both copies are corrupt (no throw, no false graph)', async () => {
    corruptCurrent();
    fs.writeFileSync(path.join(legacyDir, `${graphId}.json`), '{also not json');
    const listed = await store.list();
    expect(listed.some((goal) => goal.id === graphId)).toBe(false);
    expect(await store.load(graphId)).toBeNull();
  });

  it('keeps the direct load() heal contract (no list first)', async () => {
    corruptCurrent();
    expect((await store.load(graphId))?.id).toBe(graphId);
    expect(currentUsable()).toBe(true);
  });

  it('still removes a redundant legacy when the current copy loads', async () => {
    await store.list();
    expect(legacyPresent()).toBe(false);
    expect((await store.load(graphId))?.id).toBe(graphId);
  });

  it('still migrates when no current copy exists', async () => {
    const listed = await store.list();
    expect(listed.some((goal) => goal.id === graphId)).toBe(true);
    expect((await store.load(graphId))?.id).toBe(graphId);
  });
});
