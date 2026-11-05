import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function exerciseNativeModelVisibility({
  page,
  call,
  providerId,
  configPath,
  artifactDir,
}) {
  const before = await call('prefs.get');
  const keys = [
    'disabledModels',
    'disabledProviders',
    'favoriteModels',
    'fallbackModels',
    'fallbackProfiles',
  ];
  const original = Object.fromEntries(
    keys.map((key) => [key, before[key] ?? (key === 'fallbackProfiles' ? {} : [])]),
  );
  const ref = `${providerId}/baseline`,
    other = 'other-provider/baseline';
  const main = page.getByRole('navigation', { name: 'Main navigation' });
  const open = async () => {
    await main.getByRole('button', { name: 'Projects', exact: true }).click();
    await main.getByRole('button', { name: 'WrongStack settings', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'WrongStack settings sections' })
      .getByRole('button', { name: 'Model visibility', exact: true })
      .click();
    await page
      .getByRole('combobox', { name: 'Visibility provider', exact: true })
      .selectOption(providerId);
  };
  const save = async () => {
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page
      .getByText('WrongStack settings saved to your active profile.', { exact: true })
      .waitFor();
  };
  try {
    await call('prefs.update', {
      disabledProviders: [],
      disabledModels: [other],
      favoriteModels: [ref, other],
      fallbackModels: [ref, other],
      fallbackProfiles: { visibility: [ref, other] },
    });
    await open();
    let card = page.getByRole('article', { name: 'Model visibility baseline', exact: true });
    await card.getByRole('button', { name: 'Disable model', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Keep current visibility', exact: true })
      .click();
    assert.deepEqual((await call('prefs.get')).disabledModels, [other]);
    await card.getByRole('button', { name: 'Disable model', exact: true }).click();
    await page.getByRole('dialog').getByText(`visibility: ${ref}`, { exact: false }).waitFor();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Apply to settings draft', exact: true })
      .click();
    await card.getByText('Disabled', { exact: true }).waitFor();
    assert.ok(
      (await call('provider.models', { providerId })).models.some(
        (model) => model.id === 'baseline',
      ),
      'Draft edits have not changed the live catalog',
    );
    await save();
    const stored = await call('prefs.get');
    assert.deepEqual(stored.disabledModels, [other, ref]);
    assert.deepEqual(stored.favoriteModels, [other]);
    assert.deepEqual(stored.fallbackModels, [other]);
    assert.deepEqual(stored.fallbackProfiles.visibility, [other]);
    assert.equal(
      (await call('provider.models', { providerId })).models.some(
        (model) => model.id === 'baseline',
      ),
      false,
    );
    assert.ok(
      (await call('provider.models', { providerId, includeDisabled: true })).models.some(
        (model) => model.id === 'baseline',
      ),
    );
    assert.ok(JSON.parse(await readFile(configPath, 'utf8')).disabledModels.includes(ref));
    await open();
    card = page.getByRole('article', { name: 'Model visibility baseline', exact: true });
    await card.getByText('Disabled', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'Enable model', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Apply to settings draft', exact: true })
      .click();
    await call('prefs.update', { disabledModels: [other, ref, 'peer/keep'] });
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'changed elsewhere' }).waitFor();
    assert.deepEqual((await call('prefs.get')).disabledModels, [other, ref, 'peer/keep']);
    await page
      .getByRole('button', { name: 'Reload saved values (discard drafts)', exact: true })
      .click();
    await page
      .getByRole('combobox', { name: 'Visibility provider', exact: true })
      .selectOption(providerId);
    card = page.getByRole('article', { name: 'Model visibility baseline', exact: true });
    await card.getByRole('button', { name: 'Enable model', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Apply to settings draft', exact: true })
      .click();
    await save();
    assert.deepEqual((await call('prefs.get')).disabledModels, [other, 'peer/keep']);
    await call('prefs.update', {
      favoriteModels: [ref, other],
      fallbackModels: [ref, other],
      fallbackProfiles: { visibility: [ref, other] },
    });
    await open();
    const providerControl = page.getByRole('region', { name: 'Provider visibility', exact: true });
    const savedProvider = () =>
      call('providers.saved').then((reply) =>
        reply.providers.find((item) => item.id === providerId),
      );
    const connectionBefore = await savedProvider();
    await providerControl.getByRole('button', { name: 'Disable provider', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Keep provider unchanged', exact: true })
      .click();
    assert.deepEqual((await call('prefs.get')).disabledProviders, []);
    const toggleProvider = async (disable) => {
      await providerControl
        .getByRole('button', {
          name: disable ? 'Disable provider' : 'Enable provider',
          exact: true,
        })
        .click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Apply provider change to draft', exact: true })
        .click();
    };
    await toggleProvider(true);
    assert.deepEqual((await call('prefs.get')).disabledProviders, []);
    await save();
    let policy = await call('prefs.get');
    assert.deepEqual(policy.disabledProviders, [providerId]);
    assert.deepEqual(policy.favoriteModels, [ref, other]);
    assert.deepEqual(policy.fallbackModels, [ref, other]);
    assert.deepEqual(policy.fallbackProfiles.visibility, [ref, other]);
    assert.deepEqual(
      await savedProvider(),
      connectionBefore,
      'Provider exclusion retains keys and model definitions',
    );
    assert.equal((await call('provider.models', { providerId })).models.length, 0);
    assert.ok(
      (await call('provider.models', { providerId, includeDisabled: true })).models.some(
        (model) => model.id === 'baseline',
      ),
    );
    assert.ok(
      JSON.parse(await readFile(configPath, 'utf8')).disabledProviders.includes(providerId),
    );
    await open();
    await providerControl.getByRole('button', { name: 'Enable provider', exact: true }).waitFor();
    await page
      .getByRole('combobox', { name: 'Visibility filter', exact: true })
      .selectOption('enabled');
    assert.equal(
      await page.getByRole('article', { name: 'Model visibility baseline', exact: true }).count(),
      0,
    );
    await page
      .getByRole('combobox', { name: 'Visibility filter', exact: true })
      .selectOption('hidden');
    await page.getByRole('article', { name: 'Model visibility baseline', exact: true }).waitFor();
    await page
      .getByRole('combobox', { name: 'Visibility filter', exact: true })
      .selectOption('all');
    await providerControl.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(artifactDir, 'native-provider-visibility.png'),
      fullPage: true,
    });
    await toggleProvider(false);
    await call('prefs.update', { disabledProviders: [providerId, 'peer-provider'] });
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'changed elsewhere' }).waitFor();
    assert.deepEqual((await call('prefs.get')).disabledProviders, [providerId, 'peer-provider']);
    await page
      .getByRole('button', { name: 'Reload saved values (discard drafts)', exact: true })
      .click();
    await page
      .getByRole('combobox', { name: 'Visibility provider', exact: true })
      .selectOption(providerId);
    await toggleProvider(false);
    await save();
    policy = await call('prefs.get');
    assert.deepEqual(policy.disabledProviders, ['peer-provider']);
    assert.deepEqual(policy.favoriteModels, [ref, other]);
    await call('prefs.update', { disabledModels: [...policy.disabledModels, ref] });
    await open();
    await toggleProvider(true);
    await save();
    await toggleProvider(false);
    await save();
    assert.ok((await call('prefs.get')).disabledModels.includes(ref));
    assert.equal(
      (await call('provider.models', { providerId })).models.length,
      0,
      'Re-enabling a provider preserves individual exclusions',
    );
    await page
      .getByRole('article', { name: 'Model visibility baseline', exact: true })
      .getByRole('button', { name: 'Enable model', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Apply to settings draft', exact: true })
      .click();
    await save();
    await page.getByText('1 saved disabled-provider rule', { exact: true }).click();
    await page
      .getByRole('button', { name: 'Remove provider rule peer-provider', exact: true })
      .click();
    await save();
    assert.deepEqual((await call('prefs.get')).disabledProviders, []);
    assert.ok(
      (await call('provider.models', { providerId })).models.some(
        (model) => model.id === 'baseline',
      ),
    );
    console.log(
      'PASS: native provider exclusion review/cancel/save, preserved favorites/routes/definitions, disk/reopen, effective filters, stale-write refusal, individual model rules and orphaned provider cleanup',
    );
    await page
      .getByRole('article', { name: 'Model visibility baseline', exact: true })
      .getByRole('button', { name: 'Remove favorite', exact: true })
      .click();
    await save();
    assert.ok(
      (await call('provider.models', { providerId })).models.some(
        (model) => model.id === 'baseline',
      ),
    );
    await card.getByRole('button', { name: 'Add favorite', exact: true }).click();
    await save();
    assert.deepEqual((await call('prefs.get')).favoriteModels, [other, ref]);
    await page.getByText('2 saved disabled-model rules', { exact: true }).click();
    await page.getByRole('button', { name: `Remove rule ${other}`, exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    assert.deepEqual((await call('prefs.get')).disabledModels, [other, 'peer/keep']);
    await page.screenshot({
      path: join(artifactDir, 'native-model-visibility.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 800, height: 640 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: join(artifactDir, 'native-model-visibility-compact.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1480, height: 960 });
  } finally {
    await call('prefs.update', original);
  }
  console.log(
    'PASS: native profile model visibility/favorites, reviewed fallback cleanup, catalog filtering, disk persistence, stale-write refusal and discarded rule removal',
  );
}
