import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openProjectView } from './native-project-navigation.mjs';

export async function exerciseNativeRequirementRecordDrafts({
  page,
  project,
  intakeId,
  rpc,
  waitFor,
  restartUi,
  artifactDir,
}) {
  const resource = `/api/requirement-intakes/${intakeId}`;
  const request = async (method, body = null) => {
    const response = await rpc('project.http', { projectId: project.id, resource, method, body });
    assert.equal(response.ok, true, `${method} ${resource}`);
    return response.data;
  };
  const snapshot = () =>
    page.evaluate(
      ({ projectId, intakeId }) =>
        window.__TAURI_INTERNALS__.invoke('host_request', {
          method: 'form-draft.get',
          params: { projectId, formKey: `requirements-record:${intakeId}` },
        }),
      { projectId: project.id, intakeId },
    );
  let requirements = page.getByRole('region', { name: 'Project requirements' });
  const reopen = async () => {
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
  };
  const edited = 'This metadata draft survives a native application restart.';
  await requirements.getByRole('button', { name: 'Edit information', exact: true }).click();
  await requirements.getByLabel('Expected outcome', { exact: true }).fill(edited);
  await waitFor(
    async () => (await snapshot()).value?.fields?.expectedOutcome === edited,
    'Record metadata draft committed',
  );
  await reopen();
  await requirements.getByLabel('Expected outcome', { exact: true }).waitFor();
  assert.equal(
    await requirements.getByLabel('Expected outcome', { exact: true }).inputValue(),
    edited,
  );
  let record = await request('GET');
  await request('PATCH', { priority: 'low', expectedVersion: record.version });
  await requirements.getByRole('button', { name: 'Save information', exact: true }).click();
  await requirements
    .getByRole('alert')
    .filter({ hasText: /modified concurrently/ })
    .waitFor();
  assert.equal(
    await requirements.getByLabel('Expected outcome', { exact: true }).inputValue(),
    edited,
  );
  assert.notEqual((await request('GET')).expectedOutcome, edited);
  await requirements.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  await requirements.getByRole('button', { name: 'Reload record', exact: true }).click();
  record = await request('GET');
  const question = record.questions.find((item) => item.status === 'unanswered');
  assert.ok(question, 'Fixture has an unanswered intake question');
  const text = 'This answer draft survives a native application restart.';
  await requirements.getByLabel(`Answer: ${question.question}`, { exact: true }).fill(text);
  await waitFor(
    async () => (await snapshot()).value?.answers?.[question.id]?.text === text,
    'Record answer draft committed',
  );
  await reopen();
  const answer = requirements.getByLabel(`Answer: ${question.question}`, { exact: true });
  await answer.waitFor();
  assert.equal(await answer.inputValue(), text);
  await answer.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifactDir, 'native-requirement-answer-restored.png'),
    fullPage: true,
  });
  record = await request('GET');
  await request('PATCH', { priority: 'medium', expectedVersion: record.version });
  let questionPanel = requirements
    .locator('.requirement-questions article')
    .filter({ hasText: question.question });
  await questionPanel.getByRole('button', { name: 'Record answer', exact: true }).click();
  await requirements
    .getByRole('alert')
    .filter({ hasText: /modified concurrently/ })
    .waitFor();
  assert.equal(await answer.inputValue(), text);
  assert.equal(
    (await request('GET')).answers.some((item) => item.answer === text),
    false,
  );
  await requirements.getByRole('button', { name: 'Reload record', exact: true }).click();
  questionPanel = requirements
    .locator('.requirement-questions article')
    .filter({ hasText: question.question });
  await questionPanel
    .getByRole('button', { name: 'Use current record version', exact: true })
    .click();
  await questionPanel.getByRole('button', { name: 'Record answer', exact: true }).click();
  await requirements.getByText('Answer recorded.', { exact: true }).waitFor();
  assert.ok((await request('GET')).answers.some((item) => item.answer === text));
  await waitFor(async () => (await snapshot()).value === null, 'Acknowledged record draft cleared');
  console.log(
    'PASS: native record metadata/answer restart recovery, stale server version refusal and explicit answer review',
  );
  return page;
}
