import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PhaseGraphBuilder, PhaseStore } from '../../../packages/goal/dist/index.js';
import { resolveWstackPaths } from '../../../packages/persistence/dist/index.js';
import { openProjectView } from './native-project-navigation.mjs';

export async function exerciseNativeGoals({
  page,
  rpc,
  project,
  waitFor,
  artifactDir,
  wrongstackHome,
}) {
  const requestId = crypto.randomUUID();
  await rpc('project.send', {
    projectId: project.id,
    message: { type: 'chronicle.status', payload: { requestId } },
  });
  let offset = 0;
  const health = await waitFor(async () => {
    const batch = await rpc('project.events', { projectId: project.id, offset });
    offset = batch.offset;
    return batch.events.find(
      (event) => event.type === 'chronicle.status_result' && event.payload?.requestId === requestId,
    )?.payload;
  }, 'Project storage identity');
  const paths = resolveWstackPaths({ projectRoot: health.projectRoot, globalRoot: wrongstackHome });
  const store = new PhaseStore({ baseDir: paths.projectAutophase });
  const graph = await new PhaseGraphBuilder({
    title: 'Desktop mission fixture',
    description: 'Deliver a complete project workflow.',
    phases: [
      {
        name: 'Discovery',
        description: 'Inspect the project.',
        priority: 'high',
        estimateHours: 2,
        parallelizable: false,
        taskTemplates: [
          {
            title: 'Review project boundaries',
            description: 'Check ownership and persisted state.',
            type: 'task',
            priority: 'high',
            estimateHours: 1,
            tags: ['desktop'],
          },
        ],
      },
    ],
  }).build();
  await store.save(graph);
  console.log(`Goal fixture store: ${store.baseDir}; id: ${graph.id}`);
  await rpc('project.send', { projectId: project.id, message: { type: 'goal.list', payload: {} } });
  const catalog = await waitFor(async () => {
    const batch = await rpc('project.events', { projectId: project.id, offset });
    offset = batch.offset;
    for (const event of batch.events.filter((item) => item.type === 'goal.list'))
      console.log('Goal catalog response:', JSON.stringify(event.payload));
    return batch.events.find(
      (event) =>
        event.type === 'goal.list' && event.payload?.goals?.some((item) => item.id === graph.id),
    );
  }, 'Saved goal in project engine catalog');
  assert.ok(catalog, 'The project engine must discover its saved goal');

  await openProjectView(page, project, 'Goals');
  const workspace = page.getByRole('region', { name: 'Project Goals' });
  const mission = workspace.getByRole('region', { name: 'Persistent project mission' });
  await mission.getByText('No persistent mission has been set for this project.').waitFor();
  await mission.getByRole('button', { name: 'Set mission' }).click();
  await mission.getByLabel('Mission', { exact: true }).fill('Keep project boundaries explicit.');
  await mission.getByRole('button', { name: 'Save mission' }).click();
  await mission.getByText('Keep project boundaries explicit.', { exact: true }).waitFor();
  await waitFor(
    async () =>
      JSON.parse(await readFile(paths.projectGoal, 'utf8')).goal ===
      'Keep project boundaries explicit.',
    'Persistent mission saved',
  );
  await page.screenshot({ path: join(artifactDir, 'native-project-mission.png'), fullPage: true });
  await mission.getByRole('button', { name: 'Replace mission' }).click();
  await mission.getByLabel('Mission', { exact: true }).fill('Protect project boundaries.');
  await mission.getByRole('button', { name: 'Save mission' }).click();
  await mission.getByText(/resets the previous mission/).waitFor();
  assert.equal(
    JSON.parse(await readFile(paths.projectGoal, 'utf8')).goal,
    'Keep project boundaries explicit.',
  );
  await mission.getByRole('button', { name: 'Confirm replacement' }).click();
  await mission.getByText('Protect project boundaries.', { exact: true }).waitFor();
  await waitFor(
    async () =>
      JSON.parse(await readFile(paths.projectGoal, 'utf8')).goal === 'Protect project boundaries.',
    'Persistent mission replaced',
  );
  await mission.getByRole('button', { name: 'Pause', exact: true }).click();
  await waitFor(
    async () => JSON.parse(await readFile(paths.projectGoal, 'utf8')).goalState === 'paused',
    'Persistent mission paused',
  );
  await mission.getByRole('button', { name: 'Resume', exact: true }).click();
  await waitFor(
    async () => JSON.parse(await readFile(paths.projectGoal, 'utf8')).goalState === 'active',
    'Persistent mission resumed',
  );
  await mission.getByRole('button', { name: 'Clear', exact: true }).click();
  await mission.getByRole('button', { name: 'Confirm clear' }).click();
  await mission.getByText('No persistent mission has been set for this project.').waitFor();
  assert.equal(
    (await store.load(graph.id)).id,
    graph.id,
    'Clearing the mission does not clear the execution goal',
  );
  await workspace.getByRole('button', { name: 'New goal' }).click();
  await workspace.getByLabel('Goal', { exact: true }).fill('Build a project feature in one day.');
  await workspace.getByRole('button', { name: 'Assess goal' }).click();
  await workspace.getByText('Assessment unavailable', { exact: true }).waitFor({ timeout: 60000 });
  assert.equal(
    await workspace.getByLabel('Goal', { exact: true }).inputValue(),
    'Build a project feature in one day.',
  );
  await workspace.getByRole('button', { name: 'Cancel', exact: true }).click();
  await workspace
    .getByRole('button', { name: /Desktop mission fixture/ })
    .click({ timeout: 60000 });
  await workspace.getByText('Discovery', { exact: true }).waitFor({ timeout: 60000 });
  await workspace.getByRole('button', { name: /Review project boundaries/ }).click();
  await workspace.getByText('Check ownership and persisted state.').waitFor();
  assert.equal(
    await workspace.getByLabel('Assign agent').count(),
    0,
    'Stopped goals do not expose live-only mutations',
  );
  await workspace.getByLabel('Change status').selectOption('review');
  await waitFor(async () => {
    const saved = await store.load(graph.id);
    return [...saved.phases.values()][0].taskGraph.nodes.values().next().value.status === 'review';
  }, 'Goal task status persistence');
  await waitFor(
    async () => (await workspace.getByLabel('Change status').inputValue()) === 'review',
    'Goal task status in UI',
  );
  assert.equal((await rpc('snapshot')).sessions.length, 0, 'Goals are project-owned');
  await page.screenshot({ path: join(artifactDir, 'native-project-goals.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log(
    'PASS: project Goal catalog, phase, task details and persisted status without a conversation',
  );
}
