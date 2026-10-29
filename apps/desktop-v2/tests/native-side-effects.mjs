import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function exerciseNativeSideEffects({
  page,
  waitFor,
  artifactDir,
  otherTitle,
  ownerTitle,
}) {
  const panel = () => page.getByRole('region', { name: 'Session side effects', exact: true });
  const open = async () => {
    await page
      .getByRole('navigation', { name: 'Agent workspace views' })
      .getByRole('button', { name: 'Tools', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Session tools', exact: true })
      .getByRole('button')
      .filter({ hasText: 'Side effects' })
      .click();
    await panel().waitFor();
  };
  await open();
  const effect = panel()
    .locator('.effects-records > button')
    .filter({ hasText: 'native-process-output-ready' });
  await effect.waitFor({ timeout: 30000 });
  assert.ok((await effect.innerText()).includes('launched (pid'));
  await effect.click();
  const detail = panel().getByRole('complementary', { name: 'Side-effect detail', exact: true });
  await detail.getByRole('heading', { name: 'Recorded input', exact: true }).waitFor();
  assert.ok((await detail.innerText()).includes('native-process-output-ready'));
  const assertPanelFits = async () => {
    assert.equal(
      await panel().evaluate((element) => element.scrollWidth > element.clientWidth),
      false,
    );
  };
  await assertPanelFits();
  await panel().getByLabel('Side-effect kind', { exact: true }).selectOption('network');
  await panel().getByRole('heading', { name: 'No matching side effects.', exact: true }).waitFor();
  assert.equal(
    await panel().getByRole('button', { name: 'Copy visible CSV', exact: true }).isDisabled(),
    true,
  );
  await panel().getByLabel('Side-effect kind', { exact: true }).selectOption('shell');
  await panel().getByLabel('Search side effects', { exact: true }).fill('not-the-record');
  await panel().getByRole('heading', { name: 'No matching side effects.', exact: true }).waitFor();
  await panel()
    .getByLabel('Search side effects', { exact: true })
    .fill('native-process-output-ready');
  await panel().getByLabel('Side-effect sort', { exact: true }).selectOption('oldest');
  await effect.waitFor();
  await page.evaluate(() => {
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    window.__nativeEffectsOriginalWrite = navigator.clipboard.writeText;
    navigator.clipboard.writeText = async (text) => {
      await write(text);
      window.__nativeEffectsCsv = text;
    };
  });
  try {
    await panel().getByRole('button', { name: 'Copy visible CSV', exact: true }).click();
    await panel()
      .getByRole('status')
      .filter({ hasText: 'copied as spreadsheet-safe CSV' })
      .waitFor();
    const csv = await page.evaluate(() => window.__nativeEffectsCsv);
    assert.ok(
      csv.includes('native-process-output-ready') &&
        csv.includes('"shell"') &&
        csv.includes('"tool_call_id"'),
    );
  } finally {
    await page.evaluate(() => {
      navigator.clipboard.writeText = window.__nativeEffectsOriginalWrite;
      delete window.__nativeEffectsOriginalWrite;
      delete window.__nativeEffectsCsv;
    });
  }
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: artifactDir });
    const previousFiles = new Set(await readdir(artifactDir));
    await panel().getByRole('button', { name: 'Download visible CSV', exact: true }).click();
    await waitFor(
      async () => {
        const file = (await readdir(artifactDir)).find(
          (file) => !previousFiles.has(file) && /^wrongstack-side-effects-.*\.csv$/.test(file),
        );
        if (!file) return null;
        const csv = await readFile(join(artifactDir, file), 'utf8');
        return csv.includes('native-process-output-ready') && csv.includes('"shell"');
      },
      'Actual native CSV download contains the visible recorded operation',
      15000,
    );
  } finally {
    await cdp.send('Page.setDownloadBehavior', { behavior: 'default' });
    await cdp.detach();
  }
  await page.screenshot({ path: join(artifactDir, 'native-side-effects.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 640 });
  await assertPanelFits();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-side-effects-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  const dark = page.getByRole('button', { name: 'Switch to dark mode', exact: true });
  if (await dark.count()) await dark.click();
  await page.screenshot({
    path: join(artifactDir, 'native-side-effects-dark.png'),
    fullPage: true,
  });
  await page.locator('.tree-session').filter({ hasText: otherTitle }).click();
  await open();
  await panel().getByRole('heading', { name: 'No recorded side effects.', exact: true }).waitFor();
  await page.locator('.tree-session').filter({ hasText: ownerTitle }).click();
  if (!(await panel().count())) await open();
  await panel()
    .locator('.effects-records > button')
    .filter({ hasText: 'native-process-output-ready' })
    .waitFor();
  // The same record is read back from the durable session journal, not the runtime window.
  await panel()
    .getByRole('combobox', { name: 'Side-effect source', exact: true })
    .selectOption('journal');
  await panel()
    .locator('.effects-records > button')
    .filter({ hasText: 'native-process-output-ready' })
    .waitFor();
  assert.ok(
    (await panel().locator('.effects-summary').innerText()).includes('recorded in the journal'),
    'The journal source is labelled as the journal',
  );
  await panel()
    .getByRole('combobox', { name: 'Side-effect source', exact: true })
    .selectOption('runtime');
  console.log(
    'PASS: actual approved tool side effect, input/outcome inspector, filters/sort, empty-session isolation, real clipboard CSV and native file download, journal-read records, compact and themed audit layout',
  );
}
