import assert from 'node:assert/strict';
import { openProjectView } from './native-project-navigation.mjs';

/**
 * Resource input typed on a recorded requirement but not yet saved survives an
 * actual UI process restart. Returns the restarted page with the form open.
 */
export async function exerciseNativeResourceInput({ page, project, intakeId, waitFor, restartUi }) {
  const formKey = `requirement-resource-input:${intakeId}`;
  const stored = () =>
    page.evaluate(
      (params) =>
        window.__TAURI_INTERNALS__.invoke('host_request', { method: 'form-draft.get', params }),
      { projectId: project.id, formKey },
    );
  let requirements = page.getByRole('region', { name: 'Project requirements' });
  await requirements.getByText('Add supporting resource', { exact: true }).click();
  let append = requirements.locator('.requirement-append');
  await append.getByLabel('Resource name', { exact: true }).fill('Pending note');
  await append.getByLabel('Resource reference', { exact: true }).fill('docs/pending.md');
  await waitFor(
    async () => (await stored()).value?.fields?.reference === 'docs/pending.md',
    'Unsaved resource input acknowledged',
  );
  page = await restartUi();
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await openProjectView(page, project, 'SDD');
  await page
    .getByRole('region', { name: 'Project SDD' })
    .getByRole('button', { name: 'Requirements', exact: true })
    .click();
  requirements = page.getByRole('region', { name: 'Project requirements' });
  await requirements
    .getByRole('button', { name: /Native requirement fixture/ })
    .click({ timeout: 60000 });
  await requirements.getByText('Add supporting resource', { exact: true }).click();
  append = requirements.locator('.requirement-append');
  await append.getByRole('status').filter({ hasText: 'Restored resource input' }).waitFor();
  assert.equal(
    await append.getByLabel('Resource name', { exact: true }).inputValue(),
    'Pending note',
  );
  assert.equal(
    await append.getByLabel('Resource reference', { exact: true }).inputValue(),
    'docs/pending.md',
  );
  console.log('PASS: native unsaved requirement resource input survives a UI process restart');
  return { page, stored };
}
