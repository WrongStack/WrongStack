import assert from 'node:assert/strict';
import { join } from 'node:path';
import { requirementSubmissionFingerprint } from '../src/requirement-draft.ts';
import { openProjectView } from './native-project-navigation.mjs';

const savedDraft = (page, projectId) =>
  page.evaluate(
    (id) =>
      window.__TAURI_INTERNALS__.invoke('host_request', {
        method: 'form-draft.get',
        params: { projectId: id, formKey: 'requirements-new' },
      }),
    projectId,
  );
const openRequirements = async (page, project) => {
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await openProjectView(page, project, 'SDD');
  const sdd = page.getByRole('region', { name: 'Project SDD' });
  await sdd.getByRole('button', { name: 'Requirements', exact: true }).click();
  const requirements = sdd.getByRole('region', { name: 'Project requirements' });
  await requirements.getByLabel('Original request', { exact: true }).waitFor({ timeout: 60000 });
  return requirements;
};

export async function exerciseNativeRequirementDrafts({
  page,
  project,
  otherProject,
  waitFor,
  restartUi,
  original,
  artifactDir,
}) {
  const stored = await waitFor(async () => {
    const snapshot = await savedDraft(page, project.id);
    return snapshot.value?.original === original &&
      snapshot.value?.attachments?.length === 1 &&
      snapshot.value?.resources?.length === 1
      ? snapshot
      : false;
  }, 'Whole new requirement draft committed');
  assert.equal(
    (await savedDraft(page, otherProject.id)).value,
    null,
    'Other project has its own draft',
  );
  page = await restartUi();
  const requirements = await openRequirements(page, project);
  assert.equal(
    await requirements.getByLabel('Original request', { exact: true }).inputValue(),
    original,
  );
  assert.equal(
    await requirements.getByLabel('Requirement title', { exact: true }).inputValue(),
    'Native requirement fixture',
  );
  await requirements.getByText('Design brief', { exact: true }).waitFor();
  await requirements.getByText('Tracked issue', { exact: true }).waitFor();
  assert.equal(
    (await savedDraft(page, project.id)).revision,
    stored.revision,
    'Hydration does not rewrite the draft',
  );

  await page.evaluate(
    (id) => window.__TAURI_INTERNALS__.invoke('open_project_window', { id }),
    project.id,
  );
  const other = await waitFor(
    () =>
      page
        .context()
        .pages()
        .find((candidate) => candidate !== page && candidate.url().includes('project=')),
    'Other requirement window',
    60000,
  );
  const errors = [];
  other.on('pageerror', (error) => errors.push(error.message));
  await other.getByRole('status', { name: 'Local engine connected', exact: true }).waitFor({ timeout: 60000 });
  const remote = await openRequirements(other, project);
  assert.equal(await remote.getByLabel('Original request', { exact: true }).inputValue(), original);
  const mainText = 'First window owns the saved requirement draft.';
  await requirements.getByLabel('Original request', { exact: true }).fill(mainText);
  await waitFor(
    async () => (await savedDraft(page, project.id)).value?.original === mainText,
    'Main requirement draft committed',
  );
  const localText = 'Keep this unsaved second-window draft.';
  await remote.getByLabel('Original request', { exact: true }).fill(localText);
  const conflict = remote.getByRole('region', { name: 'New requirement draft storage' });
  await conflict.getByRole('button', { name: 'Compare draft versions', exact: true }).waitFor();
  assert.equal(
    await remote.getByLabel('Original request', { exact: true }).inputValue(),
    localText,
  );
  assert.equal(
    await remote.getByRole('button', { name: 'Save draft', exact: true }).isDisabled(),
    true,
  );
  assert.equal((await savedDraft(page, project.id)).value.original, mainText);
  await conflict.getByRole('button', { name: 'Compare draft versions', exact: true }).click();
  await conflict.getByLabel('Saved requirement draft').waitFor();
  assert.equal(await conflict.getByLabel('Saved requirement draft').inputValue(), mainText);
  const newerText = 'The reviewed saved draft has changed again.';
  await requirements.getByLabel('Original request', { exact: true }).fill(newerText);
  await waitFor(
    async () => (await savedDraft(page, project.id)).value?.original === newerText,
    'Newer requirement draft committed',
  );
  await conflict.getByRole('button', { name: 'Use saved draft', exact: true }).click();
  await conflict.getByRole('button', { name: 'Confirm use saved draft', exact: true }).click();
  await conflict
    .getByRole('alert')
    .filter({ hasText: /changed again/ })
    .waitFor();
  assert.equal(
    await remote.getByLabel('Original request', { exact: true }).inputValue(),
    localText,
  );
  await conflict.getByRole('button', { name: 'Compare draft versions', exact: true }).click();
  await conflict.getByLabel('Saved requirement draft').waitFor();
  await conflict.getByRole('button', { name: 'Use saved draft', exact: true }).click();
  await conflict.getByRole('button', { name: 'Confirm use saved draft', exact: true }).click();
  await waitFor(
    async () =>
      (await remote.getByLabel('Original request', { exact: true }).inputValue()) === newerText,
    'Reviewed saved draft restored',
  );
  assert.deepEqual(errors, []);
  await other.close();
  await requirements.getByLabel('Original request', { exact: true }).fill(original);
  await waitFor(
    async () => (await savedDraft(page, project.id)).value?.original === original,
    'Original fixture draft restored',
  );
  const snapshot = await savedDraft(page, project.id);
  const catalog = await page.evaluate(
    (id) =>
      window.__TAURI_INTERNALS__.invoke('host_request', {
        method: 'project.http',
        params: { projectId: id, resource: '/api/requirement-intakes', method: 'GET', body: null },
      }),
    project.id,
  );
  assert.equal(catalog.ok, true);
  const fields = snapshot.value.fields;
  const split = (value) =>
    value
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
  const input = {
    projectId: catalog.data.projectId,
    originalRequest: original,
    requestedBy: 'desktop',
    ...fields,
    targetUsers: split(fields.targetUsers),
    constraints: split(fields.constraints),
    providedContext: split(fields.providedContext),
    attachments: snapshot.value.attachments,
    relatedResources: snapshot.value.resources,
  };
  const retryKey = `desktop-native-retry-${crypto.randomUUID()}`;
  const attempt = { fingerprint: requirementSubmissionFingerprint(input), key: retryKey };
  await page.evaluate(
    ({ id, value, revision }) =>
      window.__TAURI_INTERNALS__.invoke('host_request', {
        method: 'form-draft.save',
        params: { projectId: id, formKey: 'requirements-new', value, expectedRevision: revision },
      }),
    { id: project.id, value: { ...snapshot.value, attempt }, revision: snapshot.revision },
  );
  // Simulate a server-accepted create whose reply never reached the form.
  const accepted = await page.evaluate(
    ({ id, input }) =>
      window.__TAURI_INTERNALS__.invoke('host_request', {
        method: 'project.http',
        params: {
          projectId: id,
          resource: `/api/projects/${input.projectId}/requirement-intakes`,
          method: 'POST',
          body: input,
          operationId: crypto.randomUUID(),
        },
      }),
    { id: project.id, input: { ...input, idempotencyKey: retryKey } },
  );
  assert.equal(accepted.ok, true);
  const expectedIntakeId = accepted.data.record.id;
  page = await restartUi();
  const restoredForm = await openRequirements(page, project);
  assert.equal((await savedDraft(page, project.id)).value.attempt.key, retryKey);
  assert.equal(
    await restoredForm.getByLabel('Original request', { exact: true }).inputValue(),
    original,
  );
  await restoredForm
    .getByRole('heading', { name: 'New requirement', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifactDir, 'native-requirement-draft-restored.png'),
    fullPage: true,
  });
  console.log(
    'PASS: requirement draft restart, project isolation, stale window/review refusal and persisted retry identity',
  );
  return { page, retryKey, expectedIntakeId };
}
