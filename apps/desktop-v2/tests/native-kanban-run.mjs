import { join } from 'node:path';
import { openProjectView } from './native-project-navigation.mjs';

/**
 * A board launched as a Goal run from Kanban: the project engine starts the run from the board's
 * cards and binds it back to the same board, which then mirrors the run. The desktop's Kanban is
 * the WebUI's shared board (`@wrongstack/project-surfaces/kanban`).
 */
export async function exerciseNativeKanbanRun({ page, project, artifactDir }) {
  await openProjectView(page, project, 'Kanban');
  const kanban = page.locator('.kanban-surface');
  const title = 'Native board run';
  const taskTitle = 'Native board run task';
  const description =
    'Return a final completion message. Do not call tools or change project files.';
  await kanban.getByLabel('New board title', { exact: true }).fill(title);
  await kanban.getByLabel('New board title', { exact: true }).press('Enter');
  const heading = kanban.getByRole('heading', { level: 1, name: title, exact: true });
  await heading.waitFor();
  await kanban.getByLabel('New task title', { exact: true }).fill(taskTitle);
  await kanban.getByLabel('New task title', { exact: true }).press('Enter');
  const card = kanban.getByRole('button', { name: `Select task: ${taskTitle}`, exact: true });
  // A narrow window can put the board toolbar over the card; select it from the keyboard.
  await card.press('Enter');
  const inspector = kanban.getByRole('complementary', { name: 'Task inspector', exact: true });
  await inspector.getByLabel('Description / working context').fill(description);
  await inspector.getByRole('button', { name: 'Save task contract', exact: true }).click();
  // The run is built from the stored board: the card shows the description once the engine
  // has stored it.
  await kanban.locator('.ws-task-card').filter({ hasText: description }).waitFor();
  await inspector.getByRole('button', { name: 'Close', exact: true }).first().click();
  await inspector.waitFor({ state: 'detached' });

  const startAsGoal = kanban.getByRole('button', { name: 'Start as Goal', exact: true });
  await kanban.getByText('Run this board as a live agent job:', { exact: true }).waitFor();
  await page.screenshot({
    path: join(artifactDir, 'native-kanban-run-start.png'),
    fullPage: true,
  });
  await startAsGoal.click();
  // The run binds back to this board instead of creating another one: the board stays selected
  // and now carries the run's controls in place of the launch bar.
  await kanban
    .getByText('Live run — steer it from here', { exact: true })
    .waitFor({ timeout: 60000 });
  await startAsGoal.waitFor({ state: 'detached' });
  await page.screenshot({ path: join(artifactDir, 'native-kanban-run.png'), fullPage: true });
  console.log('PASS: a Kanban board starts a Goal run that mirrors back onto the same board');
}
