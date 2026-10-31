import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveWstackPaths } from '../../../packages/persistence/dist/index.js';
import { SpecStore, TaskGraphStore } from '../../../packages/sdd/dist/index.js';
import { openProjectView } from './native-project-navigation.mjs';
import { exerciseNativeRequirements } from './native-requirements.mjs';

export async function exerciseNativeSdd({
  page,
  rpc,
  project,
  waitFor,
  artifactDir,
  wrongstackHome,
  restartUi,
  otherProject,
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
      (item) => item.type === 'chronicle.status_result' && item.payload?.requestId === requestId,
    )?.payload;
  }, 'SDD project identity');
  const paths = resolveWstackPaths({ projectRoot: health.projectRoot, globalRoot: wrongstackHome });
  const spec = await new SpecStore({ baseDir: paths.projectSpecs }).createDraft(
    'Native project specification',
    'Document the project workflow.',
  );
  const now = Date.now();
  const first = {
    id: crypto.randomUUID(),
    title: 'Inspect boundaries',
    description: 'Map project ownership.',
    type: 'feature',
    priority: 'high',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  const second = {
    id: crypto.randomUUID(),
    title: 'Verify the workflow',
    description: 'Check the resulting plan.',
    type: 'test',
    priority: 'medium',
    status: 'pending',
    createdAt: now + 1,
    updatedAt: now + 1,
  };
  await new TaskGraphStore({ baseDir: paths.projectTaskGraphs }).save({
    id: crypto.randomUUID(),
    specId: spec.id,
    title: 'Native project graph',
    nodes: new Map([
      [first.id, first],
      [second.id, second],
    ]),
    edges: [{ from: first.id, to: second.id, type: 'depends_on' }],
    rootNodes: [first.id],
    createdAt: now,
    updatedAt: now,
  });
  await openProjectView(page, project, 'SDD');
  const sdd = page.getByRole('region', { name: 'Project SDD' });
  await sdd.getByRole('button', { name: /Specifications/ }).click();
  await sdd.getByRole('button', { name: /Native project specification/ }).click({ timeout: 60000 });
  await sdd.getByText('Map project ownership.').waitFor({ timeout: 60000 });
  await sdd.getByText('Verify the workflow', { exact: true }).waitFor();
  await sdd.getByText('Depends on: t01', { exact: true }).waitFor();
  assert.equal(
    await sdd.getByRole('checkbox', { name: 'Isolate work in Git worktrees' }).isChecked(),
    false,
  );
  assert.equal((await rpc('snapshot')).sessions.length, 0, 'SDD specifications are project-owned');
  await sdd.getByRole('button', { name: 'Dependency graph' }).click();
  await sdd
    .locator('.sdd-flow .react-flow__node')
    .filter({ hasText: 'Inspect boundaries' })
    .waitFor();
  await waitFor(
    async () => (await sdd.locator('.sdd-flow .react-flow__edge').count()) === 1,
    'Rendered SDD dependency',
  );
  await page.screenshot({
    path: join(artifactDir, 'native-sdd-specification.png'),
    fullPage: true,
  });
  await sdd.getByRole('button', { name: /Runs/ }).click();
  await sdd.getByText('No SDD runs have been recorded.').waitFor();
  const maintenance = sdd.getByRole('region', { name: 'SDD project maintenance' });
  await maintenance.getByRole('button', { name: 'Clean managed worktrees', exact: true }).click();
  await maintenance
    .getByRole('button', { name: 'Confirm clean managed worktrees', exact: true })
    .click();
  await maintenance.getByText('Operation completed', { exact: true }).waitFor({ timeout: 60000 });
  await maintenance.getByText('Worktrees removed', { exact: true }).waitFor();
  await maintenance.getByRole('button', { name: 'Clear project SDD', exact: true }).click();
  await maintenance.getByText(/This clears all specifications/).waitFor();
  assert.ok(
    await new SpecStore({ baseDir: paths.projectSpecs }).load(spec.id),
    'Spec remains until clear is confirmed',
  );
  await maintenance.getByRole('button', { name: 'Confirm clear project sdd', exact: true }).click();
  await waitFor(
    async () => (await new SpecStore({ baseDir: paths.projectSpecs }).load(spec.id)) === null,
    'Project SDD cleared through engine',
  );
  await maintenance.getByText(/Cleared:/).waitFor({ timeout: 60000 });
  await page.screenshot({ path: join(artifactDir, 'native-sdd-maintenance.png'), fullPage: true });
  await sdd.getByRole('button', { name: /Specifications/ }).click();
  await sdd.getByText('No specifications have been recorded for this project.').waitFor();
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1480, height: 960 });
  await exerciseNativeRequirements({
    page,
    rpc,
    project,
    artifactDir,
    intakeStoreDir: paths.projectRequirementIntakes,
    waitFor,
    restartUi,
    otherProject,
  });
  console.log(
    'PASS: project SDD specification catalog and dependency details without a conversation',
  );
}
