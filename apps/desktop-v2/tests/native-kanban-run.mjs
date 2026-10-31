import { join } from 'node:path';
import { openProjectView } from './native-project-navigation.mjs';

/**
 * A board launched as a Goal run from Kanban: the project engine starts the run from the board's
 * cards and binds it back to the same board, which then mirrors the run.
 */
export async function exerciseNativeKanbanRun({ page, project, artifactDir }) {
  await openProjectView(page, project, 'Kanban');
  await page
    .locator('.studio-heading')
    .getByRole('button', { name: 'New board', exact: true })
    .click();
  await page.getByLabel('Board name', { exact: true }).fill('Native board run');
  await page.getByRole('button', { name: 'Create board', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Project boards', exact: true })
    .getByRole('button', { name: 'Native board run', exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Add task to To Do', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('Native board run task');
  await page
    .getByLabel('Task description', { exact: true })
    .fill('Return a final completion message. Do not call tools or change project files.');
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  await page.getByRole('button', { name: 'Native board run task', exact: true }).waitFor();

  await page.getByLabel('Board actions', { exact: true }).click();
  await page.getByRole('button', { name: 'Run board…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Run board', exact: true });
  await dialog.getByRole('radio', { name: /^Goal/ }).check();
  await page.screenshot({
    path: join(artifactDir, 'native-kanban-run-dialog.png'),
    fullPage: true,
  });
  await dialog.getByRole('button', { name: 'Start run', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 60000 });
  await page.getByText('A Goal run started from this board.', { exact: true }).waitFor();
  // The run binds back to this board instead of creating another one.
  await page.getByText(/^Mirrors a Goal run/).waitFor({ timeout: 30000 });
  await page.screenshot({ path: join(artifactDir, 'native-kanban-run.png'), fullPage: true });
  console.log('PASS: a Kanban board starts a Goal run that mirrors back onto the same board');
}
