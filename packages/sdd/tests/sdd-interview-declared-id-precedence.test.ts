/**
 * `dependsOn` lists the tasks' DECLARED ids (spec-builder-prompts.ts). The
 * driver also registers positional (`t3`, `3`) and title aliases as fallbacks,
 * but a later task's alias used to overwrite an earlier task's declared id: with
 * a gap in the numbering (t1, t3, t4) the edge t3 -> t4 resolved to t4 itself
 * and was dropped, so dependent work became runnable in parallel.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';
import { SddInterviewDriver } from '../src/sdd-interview-driver.js';
import { SpecStore } from '../src/spec-store.js';
import { TaskGraphStore } from '../src/task-graph-store.js';

vi.setConfig({ testTimeout: 45_000 });

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((dir) => removeProjectFixtureDirectory(dir, { maxRetries: 10, retryDelay: 50 })),
  );
});

const SPEC_OUTPUT = [
  '```json',
  JSON.stringify({
    title: 'OAuth login',
    overview: 'Add OAuth-based login with session management.',
    sections: [{ type: 'overview', title: 'Overview', content: 'OAuth login flow', level: 1 }],
    requirements: [
      {
        id: 'REQ-1',
        type: 'security',
        priority: 'critical',
        description: 'Verify OAuth tokens',
        acceptanceCriteria: ['tokens validated'],
      },
    ],
  }),
  '```',
].join('\n');

const task = (id: string, title: string, dependsOn: string[]) => ({
  id,
  title,
  description: title,
  type: 'feature',
  priority: 'high',
  specRequirementId: 'REQ-1',
  dependsOn,
});

async function blockerTitles(tasks: unknown[]): Promise<Map<string, string[]>> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-declared-id-'));
  roots.push(dir);
  const driver = new SddInterviewDriver({
    specStore: new SpecStore({ baseDir: path.join(dir, 'specs') }),
    graphStore: new TaskGraphStore({ baseDir: path.join(dir, 'graphs') }),
    minQuestions: 1,
    maxQuestions: 3,
  });
  driver.start('OAuth login');
  await driver.ingestAgentOutput(SPEC_OUTPUT);
  await driver.ingestAgentOutput(['```json', JSON.stringify(tasks), '```'].join('\n'));
  const graph = driver.getGraph();
  const tracker = driver.getTracker();
  expect(graph && tracker).toBeTruthy();
  const titleById = new Map([...graph!.nodes.values()].map((n) => [n.id, n.title]));
  return new Map(
    [...graph!.nodes.values()].map((n) => [
      n.title,
      tracker!.getBlockers(n.id).map((id) => titleById.get(id) ?? id),
    ]),
  );
}

describe('SddInterviewDriver dependsOn resolution', () => {
  it('resolves a declared id even when a later task occupies that position', async () => {
    const blockers = await blockerTitles([
      task('t1', 'Alpha', []),
      task('t3', 'Charlie', ['t1']),
      task('t4', 'Delta', ['t3']),
    ]);
    expect(blockers.get('Charlie')).toEqual(['Alpha']);
    expect(blockers.get('Delta')).toEqual(['Charlie']);
  });

  it('resolves declared ids listed out of positional order', async () => {
    const blockers = await blockerTitles([
      task('t2', 'Bravo', []),
      task('t1', 'Alpha', []),
      task('t3', 'Charlie', ['t2']),
    ]);
    expect(blockers.get('Charlie')).toEqual(['Bravo']);
  });

  it('still falls back to positional and title references', async () => {
    const blockers = await blockerTitles([
      { title: 'Alpha', description: 'a', specRequirementId: 'REQ-1', dependsOn: [] },
      { title: 'Bravo', description: 'b', specRequirementId: 'REQ-1', dependsOn: ['t1'] },
      { title: 'Charlie', description: 'c', specRequirementId: 'REQ-1', dependsOn: ['Bravo'] },
    ]);
    expect(blockers.get('Bravo')).toEqual(['Alpha']);
    expect(blockers.get('Charlie')).toEqual(['Bravo']);
  });
});
