import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixtureModel, fixtureText } from './local-provider.mjs';

export async function exerciseNativeTaskExecution({
  page,
  rpc,
  project,
  waitFor,
  artifactDir,
  providerFixture,
}) {
  const sessionCount = (await rpc('snapshot')).sessions.length;
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await page
    .getByRole('navigation', { name: `${project.name} workspace` })
    .getByRole('button', { name: 'Kanban', exact: true })
    .click();
  await page
    .locator('.studio-heading')
    .getByRole('button', { name: 'New board', exact: true })
    .click();
  await page.getByLabel('Board name', { exact: true }).fill('Native execution checks');
  await page.getByRole('button', { name: 'Create board', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Project boards', exact: true })
    .getByRole('button', { name: 'Native execution checks', exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Add task to To Do', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('Native isolated task completion');
  await page
    .getByLabel('Task description', { exact: true })
    .fill('Return a final completion message. Do not call tools or change project files.');
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  await page.getByRole('button', { name: 'Native isolated task completion', exact: true }).click();
  const section = (name) =>
    page
      .getByRole('navigation', { name: 'Task detail sections', exact: true })
      .getByRole('button', { name, exact: true });
  await section('Execution').click();
  await page.getByLabel('Task model routing', { exact: true }).selectOption('fixed');
  await page.getByLabel('Task execution provider', { exact: true }).selectOption('desktop-local');
  await page.getByLabel('Task execution model', { exact: true }).selectOption(fixtureModel);
  await page
    .getByRole('group', { name: /Allowed tools/ })
    .getByRole('checkbox', { name: /^read\b/ })
    .check();
  await page.getByText('Budgets & capabilities', { exact: true }).click();
  await page.getByLabel('Task capability policy', { exact: true }).selectOption('custom');
  await page
    .getByRole('group', { name: /^Capabilities/ })
    .getByRole('checkbox', { name: 'fs.read', exact: true })
    .check();
  await page.getByRole('button', { name: 'Save assignment', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Assignment saved.' }).waitFor();
  await page.getByRole('button', { name: 'Close task details', exact: true }).click();
  await page.getByRole('button', { name: 'Native isolated task completion', exact: true }).click();
  await section('Execution').click();
  assert.equal(await page.getByLabel('Task model routing', { exact: true }).inputValue(), 'fixed');
  assert.equal(
    await page.getByLabel('Task execution provider', { exact: true }).inputValue(),
    'desktop-local',
  );
  assert.equal(
    await page.getByLabel('Task execution model', { exact: true }).inputValue(),
    fixtureModel,
  );
  // A task boundary is saved through the engine (which normalizes the path) and removed again
  // before dispatch so it does not change the run below.
  await section('Boundary').click();
  const boundary = page.getByRole('region', { name: 'Task resource boundary', exact: true });
  await boundary.getByRole('button', { name: 'Add a task boundary', exact: true }).click();
  await boundary.getByRole('button', { name: 'Add deny path', exact: true }).click();
  await boundary.getByLabel('Deny 1 path', { exact: true }).fill('secrets/');
  await boundary.getByRole('button', { name: 'Save boundary', exact: true }).click();
  await boundary.getByRole('status').filter({ hasText: 'Task boundary saved.' }).waitFor();
  assert.equal(await boundary.getByLabel('Deny 1 path', { exact: true }).inputValue(), 'secrets');
  await boundary.getByRole('button', { name: 'Remove task boundary', exact: true }).click();
  await boundary.getByRole('button', { name: 'Save boundary', exact: true }).click();
  await boundary
    .getByRole('status')
    .filter({ hasText: 'Task boundary removed; only the board boundary applies.' })
    .waitFor();
  // The board boundary is edited the same way from the board header.
  await page.getByRole('button', { name: 'Board boundary', exact: true }).click();
  const boardBoundary = page.getByRole('region', { name: 'Board resource boundary', exact: true });
  await boardBoundary.getByRole('button', { name: 'Add a board boundary', exact: true }).click();
  await boardBoundary.getByRole('button', { name: 'Add deny path', exact: true }).click();
  await boardBoundary.getByLabel('Deny 1 path', { exact: true }).fill('./private/');
  await boardBoundary.getByRole('button', { name: 'Save boundary', exact: true }).click();
  await boardBoundary.getByRole('status').filter({ hasText: 'Board boundary saved.' }).waitFor();
  assert.equal(
    await boardBoundary.getByLabel('Deny 1 path', { exact: true }).inputValue(),
    'private',
  );
  await boardBoundary.getByRole('button', { name: 'Remove board boundary', exact: true }).click();
  await boardBoundary.getByRole('button', { name: 'Save boundary', exact: true }).click();
  await boardBoundary
    .getByRole('status')
    .filter({ hasText: 'Board boundary removed; task boundaries still apply.' })
    .waitFor();
  await page.keyboard.press('Escape');
  await boardBoundary.waitFor({ state: 'detached' });
  // Queue health is read without changing the board; an audit is a confirmed, reported action.
  // A hosted agentic supervisor also asks the model for card reviews, which the fixture model
  // does not write, so the reported status may be a failure; the result line must still appear.
  const health = page.getByRole('region', { name: 'Queue health', exact: true });
  await health.getByText('Ready to start', { exact: false }).waitFor();
  await health.getByRole('button', { name: 'Audit queue…', exact: true }).click();
  await page.getByRole('button', { name: 'Audit and repair', exact: true }).click();
  await health
    .getByRole('status')
    .filter({
      hasText: / cards reconciled · \d+ expired assignments returned to the queue$/,
    })
    .waitFor();
  await section('Execution').click();
  const calls = providerFixture.calls.length;
  await page.getByRole('button', { name: 'Dispatch agent', exact: true }).click();
  await page.getByRole('button', { name: 'Start task agent', exact: true }).click();
  await waitFor(
    async () => providerFixture.calls.length > calls,
    'Kanban worker calls the actual local model',
    60000,
  );
  await page
    .locator('.task-run-output')
    .filter({ hasText: fixtureText })
    .waitFor({ timeout: 60000 });
  await page
    .locator('.kanban-execution .task-facts dd')
    .getByText('completed', { exact: true })
    .waitFor();
  assert.equal(
    (await rpc('snapshot')).sessions.length,
    sessionCount,
    'Project Kanban execution does not create a desktop conversation',
  );
  await page.screenshot({ path: join(artifactDir, 'native-kanban-execution.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close task details', exact: true }).click();
  console.log(
    'PASS: native task execution catalog/pinned route/tool grant/assignment readback/real model dispatch/result without desktop sessions',
  );
}
