import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function exerciseNativeSettingsPolicy({ page, rpc, waitFor, artifactDir }) {
  let offset = 0;
  const command = async (type, payload = {}) => {
    const requestId = crypto.randomUUID();
    await rpc('profile.send', { message: { type, payload: { ...payload, requestId } } });
    const reply = await waitFor(
      async () => {
        const batch = await rpc('profile.events', { offset });
        offset = batch.offset;
        return batch.events.find(
          (e) =>
            e.payload?.requestId === requestId &&
            (e.type === 'prefs.updated' || e.type === 'key.operation_result'),
        )?.payload;
      },
      'Profile ' + type,
      45000,
    );
    if (reply.success === false || reply.error) throw Error(reply.error ?? reply.message);
    return reply;
  };
  const prefs = () => command('prefs.get');
  const start = await prefs();
  const nav = () => page.getByRole('navigation', { name: 'WrongStack settings sections' });
  const go = (name) => nav().getByRole('button', { name, exact: true }).click();
  const saved = async () => {
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'saved to your active profile' }).waitFor();
  };
  const open = () =>
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'WrongStack settings', exact: true })
      .click();
  const restore = {
    fallbackModels: start.fallbackModels ?? [],
    fallbackProfiles: start.fallbackProfiles ?? {},
    modelMatrix: start.modelMatrix ?? {},
    modelTiers: start.modelTiers ?? {},
    limits: start.limits ?? {},
    maxIterations: start.maxIterations,
  };
  await open();
  try {
    await page.getByLabel('Search WrongStack settings', { exact: true }).fill('cost');
    assert.equal(await nav().getByRole('button', { name: 'Cost tiers', exact: true }).count(), 1);
    assert.equal(
      await nav().getByRole('button', { name: 'Providers & models', exact: true }).count(),
      0,
    );
    await page.getByLabel('Search WrongStack settings', { exact: true }).fill('');
    await go('Fallbacks & agent defaults');
    const chain = page.getByRole('region', { name: 'Default fallback chain', exact: true });
    await chain.getByRole('button', { name: 'Add model', exact: true }).click();
    await page
      .getByLabel('Default fallback chain model 1', { exact: true })
      .fill('native-fixture/model-a');
    await chain.getByRole('button', { name: 'Add model', exact: true }).click();
    await page
      .getByLabel('Default fallback chain model 2', { exact: true })
      .fill('native-fixture/model-b');
    await page
      .getByRole('button', { name: 'Move Default fallback chain model 1 down', exact: true })
      .click();
    await page.getByLabel('New fallback profile', { exact: true }).fill('desktop-fast');
    await page.getByRole('button', { name: 'Create profile', exact: true }).click();
    const profile = page.getByRole('region', { name: 'desktop-fast chain', exact: true });
    await profile.getByRole('button', { name: 'Add model', exact: true }).click();
    await page
      .getByLabel('desktop-fast chain model 1', { exact: true })
      .fill('native-fixture/model-a');
    await saved();
    let actual = await prefs();
    assert.deepEqual(actual.fallbackModels, ['native-fixture/model-b', 'native-fixture/model-a']);
    assert.deepEqual(actual.fallbackProfiles['desktop-fast'], ['native-fixture/model-a']);
    await go('Cost tiers');
    await page.getByLabel('Enable cost tiers', { exact: true }).check();
    await page.getByLabel('New cost tier', { exact: true }).fill('fast');
    await page.getByRole('button', { name: 'Add tier', exact: true }).click();
    await page
      .getByLabel('fast tier fallback profile', { exact: true })
      .selectOption('desktop-fast');
    await page.getByLabel('fast Spend ceiling (USD)', { exact: true }).fill('0');
    await page.getByLabel('fast Iterations', { exact: true }).fill('8');
    await page.getByLabel('fast Tokens', { exact: true }).fill('2048');
    await page.getByLabel('Default cost tier', { exact: true }).selectOption('fast');
    await page.getByLabel('Tier route name', { exact: true }).fill('build');
    await page.getByLabel('Route to tier', { exact: true }).selectOption('fast');
    await page.getByRole('button', { name: 'Add tier route', exact: true }).click();
    await page.getByLabel('Leader tier switching', { exact: true }).selectOption('propose');
    await page.getByLabel('Leader maximum tier', { exact: true }).selectOption('fast');
    await page.getByLabel('Maximum context fill for switching', { exact: true }).fill('0.75');
    await saved();
    actual = await prefs();
    assert.equal(actual.modelTiers.levels.fast.maxCostUsd, 0);
    assert.equal(actual.modelTiers.routing.build, 'fast');
    assert.equal(actual.modelTiers.leader.maxContextFillForSwitch, 0.75);
    await page.screenshot({
      path: join(artifactDir, 'native-settings-cost-tiers.png'),
      fullPage: true,
    });
    await go('Model routing');
    await page.getByLabel('New model route', { exact: true }).fill('architect');
    await page.getByRole('button', { name: 'Add route', exact: true }).click();
    await page.getByLabel('architect model', { exact: true }).fill('native-fixture/model-a');
    await page
      .getByLabel('architect fallback profile', { exact: true })
      .selectOption('desktop-fast');
    await page.getByLabel('architect reasoning', { exact: true }).selectOption('on');
    await page.getByLabel('architect effort', { exact: true }).selectOption('high');
    await page.getByLabel('architect preserve reasoning', { exact: true }).selectOption('false');
    await saved();
    actual = await prefs();
    assert.deepEqual(actual.modelMatrix.architect.modelRuntime.reasoning, {
      mode: 'on',
      effort: 'high',
      preserve: false,
    });
    await page.screenshot({
      path: join(artifactDir, 'native-settings-model-routing.png'),
      fullPage: true,
    });
    await go('Resource limits');
    const history = page.getByLabel('Conversation history messages', { exact: true });
    await history.fill('19');
    assert.equal(
      await history.evaluate((e) => e.checkValidity()),
      false,
      'Shared engine lower bound is enforced',
    );
    await history.fill('64');
    await page.getByLabel('Response output tokens', { exact: true }).fill('2048');
    await page.getByLabel('Worker tool calls', { exact: true }).fill('10');
    await saved();
    assert.equal((await prefs()).limits.subagentDefaultBudget.maxToolCalls, 10);
    await history.fill('70');
    await go('Cost tiers');
    await go('Resource limits');
    assert.equal(await history.inputValue(), '70', 'Draft survives section navigation');
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    assert.equal(await history.inputValue(), '64');
    await history.fill('');
    await saved();
    assert.equal(
      Object.hasOwn((await prefs()).limits, 'historyMessages'),
      false,
      'Clearing restores inherited limit',
    );
    await page.setViewportSize({ width: 800, height: 640 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'Resource policies fit compact desktop',
    );
    await page.screenshot({
      path: join(artifactDir, 'native-settings-limits-compact.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1480, height: 960 });
    await go('Fallbacks & agent defaults');
    await page
      .getByLabel('desktop-fast chain model 1', { exact: true })
      .fill('native-fixture/local-edit');
    actual = await prefs();
    await command('prefs.update', {
      fallbackProfiles: {
        ...actual.fallbackProfiles,
        'external-profile': ['native-fixture/external'],
      },
    });
    await saved();
    actual = await prefs();
    assert.deepEqual(
      actual.fallbackProfiles['external-profile'],
      ['native-fixture/external'],
      'Independent concurrent profile survives',
    );
    assert.deepEqual(actual.fallbackProfiles['desktop-fast'], ['native-fixture/local-edit']);
    await page
      .getByLabel('desktop-fast chain model 1', { exact: true })
      .fill('native-fixture/draft');
    await command('prefs.update', {
      fallbackProfiles: { ...actual.fallbackProfiles, 'desktop-fast': ['native-fixture/remote'] },
    });
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'changed elsewhere' }).waitFor();
    assert.equal(
      await page.getByLabel('desktop-fast chain model 1', { exact: true }).inputValue(),
      'native-fixture/draft',
      'Conflict retains operator draft',
    );
    assert.deepEqual(
      (await prefs()).fallbackProfiles['desktop-fast'],
      ['native-fixture/remote'],
      'Conflicting value was not overwritten',
    );
    await page
      .getByRole('button', { name: 'Reload saved values (discard drafts)', exact: true })
      .click();
    await waitFor(
      async () =>
        (await page.getByLabel('desktop-fast chain model 1', { exact: true }).inputValue()) ===
        'native-fixture/remote',
      'Explicit settings reload',
    );
    await go('Execution & permissions');
    const iterations = page.getByLabel('Iteration budget', { exact: true });
    // A fresh profile is already unlimited. Save a finite budget first so zero tests a real edit.
    const finiteBudget = (await prefs()).maxIterations === 8 ? 9 : 8;
    await iterations.fill(String(finiteBudget));
    await saved();
    assert.equal((await prefs()).maxIterations, finiteBudget, 'Finite iteration budget persists');
    await iterations.fill('0');
    await saved();
    assert.equal((await prefs()).maxIterations, 0, 'Unlimited iterations persist');
  } catch (error) {
    await page.screenshot({
      path: join(artifactDir, 'native-settings-failure.png'),
      fullPage: true,
    });
    throw error;
  } finally {
    await command('prefs.update', restore);
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Mission control', exact: true })
      .click();
  }
  console.log(
    'PASS: native fallback chains/profiles, model routing/reasoning, cost tiers, inherited limits, navigation drafts, real concurrent merge/conflict and unlimited iterations without sessions',
  );
}
