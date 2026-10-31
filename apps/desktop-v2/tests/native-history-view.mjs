import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function exerciseNativeHistoryView({
  page,
  open,
  project,
  otherProject,
  store,
  call,
  oldest,
  needle,
  waitFor,
  artifactDir,
}) {
  const screen = page.getByRole('region', { name: 'Project session history', exact: true });
  const invokeForm = (method, params) =>
    page.evaluate(
      ({ method, params }) => window.__TAURI_INTERNALS__.invoke('host_request', { method, params }),
      { method, params },
    );
  const params = { projectId: project.id, formKey: 'history-view' };
  const saved = () => invokeForm('form-draft.get', params);
  await screen
    .getByLabel('Search project session summaries', { exact: true })
    .fill('Paged archive renamed');
  await screen.getByLabel('History provider', { exact: true }).selectOption('paging-fixture');
  await screen.getByLabel('History outcome', { exact: true }).selectOption('error');
  await screen.getByLabel('Include empty journals', { exact: true }).check();
  await waitFor(async () => {
    const view = (await saved()).value?.view;
    return (
      view?.selectedId === oldest &&
      view.query === 'Paged archive renamed' &&
      view.pageSize === 200 &&
      view.provider === 'paging-fixture' &&
      view.outcome === 'error' &&
      view.includeEmpty
    );
  }, 'Native project history view saved');
  const before = (await saved()).value.view;
  assert.equal(before.offset, undefined);
  assert.equal(before.revision, undefined);
  const added = await store.create({
    id: '2026-01-01/sess_native_view_new_member',
    title: '',
    provider: 'paging-fixture',
    model: 'paging-fixture',
  });
  try {
    await added.append({
      type: 'message_appended',
      version: 1,
      ts: new Date().toISOString(),
      message: { role: 'user', content: 'Catalog reordered before restoring the saved view' },
    });
  } finally {
    await added.close();
  }
  const expected = await call('sessions.list', { catalogPage: { limit: 200, anchorId: oldest } });
  await page.reload();
  await open();
  await screen.getByRole('heading', { name: 'Paged archive renamed', exact: true }).waitFor();
  assert.equal(
    await screen.getByLabel('Search project session summaries', { exact: true }).inputValue(),
    'Paged archive renamed',
  );
  assert.equal(
    await screen.getByLabel('History provider', { exact: true }).inputValue(),
    'paging-fixture',
  );
  assert.equal(await screen.getByLabel('History outcome', { exact: true }).inputValue(), 'error');
  assert.equal(await screen.getByLabel('History page size', { exact: true }).inputValue(), '200');
  assert.equal(
    await screen.getByLabel('Include empty journals', { exact: true }).isChecked(),
    true,
  );
  await waitFor(
    async () =>
      (await screen.locator('.history-catalog-status > span').innerText()).includes(
        expected.catalogPage.offset + 1 + '–',
      ),
    'Exact-ID page restored after catalog reordering',
  );
  await screen
    .getByRole('region', { name: 'Recorded session transcript', exact: true })
    .getByText(needle, { exact: true })
    .waitFor();
  await open(otherProject);
  assert.equal(
    await screen.getByLabel('Search project session summaries', { exact: true }).inputValue(),
    '',
  );
  assert.equal(await screen.getByLabel('History provider', { exact: true }).inputValue(), '');
  assert.equal(await screen.getByLabel('History page size', { exact: true }).inputValue(), '100');
  await open();
  await screen.getByRole('heading', { name: 'Paged archive renamed', exact: true }).waitFor();
  await screen.getByLabel('History outcome', { exact: true }).selectOption('');
  await screen.getByRole('button', { name: 'Open history ' + oldest, exact: true }).waitFor();
  await screen
    .getByRole('heading', { name: 'Session history', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifactDir, 'native-history-restored-view.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-history-restored-view-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await waitFor(
    async () => (await saved()).value.view.outcome === '',
    'Updated history filter saved',
  );
  const stale = await saved();
  await invokeForm('form-draft.save', {
    ...params,
    expectedRevision: stale.revision,
    value: {
      version: 1,
      view: {
        ...stale.value.view,
        selectedId: 'missing-native-history-record',
        provider: 'remembered-provider-not-on-page',
      },
    },
  });
  await page.reload();
  await open();
  await screen
    .getByRole('status')
    .filter({ hasText: 'remembered conversation is no longer' })
    .waitFor();
  assert.equal(
    await screen.getByLabel('History provider', { exact: true }).inputValue(),
    'remembered-provider-not-on-page',
  );
  const missingProviderOption = screen
    .getByLabel('History provider', { exact: true })
    .locator('option[value="remembered-provider-not-on-page"]');
  await missingProviderOption.waitFor({ state: 'attached' });
  assert.equal(
    await missingProviderOption.innerText(),
    'remembered-provider-not-on-page (not on this page)',
  );
  await waitFor(
    async () => (await saved()).value.view.selectedId === '',
    'Missing saved selection cleared explicitly',
  );
  assert.equal(await screen.locator('.history-selection').count(), 0);
  await screen.getByLabel('History provider', { exact: true }).selectOption('');
  await screen.getByLabel('Search project session summaries', { exact: true }).fill('');
  await screen.getByRole('button', { name: 'Next history page', exact: true }).click();
  const range = screen.locator('.history-catalog-status > span');
  await waitFor(
    async () => (await range.innerText()).includes('201–400 of'),
    'Second page without selection',
  );
  const firstId = (
    await screen.locator('.history-catalog > button').first().getAttribute('aria-label')
  ).slice('Open history '.length);
  await waitFor(async () => {
    const view = (await saved()).value.view;
    return (
      view.selectedId === '' &&
      view.anchorId === firstId &&
      view.query === '' &&
      view.provider === ''
    );
  }, 'Unselected page anchor saved');
  await page.reload();
  await open();
  await waitFor(
    async () => (await range.innerText()).includes('201–400 of'),
    'Unselected page restored by exact first-row anchor',
  );
  assert.equal(await screen.locator('.history-selection').count(), 0);
  console.log(
    'PASS: native per-project history filters, page size and selection recover after renderer reload and catalog reordering; project isolation, missing-record fallback, unavailable provider filter and unselected-page recovery without stale offsets',
  );
}
