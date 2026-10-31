import assert from 'node:assert/strict';

export async function exerciseNativeDraftConflict({
  page,
  project,
  agent,
  identity,
  waitFor,
  providerFixture,
  artifactDir,
}) {
  const main = page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  const pages = page.context();
  await page.evaluate(
    (id) => window.__TAURI_INTERNALS__.invoke('open_project_window', { id }),
    project.id,
  );
  const other = await waitFor(
    () =>
      pages.pages().find((candidate) => candidate !== page && candidate.url().includes('project=')),
    'Second project window',
    60000,
  );
  await other.getByRole('status', { name: 'Local engine connected', exact: true }).waitFor({ timeout: 60000 });
  await other.locator('.tree-session').filter({ hasText: 'WrongStack engine proof' }).click();
  await other.locator(`[data-engine-session="${identity.sessionId}"]`).waitFor({ timeout: 60000 });
  const local = other.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  await local.waitFor();
  assert.equal(await local.inputValue(), '');
  await waitFor(
    async () =>
      !(await other.getByRole('button', { name: 'Configure provider', exact: true }).count()),
    'Second window provider ready',
    60000,
  );
  await main.fill('Draft saved in the first window.');
  await waitFor(
    async () =>
      (
        await page.evaluate(
          (id) =>
            window.__TAURI_INTERNALS__.invoke('host_request', {
              method: 'draft.get',
              params: { id },
            }),
          agent.id,
        )
      ).text === 'Draft saved in the first window.',
    'First window draft committed',
    60000,
  );
  await local.fill('Unsaved draft in the second window.');
  const notice = other
    .locator('.session-workspace > .draft-conflict')
    .filter({ hasText: 'This draft changed in another window.' });
  await notice.waitFor({ timeout: 60000 });
  assert.equal(await local.inputValue(), 'Unsaved draft in the second window.');
  assert.equal(
    (
      await page.evaluate(
        (id) =>
          window.__TAURI_INTERNALS__.invoke('host_request', {
            method: 'draft.get',
            params: { id },
          }),
        agent.id,
      )
    ).text,
    'Draft saved in the first window.',
  );
  assert.equal(await other.locator('.composer-send').isEnabled(), false);
  await notice.getByRole('button', { name: 'Compare versions', exact: true }).click();
  await notice.getByRole('heading', { name: 'Saved version', exact: true }).waitFor();
  await notice.getByRole('button', { name: 'Use saved version', exact: true }).click();
  await notice.getByRole('button', { name: 'Confirm use saved version', exact: true }).click();
  await waitFor(
    async () =>
      (await local.count()) && (await local.inputValue()) === 'Draft saved in the first window.',
    'Conflict recovery reloads the saved version',
    60000,
  );
  await main.fill('A newer draft from the first window.');
  await waitFor(
    async () =>
      (
        await page.evaluate(
          (id) =>
            window.__TAURI_INTERNALS__.invoke('host_request', {
              method: 'draft.get',
              params: { id },
            }),
          agent.id,
        )
      ).text === 'A newer draft from the first window.',
    'Newer draft committed',
    60000,
  );
  const calls = providerFixture.calls.length;
  await other.locator('.composer-send').click();
  await notice.waitFor({ timeout: 60000 });
  assert.equal(
    providerFixture.calls.length,
    calls,
    'Stale draft must be refused before contacting the provider',
  );
  assert.equal(await local.inputValue(), 'Draft saved in the first window.');
  const localPng = Buffer.from(
    await other.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 8;
      canvas.height = 8;
      const context = canvas.getContext('2d');
      context.fillStyle = '#2463ab';
      context.fillRect(0, 0, 8, 8);
      return canvas.toDataURL('image/png').split(',')[1];
    }),
    'base64',
  );
  await other
    .getByLabel('Attachment files', { exact: true })
    .setInputFiles({ name: 'local-conflict.png', mimeType: 'image/png', buffer: localPng });
  await other
    .getByRole('button', { name: 'Remove attachment local-conflict.png', exact: true })
    .waitFor();
  await notice.getByRole('button', { name: 'Compare versions', exact: true }).click();
  await notice.getByRole('heading', { name: 'Saved version', exact: true }).waitFor();
  await main.fill('Another newer draft after comparison.');
  await waitFor(
    async () =>
      (
        await page.evaluate(
          (id) =>
            window.__TAURI_INTERNALS__.invoke('host_request', {
              method: 'draft.get',
              params: { id },
            }),
          agent.id,
        )
      ).text === 'Another newer draft after comparison.',
    'Concurrent change after comparison',
    60000,
  );
  await notice.getByRole('button', { name: 'Keep my version', exact: true }).click();
  await notice.getByRole('button', { name: 'Confirm use my version', exact: true }).click();
  await notice
    .getByText('The saved draft changed again. Review the latest version before choosing.', {
      exact: true,
    })
    .waitFor();
  assert.equal(
    (
      await page.evaluate(
        (id) =>
          window.__TAURI_INTERNALS__.invoke('host_request', {
            method: 'draft.get',
            params: { id },
          }),
        agent.id,
      )
    ).text,
    'Another newer draft after comparison.',
  );
  await notice.getByRole('button', { name: 'Refresh saved version', exact: true }).click();
  await notice.getByText('Another newer draft after comparison.', { exact: true }).waitFor();
  assert.equal(await notice.count(), 1, 'Only one conflict card appears after a second conflict');
  await other.screenshot({ path: `${artifactDir}/native-draft-conflict.png`, fullPage: true });
  await notice.getByRole('button', { name: 'Keep my version', exact: true }).click();
  await notice.getByRole('button', { name: 'Confirm use my version', exact: true }).click();
  await notice.waitFor({ state: 'detached', timeout: 60000 });
  assert.equal(await local.inputValue(), 'Draft saved in the first window.');
  assert.equal(
    (
      await page.evaluate(
        (id) =>
          window.__TAURI_INTERNALS__.invoke('host_request', {
            method: 'draft.get',
            params: { id },
          }),
        agent.id,
      )
    ).text,
    'Draft saved in the first window.',
  );
  const resolved = await page.evaluate(
    (id) =>
      window.__TAURI_INTERNALS__.invoke('host_request', { method: 'draft.get', params: { id } }),
    agent.id,
  );
  assert.equal(resolved.attachments[0].name, 'local-conflict.png');
  assert.equal(
    resolved.attachments[0].data,
    localPng.toString('base64'),
    'Local attachment bytes survive reconciliation',
  );
  await other.close();
  await page.reload();
  await page.locator('.tree-session').filter({ hasText: 'WrongStack engine proof' }).click();
  await page.locator(`[data-engine-session="${identity.sessionId}"]`).waitFor({ timeout: 60000 });
  await page
    .getByRole('button', { name: 'Remove attachment local-conflict.png', exact: true })
    .click();
  await main.fill('');
  await waitFor(
    async () =>
      (
        await page.evaluate(
          (id) =>
            window.__TAURI_INTERNALS__.invoke('host_request', {
              method: 'draft.get',
              params: { id },
            }),
          agent.id,
        )
      ).text === '' &&
      (
        await page.evaluate(
          (id) =>
            window.__TAURI_INTERNALS__.invoke('host_request', {
              method: 'draft.get',
              params: { id },
            }),
          agent.id,
        )
      ).attachments.length === 0,
    'Conflict fixture cleared',
    60000,
  );
  console.log(
    'PASS: two native windows preserve local edits, refuse stale writes and explicitly reload saved draft',
  );
}
