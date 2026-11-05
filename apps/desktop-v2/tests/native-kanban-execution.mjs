import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixtureModel, fixtureText } from './local-provider.mjs';
import { openProjectView } from './native-project-navigation.mjs';

const PROVIDER = 'desktop-local';

/** Picks a provider/model in the shared ModelPicker; its list opens in a portal. */
async function pickModel(page, picker, provider, model) {
  const trigger = picker.getByRole('button').first();
  await trigger.click();
  await picker.locator('button[aria-expanded="true"]').waitFor();
  const list = page.locator(`[id="${await trigger.getAttribute('aria-controls')}"]`);
  await list.getByLabel('Search models', { exact: true }).fill(`${provider}/${model}`);
  await list.getByRole('button').filter({ hasText: provider }).first().click();
  await picker.getByText(`${provider}/${model}`, { exact: true }).waitFor();
}

/**
 * Adds one option of a shared ChipMultiSelect whose option text is exactly `text`. Its list stays
 * open after a pick and covers the controls below it, so the toggle closes it again.
 */
async function addChip(page, scope, placeholder, query, text) {
  const toggle = scope.getByRole('button', { name: placeholder, exact: true });
  await toggle.click();
  const filter = scope.getByLabel('Filter options', { exact: true });
  await filter.fill(query);
  await scope
    .getByRole('button')
    .filter({ has: page.getByText(text, { exact: true }) })
    .first()
    .click();
  await toggle.click();
  await filter.waitFor({ state: 'detached' });
}

/**
 * A boundary editor of the shared board: a `<details>` whose summary names the layer and its
 * state. Saves a deny path, reads back the engine-normalized selector, then removes the layer.
 */
async function exerciseBoundary({ page, scope, title, deny, stored, waitFor }) {
  const editor = scope
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: new RegExp(`^${title}`) }) });
  const summary = editor.locator('summary');
  await summary.click();
  await editor.getByRole('checkbox', { name: 'Enable this boundary layer', exact: true }).check();
  await editor.getByLabel('Deny selectors').fill(`directory:read_write:${deny}`);
  await editor.getByRole('button', { name: 'Save boundary', exact: true }).click();
  await summary.getByText('confirm · 0 allow · shell confirm', { exact: true }).waitFor();
  await waitFor(
    async () =>
      (await editor.getByLabel('Deny selectors').inputValue()) === `directory:read_write:${stored}`,
    `${title} saved through the engine with a normalized path`,
  );
  await editor.getByRole('button', { name: 'Remove layer', exact: true }).click();
  await summary.getByText('unrestricted', { exact: true }).waitFor();
  await summary.click();
}

