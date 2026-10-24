import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';
import { GoalRunLeaseBusyError, PhaseStore } from '../src/phase-store.js';

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
      multiBoard: true,
      verifyTasks: true,
      chimeraReview: true,
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
    graph.sessionId = 'goal-owner-s3';
    graph.worktrees = true;
    graph.runBase = { branch: 'main', sha: 'abc123' };
    graph.finalVerification = { status: 'passed', checkedAt: 123 };
    await store.save(graph);

    const loaded = await store.load(graph.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe('Store Test');
    expect(loaded!.sessionId).toBe('goal-owner-s3');
    expect(loaded!.phases.size).toBe(2);
    expect(loaded!.autonomous).toBe(true);
    expect(loaded!.multiBoard).toBe(true);
    expect(loaded!.verifyTasks).toBe(true);
    expect(loaded!.chimeraReview).toBe(true);
    expect(loaded!.worktrees).toBe(true);
    expect(loaded!.runBase).toEqual({ branch: 'main', sha: 'abc123' });
    expect(loaded!.finalVerification).toEqual({ status: 'passed', checkedAt: 123 });
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

  it('reports failed graphs as failed in the saved-run list', async () => {
    const graph = await new PhaseGraphBuilder({
      title: 'Failed Test',
      phases: [
        {
          name: 'P1',
          description: 'P1',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
        },
      ],
    }).build();
    const phase = graph.phases.values().next().value;
    if (!phase) throw new Error('expected phase');
    phase.status = 'failed';
    graph.failedPhaseIds.push(phase.id);
    await store.save(graph);

    expect((await store.list()).find((entry) => entry.id === graph.id)?.status).toBe('failed');
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

  it('allows only one active run lease and releases it idempotently', async () => {
    const release = await store.acquireRunLease('cli:test');
    await expect(store.acquireRunLease('webui:test')).rejects.toBeInstanceOf(GoalRunLeaseBusyError);
    await release();
    await release();
    const releaseNext = await store.acquireRunLease('webui:test');
    await releaseNext();
  });

  it('reclaims a lease left by a crashed process', async () => {
    await fs.promises.writeFile(
      path.join(tmpDir, '.active-run.lock'),
      JSON.stringify({
        ownerId: 'crashed',
        pid: 2_147_483_647,
        acquiredAt: new Date(0).toISOString(),
      }),
    );
    const release = await store.acquireRunLease('replacement');
    await release();
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

  // Regression for H-6 (PATH-001): the WS frame `graphId` arrived via
  // `goal-ws-handler.ts:254-256` as a raw `as string` cast, so a payload
  // id of `../../secret` resolved outside the store and `loadGraph()`
  // returned its contents (broadcast as `goal.state`). Containment now
  // rejects any id with `/` or `\`, NUL, excessive length, or one that
  // escapes `baseDir`.
  describe('path traversal containment (H-6)', () => {
    it.each([
      ['relative traversal', '../../../tmp/escaped'],
      ['absolute path', '/etc/passwd'],
      ['backslash traversal', '..\\..\\escaped'],
      ['mixed slashes', '../foo/bar'],
      ['embedded NUL', 'abc\0def'],
      ['empty id', ''],
      ['long id', 'x'.repeat(300)],
    ])('rejects %s on load', async (_label, badId) => {
      await expect(store.load(badId)).rejects.toThrow(/Invalid phase-graph id/);
    });
  });
});
