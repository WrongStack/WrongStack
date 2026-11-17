import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SddInterviewDriver } from '../src/sdd-interview-driver.js';
import { isAISpecSession } from '../src/sdd-session-types.js';
import { SpecStore } from '../src/spec-store.js';
import { TaskGraphStore } from '../src/task-graph-store.js';

const session = {
  id: 's1',
  phase: 'questioning',
  title: 'Fixture',
  userIntent: 'Test hydration',
  projectContext: '',
  questionCount: 1,
  approved: false,
  createdAt: 1,
  updatedAt: 1,
};

async function withSession(
  answers: unknown[],
  check: (driver: SddInterviewDriver) => Promise<void>,
) {
  const root = await fs.mkdtemp(join(tmpdir(), 'session-answer-validation-'));
  const sessionPath = join(root, 'session.json');
  const raw = JSON.stringify({ ...session, answers });
  await fs.writeFile(sessionPath, raw);
  const driver = new SddInterviewDriver({
    specStore: new SpecStore({ baseDir: join(root, 'specs') }),
    graphStore: new TaskGraphStore({ baseDir: join(root, 'graphs') }),
    sessionPath,
  });
  try {
    await check(driver);
    expect(await fs.readFile(sessionPath, 'utf8')).toBe(raw);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

it.each([
  ['null', null],
  ['primitive', 42],
  ['empty record', {}],
  ['non-string question', { question: 1, answer: 'A', timestamp: 1 }],
  ['non-string answer', { question: 'Q?', answer: null, timestamp: 1 }],
  ['missing timestamp', { question: 'Q?', answer: 'A' }],
  ['non-numeric timestamp', { question: 'Q?', answer: 'A', timestamp: '1' }],
])('rejects a persisted %s answer before rendering the interview', async (_name, answer) => {
  await withSession([answer], async (driver) => {
    expect(await driver.loadExisting()).toBe(false);
    expect(isAISpecSession({ ...session, answers: [answer] })).toBe(false);
    const snapshot = driver.snapshot();
    expect(snapshot.answers).toEqual([]);
    expect(snapshot.phase).toBe('questioning');
    expect(snapshot.prompt).toContain('SDD Spec Builder');
  });
});

it.each([
  { label: 'empty history', answers: [] },
  {
    label: 'empty strings and zero timestamp',
    answers: [{ question: '', answer: '', timestamp: 0 }],
  },
])('accepts $label without changing valid persisted data', async ({ answers }) => {
  await withSession(answers, async (driver) => {
    expect(await driver.loadExisting()).toBe(true);
    expect(isAISpecSession({ ...session, answers })).toBe(true);
    expect(driver.snapshot().answers).toEqual(
      answers.map(({ question, answer }) => ({ question, answer })),
    );
  });
});
