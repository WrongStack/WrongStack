import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureModel } from './local-provider.mjs';

export async function exerciseNativeBrainTargets({
  page,
  call,
  waitFor,
  artifactDir,
  configPath,
  providerFixture,
  open,
}) {
  const panel = page.getByRole('region', { name: 'Brain policy settings', exact: true });
  const editor = panel.getByRole('region', {
    name: 'Brain models and council editor',
    exact: true,
  });
  const completions = providerFixture.calls.length;
  // Each target is one provider/model picker: typing the reference commits it; Enter closes.
  const reference = (label) =>
    editor.getByRole('combobox', { name: `${label} model`, exact: true });
  const choose = async (label) => {
    await reference(label).fill(`desktop-local/${fixtureModel}`);
    await reference(label).press('Enter');
  };
  const save = async () => {
    await panel.getByRole('button', { name: 'Save Brain policy', exact: true }).click();
    await panel
      .getByText('Brain policy saved and verified in this profile runtime.', { exact: true })
      .waitFor();
  };
  await editor.getByRole('button', { name: 'Add Brain pool model', exact: true }).click();
  await choose('Brain pool model 1');
  await editor.getByRole('button', { name: 'Add Brain pool model', exact: true }).click();
  await reference('Brain pool model 2').fill('desktop-local/custom/second');
  await editor.getByRole('button', { name: 'Move Brain pool model 2 up', exact: true }).click();
  await editor.getByLabel('Brain pool strategy', { exact: true }).selectOption('round-robin');
  await editor.getByRole('button', { name: 'Add council voter', exact: true }).click();
  await choose('Brain voter 1');
  await editor.getByLabel('Brain voter 1 lens', { exact: true }).fill('security');
  await editor.getByLabel('Brain voter 1 weight', { exact: true }).fill('2.5');
  await editor.getByLabel('Brain voter 1 veto', { exact: true }).selectOption('no');
  await editor.getByRole('button', { name: 'Add council voter', exact: true }).click();
  await reference('Brain voter 2').fill('custom/second');
  await editor.getByRole('button', { name: 'Add council voter', exact: true }).click();
  await editor.getByRole('button', { name: 'Remove Brain voter 3', exact: true }).click();
  await choose('Council judge');
  const addSeat = editor.getByRole('button', { name: 'Add seat default', exact: true });
  await addSeat.click();
  await editor.getByLabel('Brain seat default 1 lens', { exact: true }).fill('skeptic');
  await editor.getByLabel('Brain seat default 1 veto', { exact: true }).selectOption('yes');
  await addSeat.click();
  await editor.getByLabel('Brain seat default 2 lens', { exact: true }).fill('security');
  await editor.getByLabel('Brain seat default 2 veto', { exact: true }).selectOption('no');
  await editor.getByRole('button', { name: 'Move Brain seat default 2 up', exact: true }).click();
  await addSeat.click();
  await editor
    .getByLabel('Brain seat default 3 lens', { exact: true })
    .fill('custom decision lens');
  await addSeat.click();
  await editor.getByRole('button', { name: 'Remove Brain seat default 4', exact: true }).click();
  await panel.getByLabel('Council quorum', { exact: true }).fill('0.75');
  assert.equal(
    (await call('brain.config.get')).config.models.length,
    0,
    'Model drafts do not apply before Save',
  );
  const nav = page.getByRole('navigation', { name: 'WrongStack settings sections', exact: true });
  await nav.getByRole('button', { name: 'Fleet & companions', exact: true }).click();
  await nav.getByRole('button', { name: 'Brain policy', exact: true }).click();
  assert.equal(await reference('Brain pool model 1').inputValue(), 'desktop-local/custom/second');
  await save();
  const config = (await call('brain.config.get')).config;
  assert.deepEqual(config.models, [
    { provider: 'desktop-local', model: 'custom/second' },
    { provider: 'desktop-local', model: fixtureModel },
  ]);
  assert.equal(config.strategy, 'round-robin');
  assert.deepEqual(config.council.seats, [
    { persona: 'security', veto: false },
    { persona: 'skeptic', veto: true },
    { persona: 'custom decision lens' },
  ]);
  assert.deepEqual(config.council.voters, [
    {
      provider: 'desktop-local',
      model: fixtureModel,
      persona: 'security',
      weight: 2.5,
      veto: false,
    },
    { model: 'custom/second' },
  ]);
  assert.deepEqual(config.council.judge, { provider: 'desktop-local', model: fixtureModel });
  assert.equal(config.council.quorum, 0.75, 'Scalar and target council edits merge in one patch');
  const disk = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(disk.brain.models, [
    'desktop-local/custom/second',
    `desktop-local/${fixtureModel}`,
  ]);
  assert.deepEqual(disk.brain.council.voters, config.council.voters);
  assert.deepEqual(disk.brain.council.seats, config.council.seats);
  assert.equal(disk.brain.council.judge, `desktop-local/${fixtureModel}`);
  assert.equal(disk.brain.council.voters[0].veto, false);
  assert.equal(Object.hasOwn(disk.brain.council.voters[1], 'veto'), false);
  await page.reload();
  await open();
  assert.equal(
    await editor.getByLabel('Brain seat default 1 veto', { exact: true }).inputValue(),
    'no',
  );
  assert.equal(
    await editor.getByLabel('Brain seat default 2 veto', { exact: true }).inputValue(),
    'yes',
  );
  assert.equal(
    await editor.getByLabel('Brain seat default 3 veto', { exact: true }).inputValue(),
    'default',
  );
  await editor
    .getByRole('heading', { name: 'Seat defaults', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifactDir, 'native-brain-seat-defaults.png'),
    fullPage: true,
  });
  assert.equal(await editor.getByLabel('Brain voter 1 veto', { exact: true }).inputValue(), 'no');
  assert.equal(
    await editor.getByLabel('Brain voter 2 veto', { exact: true }).inputValue(),
    'default',
  );
  await editor
    .getByRole('heading', { name: 'Decision model pool', exact: true })
    .scrollIntoViewIfNeeded();
  const light = page.getByRole('button', { name: 'Switch to light mode', exact: true });
  if (await light.count()) await light.click();
  await page.screenshot({ path: join(artifactDir, 'native-brain-targets.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 640 });
  await editor.getByLabel('Brain seat default 1 lens', { exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-brain-seat-defaults-compact.png'),
    fullPage: true,
  });
  await editor.getByLabel('Brain pool model 1 model ID', { exact: true }).scrollIntoViewIfNeeded();
  assert.equal(
    await editor.evaluate((element) => element.scrollWidth > element.clientWidth),
    false,
  );
  await page.screenshot({
    path: join(artifactDir, 'native-brain-targets-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await page.screenshot({
    path: join(artifactDir, 'native-brain-targets-dark.png'),
    fullPage: true,
  });
  await editor.getByLabel('Brain pool model 1 model ID', { exact: true }).fill('local-draft');
  await call('brain.config.set', {
    patch: { models: [{ provider: 'desktop-local', model: 'remote-model' }] },
  });
  await panel.getByRole('button', { name: 'Save Brain policy', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'models changed elsewhere' }).waitFor();
  assert.equal((await call('brain.config.get')).config.models[0].model, 'remote-model');
  await panel
    .getByRole('button', { name: 'Reload saved Brain values (discard drafts)', exact: true })
    .click();
  await waitFor(
    async () =>
      (await editor.getByLabel('Brain pool model 1 model ID', { exact: true }).inputValue()) ===
      'remote-model',
    'Target conflict reload observes actual model pool',
  );
  await editor.getByLabel('Brain seat default 1 lens', { exact: true }).fill('local lens');
  await call('brain.config.set', {
    patch: { council: { seats: [{ persona: 'executor', veto: false }] } },
  });
  await panel.getByRole('button', { name: 'Save Brain policy', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'seats changed elsewhere' }).waitFor();
  assert.deepEqual((await call('brain.config.get')).config.council.seats, [
    { persona: 'executor', veto: false },
  ]);
  assert.equal(
    await editor.getByLabel('Brain seat default 1 lens', { exact: true }).inputValue(),
    'local lens',
  );
  await panel
    .getByRole('button', { name: 'Reload saved Brain values (discard drafts)', exact: true })
    .click();
  await waitFor(
    async () =>
      (await editor.getByLabel('Brain seat default 1 lens', { exact: true }).inputValue()) ===
      'executor',
    'Seat conflict reload observes saved rotation',
  );
  await editor.getByRole('button', { name: 'Use built-in seat defaults', exact: true }).click();
  await editor.getByRole('button', { name: 'Use inherited model selection', exact: true }).click();
  await editor.getByRole('button', { name: 'Use pool-derived council seats', exact: true }).click();
  await editor.getByRole('button', { name: 'Use derived judge', exact: true }).click();
  await save();
  const inherited = (await call('brain.config.get')).config;
  assert.deepEqual(inherited.models, []);
  assert.deepEqual(inherited.council.voters, []);
  assert.deepEqual(inherited.council.seats, []);
  assert.equal(
    Object.hasOwn(JSON.parse(await readFile(configPath, 'utf8')).brain.council, 'seats'),
    false,
  );
  assert.equal(inherited.council.judge, undefined);
  await editor.getByRole('button', { name: 'Add council voter', exact: true }).click();
  await panel.getByRole('button', { name: 'Save Brain policy', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'needs a model ID' }).waitFor();
  assert.deepEqual((await call('brain.config.get')).config.council.voters, []);
  await panel.getByRole('button', { name: 'Discard Brain changes', exact: true }).click();
  await addSeat.click();
  await panel.getByRole('button', { name: 'Save Brain policy', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'needs a decision lens' }).waitFor();
  assert.deepEqual((await call('brain.config.get')).config.council.seats, []);
  await panel.getByRole('button', { name: 'Discard Brain changes', exact: true }).click();
  assert.equal(
    providerFixture.calls.length,
    completions,
    'Settings perform no model completion requests',
  );
  console.log(
    'PASS: saved model catalog, ordered pool/strategy, weighted voters, independent seat rotation and tri-state veto, judge, merged quorum, disk/reload, stale pool and seat refusal, target resets and empty-row refusal without model completions',
  );
}
