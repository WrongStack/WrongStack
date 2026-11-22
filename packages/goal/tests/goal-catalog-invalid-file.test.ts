import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';
import { PhaseStore } from '../src/phase-store.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function storeWithOneGoal() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-catalog-invalid-'));
  dirs.push(dir);
  const store = new PhaseStore({ baseDir: dir });
  const graph = await new PhaseGraphBuilder({
    title: 'Valid goal',
    phases: [
      {
        name: 'Build',
        description: '',
        priority: 'high',
        estimateHours: 1,
        parallelizable: false,
        taskTemplates: [
          { title: 'Build', description: '', type: 'chore', priority: 'high', estimateHours: 1 },
        ],
      },
    ],
  }).build();
  await store.save(graph);
  return { dir, store };
}

const stray = {
  version: 1,
  title: 'Stray',
  description: '',
  phases: [],
  rootPhaseIds: [],
  activePhaseIds: [],
  completedPhaseIds: [],
  autonomous: true,
  stopOnComplete: true,
  createdAt: 1,
  updatedAt: 1,
};

// list() skips invalid graph files one by one; listGoals() builds on it and
// must not let one unusable file hide every valid Goal from /goals and the
// WebUI goal list.
describe('PhaseStore.listGoals with one unusable graph file', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['an id that is missing', { ...stray, failedPhaseIds: [] }],
    ['an id that names a nested path', { ...stray, id: 'nested/evil', failedPhaseIds: [] }],
    ['a loadable graph without failedPhaseIds', { ...stray, id: 'stray' }],
  ];
  for (const [label, content] of cases) {
    it(`skips a file with ${label}`, async () => {
      const { dir, store } = await storeWithOneGoal();
      await fs.writeFile(path.join(dir, 'stray.json'), JSON.stringify(content), 'utf8');
      const goals = await store.listGoals();
      expect(goals.map((goal) => goal.title)).toEqual(['Valid goal']);
    });
  }
});
