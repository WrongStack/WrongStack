import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureModel } from './local-provider.mjs';

export async function exerciseNativeRefinementPolicy({
  page,
  rpc,
  waitFor,
  artifactDir,
  configPath,
  providerFixture,
}) {
  let offset = 0;
  const call = async (type, payload = {}) => {
    const requestId = crypto.randomUUID();
    await rpc('profile.send', { message: { type, payload: { ...payload, requestId } } });
    const result = await waitFor(
      async () => {
        const batch = await rpc('profile.events', { offset });
        offset = batch.offset;
        return batch.events.find((event) => event.payload?.requestId === requestId)?.payload;
      },
      `Refiner policy ${type}`,
      45000,
    );
    if (result.error || result.success === false) throw Error(result.error ?? result.message);
    return result;
  };
  const before = await call('prefs.get');
  await call('prefs.update', {
    fallbackProfiles: {
      ...before.fallbackProfiles,
      'native-refiner': ['desktop-local/profile/refiner'],
    },
  });
  await page.reload();
  const nav = page.getByRole('navigation', { name: 'WrongStack settings sections', exact: true });
  const screen = page.getByRole('region', { name: 'WrongStack settings', exact: true });
  const open = async () => {
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'WrongStack settings', exact: true })
      .click();
    await nav.getByRole('button', { name: 'Prompt refinement', exact: true }).click();
    await screen.getByRole('heading', { name: 'Refinement behavior', exact: true }).waitFor();
  };
  await open();
  const policy = screen.getByRole('region', { name: 'Prompt refinement policy', exact: true });
  // One provider/model picker holds the explicit refiner reference.
  const refiner = policy.getByRole('combobox', { name: 'Refiner model', exact: true });
  await refiner.fill('explicit/refiner');
  await refiner.press('Enter');
  await policy.getByLabel('Named refiner profile', { exact: true }).selectOption('native-refiner');
  await policy
    .getByLabel('Preferred refinement language', { exact: true })
    .selectOption('original');
  await policy
    .getByRole('checkbox', { name: 'Review refinement on submit', exact: true })
    .uncheck();
  await policy
    .getByLabel('Refiner sample prompt', { exact: true })
    .fill('[native-refiner-settings] Clarify this task.');
  assert.equal(
    await policy
      .getByRole('button', { name: 'Preview with saved refiner', exact: true })
      .isDisabled(),
    true,
  );
  assert.equal((await call('prefs.get')).refinerFallbackProfile, '');
  const save = async () => {
    await screen.getByRole('button', { name: 'Save settings', exact: true }).click();
    await screen
      .getByText('WrongStack settings saved to your active profile.', { exact: true })
      .waitFor();
  };
  await save();
  const saved = await call('prefs.get');
  assert.equal(saved.refinerProvider, 'desktop-local');
  assert.equal(saved.refinerModel, 'explicit/refiner');
  assert.equal(saved.refinerFallbackProfile, 'native-refiner');
  assert.equal(saved.enhanceEnabled, false);
  assert.equal(saved.enhanceLanguage, 'original');
  const disk = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(disk.autonomy.refinerFallbackProfile, 'native-refiner');
  assert.equal(disk.autonomy.refinerModel, 'explicit/refiner');
  assert.equal(disk.autonomy.enhance, false);
  await nav.getByRole('button', { name: 'Fallbacks & agent defaults', exact: true }).click();
  assert.equal(
    await screen
      .getByRole('button', { name: 'Remove profile native-refiner', exact: true })
      .isDisabled(),
    true,
  );
  await nav.getByRole('button', { name: 'Prompt refinement', exact: true }).click();
  assert.equal(
    providerFixture.calls.filter((call) => call.refiner).length,
    0,
    'Saving settings performs no refinement request',
  );
  await policy
    .getByLabel('Refiner sample prompt', { exact: true })
    .fill('[native-refiner-settings] Clarify this task.');
  await policy.getByRole('button', { name: 'Preview with saved refiner', exact: true }).click();
  const preview = policy.getByRole('region', { name: 'Saved refiner preview', exact: true });
  await preview.getByText('Used desktop-local / profile/refiner', { exact: true }).waitFor();
  assert.ok(
    providerFixture.calls.some((call) => call.refiner && call.model === 'profile/refiner'),
    'Named refiner profile has real routing precedence',
  );
  await policy
    .getByRole('heading', { name: 'Try the saved refiner', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifactDir, 'native-refinement-policy.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(
    await policy.evaluate((element) => element.scrollWidth > element.clientWidth),
    false,
  );
  await page.screenshot({
    path: join(artifactDir, 'native-refinement-policy-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  const dark = page.getByRole('button', { name: 'Switch to dark mode', exact: true });
  if (await dark.count()) await dark.click();
  await page.screenshot({
    path: join(artifactDir, 'native-refinement-policy-dark.png'),
    fullPage: true,
  });
  await policy.getByLabel('Named refiner profile', { exact: true }).selectOption('');
  await refiner.fill('local-draft');
  await nav.getByRole('button', { name: 'Context & reasoning', exact: true }).click();
  await nav.getByRole('button', { name: 'Prompt refinement', exact: true }).click();
  assert.equal(await refiner.inputValue(), 'local-draft');
  await call('prefs.update', { refinerProvider: 'other-provider' });
  await screen.getByRole('button', { name: 'Save settings', exact: true }).click();
  await screen.getByRole('alert').filter({ hasText: 'routing changed elsewhere' }).waitFor();
  assert.equal((await call('prefs.get')).refinerModel, 'explicit/refiner');
  await screen
    .getByRole('button', { name: 'Reload saved values (discard drafts)', exact: true })
    .click();
  await waitFor(
    async () => (await refiner.inputValue()) === 'other-provider/explicit/refiner',
    'Refiner route conflict reload',
  );
  await policy.getByLabel('Named refiner profile', { exact: true }).selectOption('');
  await refiner.fill('');
  await policy.getByLabel('Preferred refinement language', { exact: true }).selectOption('english');
  await policy.getByRole('checkbox', { name: 'Review refinement on submit', exact: true }).check();
  await save();
  await policy
    .getByLabel('Refiner sample prompt', { exact: true })
    .fill('[native-refiner-settings] Inherit the runtime.');
  await policy.getByRole('button', { name: 'Preview with saved refiner', exact: true }).click();
  await preview.getByText(`Used desktop-local / ${fixtureModel}`, { exact: true }).waitFor();
  await page.reload();
  await open();
  assert.equal(await policy.getByLabel('Named refiner profile', { exact: true }).inputValue(), '');
  assert.equal(
    await policy.getByLabel('Preferred refinement language', { exact: true }).inputValue(),
    'english',
  );
  const snapshot = await rpc('snapshot');
  assert.equal(snapshot.projects.length, 0);
  assert.equal(snapshot.sessions.length, 0);
  assert.ok(
    providerFixture.calls.every((call) => call.refiner),
    'Sample previews never submit a conversation message',
  );
  console.log(
    'PASS: saved refiner catalog/route/profile/language, referenced-profile guard, explicit actual-model preview, stale-route refusal, runtime inheritance, disk/reload and no conversation submission',
  );
}
