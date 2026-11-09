import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';
import { SddInterviewDriver } from '../src/sdd-interview-driver.js';
import type { AISpecPhase } from '../src/sdd-session-types.js';
import { SpecStore } from '../src/spec-store.js';
import { TaskGraphStore } from '../src/task-graph-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((dir) => removeProjectFixtureDirectory(dir, { maxRetries: 10, retryDelay: 50 })),
  );
});

function makeDriver() {
  const dir = path.join(
    os.tmpdir(),
    `sdd-rewind-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  roots.push(dir);
  return new SddInterviewDriver({
    specStore: new SpecStore({ baseDir: path.join(dir, 'specs') }),
    graphStore: new TaskGraphStore({ baseDir: path.join(dir, 'graphs') }),
    minQuestions: 1,
    maxQuestions: 3,
  });
}

const SPEC_OUTPUT = [
  '```json',
  JSON.stringify({
    title: 'OAuth login',
    overview: 'Add OAuth login.',
    sections: [{ type: 'overview', title: 'Overview', content: 'OAuth', level: 1 }],
    requirements: [
      {
        id: 'REQ-1',
        type: 'functional',
        priority: 'high',
        description: 'Log in',
        acceptanceCriteria: [],
      },
    ],
  }),
  '```',
].join('\n');

// Regression: `sdd.spec.rewind` forwards the client's `targetPhase` unchecked
// and `rewindTo` applied any value. A "rewind" could therefore jump a fresh
// interview forward to executing/done with no approved spec, or persist a phase
// that does not exist. Only earlier phases are valid rewind targets.
describe('SddInterviewDriver.rewind direction', () => {
  it('rewinds to an earlier phase (control)', async () => {
    const driver = makeDriver();
    driver.start('OAuth login');
    await driver.ingestAgentOutput(SPEC_OUTPUT);
    expect(driver.phase()).toBe('spec_review');

    await expect(driver.rewind('questioning')).resolves.toMatchObject({ phase: 'questioning' });
  });

  it.each(['executing', 'done', 'task_review'] as const)(
    'refuses to jump a questioning session forward to %s',
    async (target) => {
      const driver = makeDriver();
      driver.start('OAuth login');
      expect(driver.phase()).toBe('questioning');

      const result = await driver.rewind(target);

      expect(result.phase).toBe('questioning');
      expect(driver.phase()).toBe('questioning');
    },
  );

  it('refuses a phase that does not exist', async () => {
    const driver = makeDriver();
    driver.start('OAuth login');
    await driver.ingestAgentOutput(SPEC_OUTPUT);

    const result = await driver.rewind('bogus' as AISpecPhase);

    expect(result.phase).toBe('spec_review');
    expect(driver.snapshot().spec).toBeDefined();
  });
});
