import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exerciseNativeBrainMonitor } from './native-brain-monitor.mjs';
import { exerciseNativeBrainTargets } from './native-brain-targets.mjs';

export async function exerciseNativeBrainPolicy({
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
    const response = await waitFor(
      async () => {
        const batch = await rpc('profile.events', { offset });
        offset = batch.offset;
        return batch.events.find((event) => event.payload?.requestId === requestId)?.payload;
      },
      `Native Brain ${type}`,
      45000,
    );
    if (response.error || response.success === false || response.persisted === false)
      throw Error(response.error ?? response.message);
    return response;
  };
  const nav = page.getByRole('navigation', { name: 'WrongStack settings sections', exact: true });
  const open = async () => {
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'WrongStack settings', exact: true })
      .click();
    await nav.getByRole('button', { name: 'Brain policy', exact: true }).click();
    await page
      .getByRole('region', { name: 'Brain policy settings', exact: true })
      .getByLabel('Automatic risk ceiling', { exact: true })
      .waitFor();
  };
  await open();
  await page.getByLabel('Search WrongStack settings', { exact: true }).fill('decision cache');
  await nav.getByRole('button', { name: 'Brain policy', exact: true }).waitFor();
  await page.getByLabel('Search WrongStack settings', { exact: true }).fill('');
  const panel = page.getByRole('region', { name: 'Brain policy settings', exact: true });
  const initial = (await call('brain.config.get')).config;
  await panel.getByLabel('Automatic risk ceiling', { exact: true }).selectOption('medium');
  await panel.getByLabel('Model decision timeout', { exact: true }).fill('');
  await panel.getByLabel('Reuse cached decisions', { exact: true }).setChecked(true);
  await panel.getByLabel('Decision cache lifetime', { exact: true }).fill('600');
  await panel.getByLabel('Decision cache capacity', { exact: true }).fill('512');
  await panel.getByLabel('Low-risk fast path', { exact: true }).setChecked(false);
  await panel.getByLabel('Minimum reported confidence', { exact: true }).fill('0.7');
  await panel.getByLabel('Monitor response', { exact: true }).selectOption('observe');
  await panel.getByLabel('Panel diversity', { exact: true }).selectOption('provider');
  await panel.getByLabel('Failure denial threshold', { exact: true }).fill('0');
  await panel.getByLabel('Replay trace content', { exact: true }).selectOption('redacted');
  assert.equal(
    (await call('brain.config.get')).config.maxAutoRisk,
    initial.maxAutoRisk,
    'Draft changes never apply before Save',
  );
  await nav.getByRole('button', { name: 'Fleet & companions', exact: true }).click();
  await nav.getByRole('button', { name: 'Brain policy', exact: true }).click();
  assert.equal(
    await panel.getByLabel('Automatic risk ceiling', { exact: true }).inputValue(),
    'medium',
  );
  await panel.getByRole('button', { name: 'Save Brain policy', exact: true }).click();
  await panel
    .getByText('Brain policy saved and verified in this profile runtime.', { exact: true })
    .waitFor();
  const config = (await call('brain.config.get')).config;
  assert.equal(config.maxAutoRisk, 'medium');
  assert.equal(config.cache.enabled, true);
  assert.equal(config.cache.ttlMs, 600000);
  assert.equal(config.cache.maxEntries, 512);
  assert.equal(config.heuristics.lowRiskAutoAnswer, false);
  assert.equal(config.llm.minConfidence, 0.7);
  assert.equal(config.monitor.policy, 'observe');
  assert.equal(config.monitor.cooldownMs, 123456, 'Untouched monitor fields survive policy edits');
  assert.equal(config.council.distinctness, 'provider');
  assert.equal(config.ledger.autoDenyAfterFailures, 0);
  assert.equal(config.trace.content, 'redacted');
  const disk = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(disk.brain.maxAutoRisk, 'medium');
  assert.equal(
    disk.brain.decisionTimeoutMs,
    undefined,
    'Empty optional timeout clears the override',
  );
  assert.equal(disk.brain.cache.ttlMs, 600000);
  assert.equal(disk.brain.monitor.cooldownMs, 123456);
  assert.equal(disk.brain.rules[0].id, 'native-brain-rule');
  await panel
    .getByRole('region', { name: 'Configured Brain rules', exact: true })
    .getByText('native fixture decision', { exact: true })
    .waitFor();
  await panel.getByLabel('Automatic risk ceiling', { exact: true }).selectOption('high');
  await call('brain.config.set', { patch: { maxAutoRisk: 'off' } });
  await panel.getByRole('button', { name: 'Save Brain policy', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'changed elsewhere' }).waitFor();
  assert.equal((await call('brain.config.get')).config.maxAutoRisk, 'off');
  await panel
    .getByRole('button', { name: 'Reload saved Brain values (discard drafts)', exact: true })
    .click();
  await waitFor(
    async () =>
      (await panel.getByLabel('Automatic risk ceiling', { exact: true }).inputValue()) === 'off',
    'Brain stale editor recovers saved values',
  );
  await panel.getByLabel('Automatic risk ceiling', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifactDir, 'native-brain-policy.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 640 });
  await panel.getByLabel('Automatic risk ceiling', { exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-brain-policy-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  const dark = page.getByRole('button', { name: 'Switch to dark mode', exact: true });
  if (await dark.count()) await dark.click();
  await page.screenshot({
    path: join(artifactDir, 'native-brain-policy-dark.png'),
    fullPage: true,
  });
  await page.reload();
  await open();
  assert.equal(
    await panel.getByLabel('Automatic risk ceiling', { exact: true }).inputValue(),
    'off',
  );
  assert.equal(
    await panel.getByLabel('Decision cache capacity', { exact: true }).inputValue(),
    '512',
  );
  const snapshot = await rpc('snapshot');
  assert.equal(snapshot.projects.length, 0);
  assert.equal(snapshot.sessions.length, 0);
  await exerciseNativeBrainTargets({
    page,
    call,
    waitFor,
    artifactDir,
    configPath,
    providerFixture,
    open,
  });
  await exerciseNativeBrainMonitor({
    page,
    call,
    waitFor,
    artifactDir,
    configPath,
    providerFixture,
    open,
  });
  console.log(
    'PASS: correlated live Brain settings, explicit multi-policy save/disk readback, optional override reset, retained nested settings/rules, parked drafts, stale-write refusal, reload, themes and zero-project/session settings',
  );
}
