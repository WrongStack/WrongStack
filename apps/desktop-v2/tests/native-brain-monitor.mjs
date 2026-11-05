import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function exerciseNativeBrainMonitor({
  page,
  call,
  waitFor,
  artifactDir,
  configPath,
  providerFixture,
  open,
}) {
  const panel = page.getByRole('region', { name: 'Brain policy settings', exact: true });
  const completions = providerFixture.calls.length;
  assert.equal(
    await panel.getByLabel('Open trace record limit', { exact: true }).inputValue(),
    '777',
  );
  const values = {
    'Consecutive tool failures': '5',
    'Error-storm threshold': '7',
    'Error-storm window': '90',
    'Stall timeout': '0',
    'Stall check interval': '45',
    'File-churn threshold': '30',
    'File-churn window': '900',
    'Monitor signal cooldown': '1.234',
  };
  for (const [label, value] of Object.entries(values))
    await panel.getByLabel(label, { exact: true }).fill(value);
  await panel.getByLabel('Tool-failure signal', { exact: true }).selectOption('true');
  await panel.getByLabel('File-churn signal', { exact: true }).selectOption('false');
  await panel
    .getByLabel('File-edit tool names', { exact: true })
    .fill('write\ncustom_patch\nmcp_edit');
  const tracePath = join(dirname(configPath), 'native-replay-trace.jsonl');
  await panel.getByLabel('Replay trace path', { exact: true }).fill(tracePath);
  await panel.getByLabel('Open trace record limit', { exact: true }).fill('512');
  const initial = (await call('brain.config.get')).config;
  assert.equal(initial.trace.maxOpenRecords, 777, 'Draft trace capacity does not persist early');
  await call('brain.config.set', {
    patch: { monitor: { signals: { ...initial.monitor.signals, errorStorm: false } } },
  });
  const save = async () => {
    await panel.getByRole('button', { name: 'Save Brain policy', exact: true }).click();
    await panel
      .getByText('Brain policy saved and verified in this profile runtime.', { exact: true })
      .waitFor();
  };
  await save();
  const config = (await call('brain.config.get')).config;
  assert.deepEqual(config.monitor.signals, {
    toolFailureStreak: true,
    agentStall: false,
    errorStorm: false,
    fileChurn: false,
  });
  assert.equal(config.monitor.toolFailureStreak, 5);
  assert.equal(config.monitor.errorStormCount, 7);
  assert.equal(config.monitor.errorStormWindowMs, 90000);
  assert.equal(config.monitor.stallMs, 0);
  assert.equal(config.monitor.stallCheckIntervalMs, 45000);
  assert.equal(config.monitor.fileChurnThreshold, 30);
  assert.equal(config.monitor.fileChurnWindowMs, 900000);
  assert.equal(config.monitor.cooldownMs, 1234);
  assert.deepEqual(config.monitor.fileEditTools, ['write', 'custom_patch', 'mcp_edit']);
  assert.equal(config.trace.path, tracePath);
  assert.equal(config.trace.maxOpenRecords, 512);
  const disk = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(disk.brain.monitor.signals, config.monitor.signals);
  assert.equal(disk.brain.trace.path, tracePath);
  assert.equal(disk.brain.trace.maxOpenRecords, 512);
  await page.reload();
  await open();
  assert.equal(await panel.getByLabel('Agent-stall signal', { exact: true }).inputValue(), 'false');
  assert.equal(await panel.getByLabel('Error-storm signal', { exact: true }).inputValue(), 'false');
  assert.equal(
    await panel.getByLabel('Replay trace path', { exact: true }).inputValue(),
    tracePath,
  );
  await page.getByLabel('Search WrongStack settings', { exact: true }).fill('stall');
  await page
    .getByRole('navigation', { name: 'WrongStack settings sections', exact: true })
    .getByRole('button', { name: 'Brain policy', exact: true })
    .waitFor();
  await page.getByLabel('Search WrongStack settings', { exact: true }).fill('');
  await panel
    .getByRole('navigation', { name: 'Brain policy groups', exact: true })
    .getByRole('button', { name: 'Runtime monitor', exact: true })
    .click();
  assert.equal(
    await panel
      .getByRole('heading', { name: 'Runtime monitor', exact: true })
      .evaluate(
        (element) =>
          element.getBoundingClientRect().top >= 0 &&
          element.getBoundingClientRect().top < innerHeight,
      ),
    true,
  );
  const light = page.getByRole('button', { name: 'Switch to light mode', exact: true });
  if (await light.count()) await light.click();
  await page.screenshot({ path: join(artifactDir, 'native-brain-monitor.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 640 });
  await panel.getByLabel('Tool-failure signal', { exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-brain-monitor-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await page.screenshot({
    path: join(artifactDir, 'native-brain-monitor-dark.png'),
    fullPage: true,
  });
  await panel.getByLabel('Consecutive tool failures', { exact: true }).fill('9');
  await call('brain.config.set', { patch: { monitor: { toolFailureStreak: 10 } } });
  await panel.getByRole('button', { name: 'Save Brain policy', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'changed elsewhere' }).waitFor();
  assert.equal((await call('brain.config.get')).config.monitor.toolFailureStreak, 10);
  await panel
    .getByRole('button', { name: 'Reload saved Brain values (discard drafts)', exact: true })
    .click();
  await waitFor(
    async () =>
      (await panel.getByLabel('Consecutive tool failures', { exact: true }).inputValue()) === '10',
    'Monitor threshold conflict recovers live values',
  );
  await panel.getByLabel('Replay trace path', { exact: true }).fill('');
  await panel.getByLabel('File-edit tool names', { exact: true }).fill('');
  await save();
  const cleared = (await call('brain.config.get')).config;
  assert.equal(cleared.trace.path, undefined);
  assert.deepEqual(cleared.monitor.fileEditTools, []);
  await panel.getByLabel('Open trace record limit', { exact: true }).fill('0');
  await panel.getByRole('button', { name: 'Save Brain policy', exact: true }).click();
  assert.equal((await call('brain.config.get')).config.trace.maxOpenRecords, 512);
  await panel.getByRole('button', { name: 'Discard Brain changes', exact: true }).click();
  const reset = () =>
    panel.getByRole('button', { name: 'Use inherited monitor defaults', exact: true });
  await reset().click();
  assert.equal(
    await panel.getByLabel('Consecutive tool failures', { exact: true }).inputValue(),
    '3',
  );
  assert.equal(
    await panel.getByLabel('Consecutive tool failures', { exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    (await call('brain.config.get')).config.monitor.toolFailureStreak,
    10,
    'Reset is only a draft until explicit save',
  );
  await panel.getByRole('button', { name: 'Keep saved monitor overrides', exact: true }).click();
  assert.equal(
    await panel.getByLabel('Consecutive tool failures', { exact: true }).inputValue(),
    '10',
  );
  await reset().click();
  await call('brain.config.set', { patch: { monitor: { cooldownMs: 555 } } });
  await panel.getByRole('button', { name: 'Save Brain policy', exact: true }).click();
  await panel
    .getByRole('alert')
    .filter({ hasText: 'Monitor overrides changed elsewhere' })
    .waitFor();
  assert.equal((await call('brain.config.get')).config.monitor.cooldownMs, 555);
  await panel
    .getByRole('button', { name: 'Reload saved Brain values (discard drafts)', exact: true })
    .click();
  await waitFor(
    async () =>
      (await panel.getByLabel('Monitor signal cooldown', { exact: true }).inputValue()) === '0.555',
    'Monitor reset conflict reload',
  );
  const beforeReset = (await call('brain.config.get')).config;
  await reset().click();
  await panel.getByLabel('Open trace record limit', { exact: true }).fill('513');
  await save();
  const inherited = (await call('brain.config.get')).config;
  assert.deepEqual(inherited.monitor, {});
  assert.deepEqual(inherited.council, beforeReset.council);
  assert.equal(inherited.maxAutoRisk, beforeReset.maxAutoRisk);
  assert.equal(
    inherited.trace.maxOpenRecords,
    513,
    'Monitor reset merges an independent trace edit',
  );
  const inheritedDisk = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(
    Object.hasOwn(inheritedDisk.brain, 'monitor'),
    false,
    'Reset removes overrides rather than pinning current defaults',
  );
  await page.reload();
  await open();
  await panel
    .getByText('This profile inherits the engine monitor defaults.', { exact: true })
    .waitFor();
  assert.equal(
    await panel.getByLabel('Consecutive tool failures', { exact: true }).inputValue(),
    '3',
  );
  assert.equal(await reset().isDisabled(), true);
  await panel
    .getByRole('heading', { name: 'Runtime monitor', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifactDir, 'native-brain-monitor-inherited.png'),
    fullPage: true,
  });
  assert.equal(
    providerFixture.calls.length,
    completions,
    'Monitor/trace configuration invokes no model completions',
  );
  console.log(
    'PASS: monitor signal policies, trace path/capacity, reset preview/undo, stale-reset refusal, independent trace merge, actual monitor override removal and inherited reload without completions',
  );
}
