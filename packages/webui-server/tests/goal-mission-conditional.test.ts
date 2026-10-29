/**
 * Mission writes carrying `expectedMission` apply only to the mission they were reviewed
 * against, checked inside the goal file update on the real goal.json.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleGoalStateMutation } from '../src/server/goal-handlers.js';

let base = '';
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'goal-mission-conditional-'));
  vi.stubEnv('WRONGSTACK_HOME', join(base, 'home'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(base, { recursive: true, force: true });
});

it('refuses mission writes reviewed against another mission and leaves goal.json unchanged', async () => {
  const project = join(base, 'project');
  const goalPath = resolveWstackPaths({ projectRoot: project }).projectGoal;
  const sent: { type: string; payload: unknown }[] = [];
  const broadcast = (message: { type: string; payload: unknown }) => sent.push(message);
  const mission = async () =>
    JSON.parse(await readFile(goalPath, 'utf8')) as { goal: string; missionId?: string };

  // Creating a mission when the window saw none.
  await handleGoalStateMutation(
    project,
    'goal-state.set',
    { goal: 'First mission', expectedMission: '' },
    broadcast,
  );
  const first = await mission();
  expect(first.goal).toBe('First mission');
  expect(first.missionId).toBeTruthy();

  // A second window that also saw no mission must not replace the one created meanwhile.
  sent.length = 0;
  await handleGoalStateMutation(
    project,
    'goal-state.set',
    { goal: 'Second window', expectedMission: '' },
    broadcast,
  );
  expect(await mission()).toEqual(first);
  expect(sent).toContainEqual({
    type: 'goal-state.error',
    payload: expect.objectContaining({ message: expect.stringMatching(/changed/) }),
  });

  for (const type of ['goal-state.pause', 'goal-state.clear'] as const) {
    sent.length = 0;
    await handleGoalStateMutation(project, type, { expectedMission: 'another-mission' }, broadcast);
    expect(await mission()).toEqual(first);
    expect(sent.some((message) => message.type === 'goal-state.error')).toBe(true);
  }

  // The reviewed mission is replaced, and a write without the field behaves as before.
  await handleGoalStateMutation(
    project,
    'goal-state.set',
    { goal: 'Replacement', expectedMission: first.missionId },
    broadcast,
  );
  expect((await mission()).goal).toBe('Replacement');
  await handleGoalStateMutation(project, 'goal-state.clear', {}, broadcast);
  await expect(readFile(goalPath, 'utf8')).rejects.toThrow();
});