/**
 * One card run by a real Kanban worker on the shared board (`@wrongstack/project-surfaces/kanban`):
 * a pinned route, a tool grant and a capability grant read back from the engine, task and board
 * boundaries, a queue audit, then a dispatch that calls the local model without a conversation.
 */
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
  await openProjectView(page, project, 'Kanban');
  const kanban = page.locator('.kanban-surface');
  const boardTitle = 'Native execution checks';
  const taskTitle = 'Native isolated task completion';
  const description =
    'Return a final completion message. Do not call tools or change project files.';
  await kanban.getByLabel('New board title', { exact: true }).fill(boardTitle);
  await kanban.getByLabel('New board title', { exact: true }).press('Enter');
  await kanban.getByRole('heading', { level: 1, name: boardTitle, exact: true }).waitFor();
  await kanban.getByLabel('New task title', { exact: true }).fill(taskTitle);
  await kanban.getByLabel('New task title', { exact: true }).press('Enter');
  const card = kanban.getByRole('button', { name: `Select task: ${taskTitle}`, exact: true });
  await card.press('Enter');
  const inspector = kanban.getByRole('complementary', { name: 'Task inspector', exact: true });
  const tab = (name) => inspector.getByRole('tab', { name: new RegExp(`^${name}\\b`) });
  const closeInspector = async () => {
    await inspector.getByRole('button', { name: 'Close', exact: true }).first().click();
    await inspector.waitFor({ state: 'detached' });
  };
  await inspector.getByLabel('Description / working context').fill(description);
  await inspector.getByRole('button', { name: 'Save task contract', exact: true }).click();
  await kanban.locator('.ws-task-card').filter({ hasText: description }).waitFor();

  await tab('Execution').click();
  await inspector.getByLabel('Primary model source').selectOption('fixed');
  const route = inspector.getByRole('group', {
    name: 'Select exact provider / model…',
    exact: true,
  });
  await pickModel(page, route, PROVIDER, fixtureModel);
  await addChip(page, inspector, 'Restrict to specific tools…', 'read', 'read');
  await inspector.getByRole('button', { name: 'Remove read', exact: true }).waitFor();
  await inspector.getByRole('button', { name: 'Advanced', exact: true }).click();
  await addChip(page, inspector, 'Grant a capability…', 'fs.read', 'fs.read');
  await inspector.getByRole('button', { name: 'Remove Read files', exact: true }).waitFor();
  await inspector.getByRole('button', { name: 'Assign', exact: true }).click();
  // The assignment exists once the engine's reply lands: the card then shows its live run.
  const runStatus = inspector
    .getByText('Live run', { exact: true })
    .locator('xpath=following-sibling::span[1]');
  await waitFor(
    async () => /^(assigned|queued)$/.test((await runStatus.textContent())?.trim() ?? ''),
    'Assignment saved by the engine',
  );
  await closeInspector();
  await card.press('Enter');
  await tab('Execution').click();
  await waitFor(
    async () => (await inspector.getByLabel('Primary model source').inputValue()) === 'fixed',
    'Pinned route reads back',
  );
  await route.getByText(`${PROVIDER}/${fixtureModel}`, { exact: true }).waitFor();
  await inspector.getByRole('button', { name: 'Remove read', exact: true }).waitFor();
  await inspector.getByRole('button', { name: 'Advanced', exact: true }).click();
  await inspector.getByRole('button', { name: 'Remove Read files', exact: true }).waitFor();

  // A task boundary is saved through the engine (which normalizes the path) and removed again
  // before dispatch so it does not change the run below; the board boundary works the same way.
  await tab('Definition').click();
  await exerciseBoundary({
    page,
    scope: inspector,
    title: 'Task boundary',
    deny: 'secrets/',
    stored: 'secrets',
    waitFor,
  });
  await exerciseBoundary({
    page,
    scope: kanban,
    title: 'Board boundary',
    deny: './private/',
    stored: 'private',
    waitFor,
  });

  // Queue health is read without changing the board; an audit is an explicit, reported action.
  // A hosted agentic supervisor also asks the model for card reviews, which the fixture model
  // does not write, so the reported status may be a failure; the result line must still appear.
  await kanban.getByText('Queue health', { exact: true }).waitFor();
  const supervisor = kanban.getByRole('button', { name: /^Kanban Agent\b/ });
  await supervisor.click();
  await kanban.getByRole('button', { name: 'Audit now', exact: true }).click();
  await waitFor(async () => {
    const line = (await supervisor.textContent()) ?? '';
    // The bar lists only counters that are not zero, or that the last audit found no queued work.
    return (
      /\d+ (running|ready|review|blocked|failed|stale|dependency-blocked|parked)\b|No queued work in the last audit/.test(
        line,
      ) && /checked \ds ago/.test(line)
    );
  }, 'Kanban Agent audit result line');
  await supervisor.click();

  await tab('Execution').click();
  const calls = providerFixture.calls.length;
  await inspector.getByRole('button', { name: 'Dispatch', exact: true }).click();
  await waitFor(
    async () => providerFixture.calls.length > calls,
    'Kanban worker calls the actual local model',
    60000,
  );
  await inspector
    .getByText('Last result', { exact: true })
    .locator('xpath=following-sibling::div[1]')
    .filter({ hasText: fixtureText })
    .waitFor({ timeout: 60000 });
  await waitFor(
    async () => (await runStatus.textContent())?.trim() === 'completed',
    'Kanban worker run completed',
    60000,
  );
  assert.equal(
    (await rpc('snapshot')).sessions.length,
    sessionCount,
    'Project Kanban execution does not create a desktop conversation',
  );
  await page.screenshot({ path: join(artifactDir, 'native-kanban-execution.png'), fullPage: true });
  await closeInspector();
  console.log(
    'PASS: native task execution catalog/pinned route/tool grant/assignment readback/boundaries/queue audit/real model dispatch/result without desktop sessions',
  );
}
