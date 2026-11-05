import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exerciseNativeModelDrafts } from './native-model-drafts.mjs';
import { exerciseNativeModelPriceTiers } from './native-model-price-tiers.mjs';
import { exerciseNativeModelVisibility } from './native-model-visibility.mjs';
import { exerciseNativeProviderOAuth } from './native-provider-oauth.mjs';

export async function exerciseNativeModelCatalog({ page, rpc, waitFor, artifactDir, configPath }) {
  let offset = 0;
  const call = async (type, payload = {}) => {
    const requestId = crypto.randomUUID();
    await rpc('profile.send', { message: { type, payload: { ...payload, requestId } } });
    const reply = await waitFor(
      async () => {
        const batch = await rpc('profile.events', { offset });
        offset = batch.offset;
        return batch.events.find((event) => event.payload?.requestId === requestId)?.payload;
      },
      `Native model catalog ${type}`,
      45000,
    );
    if (reply.success === false || reply.ok === false || typeof reply.error === 'string')
      throw Error(reply.error ?? reply.message);
    return reply;
  };
  const providerId = 'native-model-catalog';
  const modelId = 'native/reviewed-model';
  const count = (await rpc('snapshot')).sessions.length;
  const saved = async () =>
    (await call('providers.saved')).providers.find((provider) => provider.id === providerId);
  await call('provider.add', {
    id: providerId,
    type: 'openai-compatible',
    family: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:9/v1',
    models: ['baseline'],
    customModels: {
      baseline: {
        name: 'Baseline fixture',
        capabilities: { tools: true, streaming: true },
        maxOutput: 8192,
      },
    },
  });
  try {
    await exerciseNativeModelVisibility({ page, call, providerId, configPath, artifactDir });
    await exerciseNativeProviderOAuth({ page, rpc, call, waitFor, providerId, artifactDir });
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'WrongStack settings', exact: true })
      .click();
    await page
      .getByRole('navigation', { name: 'WrongStack settings sections' })
      .getByRole('button', { name: 'Model catalog', exact: true })
      .click();
    const catalog = page.getByRole('region', { name: 'Model catalog settings' });
    await catalog.getByLabel('Catalog provider', { exact: true }).selectOption(providerId);
    await catalog
      .locator('.model-catalog-list')
      .getByRole('button', { name: /Baseline fixture/ })
      .click();
    await catalog.getByRole('heading', { name: 'Baseline fixture', exact: true }).waitFor();
    await catalog.getByRole('button', { name: 'Find in model registry', exact: true }).click();
    const search = catalog.getByRole('region', { name: 'Search model registry' });
    await search
      .getByLabel('Search model registry', { exact: true })
      .fill('native-no-model-' + crypto.randomUUID());
    await search.getByRole('button', { name: 'Search registry', exact: true }).click();
    await search.getByText('No matching catalog models.', { exact: true }).waitFor();
    await search.getByLabel('Search model registry', { exact: true }).fill('claude');
    await search.getByRole('button', { name: 'Search registry', exact: true }).click();
    const matches = (await call('provider.models.search', { query: 'claude', limit: 20 })).matches;
    assert.ok(matches.length > 0, 'Bundled model registry has actual matches');
    await search.getByRole('button', { name: 'Review definition', exact: true }).first().click();
    const imported = page.getByRole('dialog');
    assert.equal(
      await imported.getByLabel('Model definition ID', { exact: true }).inputValue(),
      matches[0].modelId,
    );
    assert.equal(
      await imported.getByLabel('Model display name', { exact: true }).inputValue(),
      matches[0].name,
    );
    assert.equal(
      (await saved()).customModels[matches[0].modelId],
      undefined,
      'Catalog review does not save or call a model',
    );
    await imported.getByRole('button', { name: 'Cancel model editing', exact: true }).click();
    await catalog.getByRole('button', { name: 'Add model definition', exact: true }).click();
    let editor = page.getByRole('dialog');
    await editor.getByLabel('Model definition ID', { exact: true }).fill(modelId);
    await editor.getByLabel('Model display name', { exact: true }).fill('Native reviewed model');
    await editor.getByLabel('Context tokens', { exact: true }).fill('65536');
    await editor.getByLabel('Maximum output tokens', { exact: true }).fill('8192');
    await editor.getByLabel('Input USD / million tokens', { exact: true }).fill('0');
    await editor.getByLabel('Output USD / million tokens', { exact: true }).fill('0.4');
    await editor.getByLabel('Model tool calls', { exact: true }).selectOption('true');
    await editor.getByLabel('Model input modalities', { exact: true }).fill('text, image');
    await editor.getByLabel('Model output modalities', { exact: true }).fill('text');
    await editor.getByLabel('Model reasoning', { exact: true }).selectOption('true');
    await editor.getByLabel('1 hour cache write USD / million tokens', { exact: true }).fill('0');
    await editor.getByText('Advanced model behavior', { exact: true }).click();
    await editor.getByRole('button', { name: 'Add reasoning control', exact: true }).click();
    await editor.getByLabel('Control 1 effort low', { exact: true }).check();
    await editor.getByLabel('Control 1 effort high', { exact: true }).check();
    await editor.getByRole('button', { name: 'Add reasoning control', exact: true }).click();
    await editor.getByLabel('Control 2 min reasoning tokens', { exact: true }).fill('32768');
    await editor.getByLabel('Control 2 max reasoning tokens', { exact: true }).fill('1024');
    await editor.getByLabel('Model interleaved reasoning', { exact: true }).selectOption('field');
    await editor
      .getByLabel('Model reasoning replay field', { exact: true })
      .fill('reasoning_content');
    await editor.getByLabel('Model catalog status', { exact: true }).selectOption('beta');
    await editor.getByLabel('Model experimental status', { exact: true }).selectOption('false');
    await editor.getByLabel('Model SDK package', { exact: true }).fill('@ai-sdk/openai-compatible');
    await editor.getByLabel('Model API endpoint', { exact: true }).fill('http://127.0.0.1:9/v1');
    await editor.getByRole('button', { name: 'Save model definition', exact: true }).click();
    await editor
      .getByRole('alert')
      .filter({ hasText: 'Minimum reasoning tokens cannot exceed' })
      .waitFor();
    assert.equal(
      (await saved()).customModels?.[modelId],
      undefined,
      'Invalid controls never reach storage',
    );
    await editor.getByLabel('Control 2 min reasoning tokens', { exact: true }).fill('1024');
    await editor.getByLabel('Control 2 max reasoning tokens', { exact: true }).fill('32768');
    await page.screenshot({
      path: join(artifactDir, 'native-model-advanced-authoring.png'),
      fullPage: true,
    });
    await editor.getByRole('button', { name: 'Save model definition', exact: true }).click();
    await catalog.getByText('Model definition saved and verified.', { exact: true }).waitFor();
    let stored = await saved();
    assert.ok(stored.models.includes(modelId));
    assert.equal(stored.customModels[modelId].modelsDev.limit.context, 65536);
    assert.equal(stored.customModels[modelId].modelsDev.cost.input, 0);
    assert.equal(stored.customModels[modelId].capabilities.tools, true);
    const advancedSaved = stored.customModels[modelId].modelsDev;
    assert.deepEqual(advancedSaved.reasoning_options, [
      { type: 'effort', values: ['low', 'high'] },
      { type: 'budget_tokens', min: 1024, max: 32768 },
    ]);
    assert.deepEqual(advancedSaved.interleaved, { field: 'reasoning_content' });
    assert.equal(advancedSaved.status, 'beta');
    assert.equal(advancedSaved.experimental, false);
    assert.equal(advancedSaved.provider.npm, '@ai-sdk/openai-compatible');
    assert.equal(advancedSaved.provider.api, 'http://127.0.0.1:9/v1');
    assert.equal(advancedSaved.cost.cache_write_1h, 0);
    const effective = (
      await call('provider.models', { providerId, includeDisabled: true })
    ).models.find((model) => model.id === modelId);
    assert.ok(effective, 'Saved definition is in the actual provider model catalog');
    assert.deepEqual(effective.reasoningEffortLevels, ['low', 'high']);
    assert.equal(effective.effortSupported, true);
    assert.deepEqual(
      JSON.parse(await readFile(configPath, 'utf8')).providers[providerId].customModels[modelId]
        .modelsDev,
      advancedSaved,
    );
    assert.ok(
      JSON.parse(await readFile(configPath, 'utf8')).providers[providerId].customModels[modelId],
    );
    await catalog.getByRole('button', { name: 'Edit model definition', exact: true }).click();
    editor = page.getByRole('dialog');
    await editor.getByText('Advanced model behavior', { exact: true }).click();
    assert.equal(
      await editor.getByLabel('Control 2 max reasoning tokens', { exact: true }).inputValue(),
      '32768',
    );
    assert.equal(
      await editor.getByLabel('Model reasoning replay field', { exact: true }).inputValue(),
      'reasoning_content',
    );
    await editor
      .getByLabel('Model display name', { exact: true })
      .fill('Retain this unsaved draft');
    const remote = structuredClone(stored.customModels[modelId]);
    remote.name = 'Newer external model';
    remote.modelsDev.name = 'Newer external model';
    remote.modelsDev.reasoning_options = { type: 'effort', values: ['low', 'high'] };
    remote.modelsDev.cost.tiers = [{ from: 200000, input: 2 }];
    await call('provider.custom_models.set', { providerId, modelId, customModel: remote });
    await editor.getByRole('button', { name: 'Save model definition', exact: true }).click();
    await editor
      .getByRole('alert')
      .filter({ hasText: /changed since it was opened/ })
      .waitFor();
    assert.equal(
      await editor.getByLabel('Model display name', { exact: true }).inputValue(),
      'Retain this unsaved draft',
    );
    assert.equal((await saved()).customModels[modelId].name, remote.name);
    await editor.getByRole('button', { name: 'Cancel model editing', exact: true }).click();
    await editor.getByRole('button', { name: 'Keep editing model', exact: true }).click();
    assert.equal(
      await editor.getByLabel('Model display name', { exact: true }).inputValue(),
      'Retain this unsaved draft',
    );
    await editor.getByRole('button', { name: 'Cancel model editing', exact: true }).click();
    await editor.getByRole('button', { name: 'Discard model draft', exact: true }).click();
    await catalog.getByRole('button', { name: 'Refresh catalog', exact: true }).click();
    await catalog.getByRole('heading', { name: remote.name, exact: true }).waitFor();
    await catalog.getByRole('button', { name: 'Edit model definition', exact: true }).click();
    editor = page.getByRole('dialog');
    await editor.getByLabel('Model tool calls', { exact: true }).selectOption('false');
    await page.screenshot({
      path: join(artifactDir, 'native-model-definition-editor.png'),
      fullPage: true,
    });
    await editor.getByRole('button', { name: 'Save model definition', exact: true }).click();
    await catalog.getByText('Model definition saved and verified.', { exact: true }).waitFor();
    stored = await saved();
    assert.equal(stored.customModels[modelId].modelsDev.tool_call, false);
    assert.equal(stored.customModels[modelId].capabilities.tools, false);
    assert.deepEqual(
      stored.customModels[modelId].modelsDev.reasoning_options,
      remote.modelsDev.reasoning_options,
    );
    assert.deepEqual(
      stored.customModels[modelId].modelsDev.cost.tiers,
      remote.modelsDev.cost.tiers,
    );
    await catalog.getByRole('button', { name: 'Edit model definition', exact: true }).click();
    editor = page.getByRole('dialog');
    await editor.getByText('Advanced model behavior', { exact: true }).click();
    await editor
      .getByLabel('Model reasoning policy source', { exact: true })
      .selectOption('custom');
    await editor.getByLabel('Runtime reasoning default', { exact: true }).selectOption('adaptive');
    await editor.getByLabel('Runtime reasoning can disable', { exact: true }).selectOption('true');
    await editor
      .getByLabel('Runtime reasoning effort support', { exact: true })
      .selectOption('true');
    await editor.getByLabel('Runtime effort xhigh', { exact: true }).check();
    await editor
      .getByLabel('Runtime reasoning thinking retention', { exact: true })
      .selectOption('optional');
    await page.screenshot({
      path: join(artifactDir, 'native-model-explicit-runtime-policy.png'),
      fullPage: true,
    });
    await editor.getByRole('button', { name: 'Save model definition', exact: true }).click();
    await catalog.getByText('Model definition saved and verified.', { exact: true }).waitFor();
    const explicit = (await saved()).customModels[modelId].modelsDev.reasoningConfig;
    assert.deepEqual(explicit, {
      default: 'adaptive',
      disableSupported: true,
      effortSupported: true,
      effortLevels: ['xhigh'],
      preserveThinking: 'optional',
    });
    assert.deepEqual(
      JSON.parse(await readFile(configPath, 'utf8')).providers[providerId].customModels[modelId]
        .modelsDev.reasoningConfig,
      explicit,
    );
    assert.deepEqual(
      (await call('provider.models', { providerId, includeDisabled: true })).models.find(
        (model) => model.id === modelId,
      ).reasoningEffortLevels,
      ['xhigh'],
    );
    await catalog.getByRole('button', { name: 'Edit model definition', exact: true }).click();
    editor = page.getByRole('dialog');
    await editor.getByText('Advanced model behavior', { exact: true }).click();
    await editor
      .getByLabel('Model reasoning policy source', { exact: true })
      .selectOption('custom');
    assert.equal(
      await editor.getByLabel('Runtime reasoning default', { exact: true }).inputValue(),
      'adaptive',
    );
    assert.equal(
      await editor.getByLabel('Runtime effort xhigh', { exact: true }).isChecked(),
      true,
    );
    await editor
      .getByLabel('Model reasoning policy source', { exact: true })
      .selectOption('catalog');
    await editor.getByRole('button', { name: 'Save model definition', exact: true }).click();
    await catalog.getByText('Model definition saved and verified.', { exact: true }).waitFor();
    assert.equal((await saved()).customModels[modelId].modelsDev.reasoningConfig, undefined);
    assert.deepEqual(
      (await call('provider.models', { providerId, includeDisabled: true })).models.find(
        (model) => model.id === modelId,
      ).reasoningEffortLevels,
      ['low', 'high'],
    );
    await exerciseNativeModelPriceTiers({
      page,
      catalog,
      call,
      saved,
      providerId,
      modelId,
      artifactDir,
      configPath,
    });
    await exerciseNativeModelDrafts({
      page,
      catalog,
      call,
      saved,
      providerId,
      modelId,
      artifactDir,
      waitFor,
    });
    await page.screenshot({ path: join(artifactDir, 'native-model-catalog.png'), fullPage: true });
    await page.setViewportSize({ width: 800, height: 640 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: join(artifactDir, 'native-model-catalog-compact.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1480, height: 960 });
    await catalog.getByRole('button', { name: 'Remove custom definition', exact: true }).click();
    await catalog.getByRole('button', { name: 'Keep definition', exact: true }).click();
    assert.ok((await saved()).customModels[modelId]);
    await catalog.getByRole('button', { name: 'Remove custom definition', exact: true }).click();
    await catalog.getByRole('button', { name: 'Confirm remove definition', exact: true }).click();
    await catalog
      .getByText('Custom model definition removed and verified.', { exact: true })
      .waitFor();
    stored = await saved();
    assert.equal(stored.customModels?.[modelId], undefined);
    assert.equal(stored.models.includes(modelId), false);
    await call('key.add', {
      providerId,
      label: 'primary',
      apiKey: 'native-catalog-primary-fixture',
    });
    await call('key.add', { providerId, label: 'backup', apiKey: 'native-catalog-backup-fixture' });
    await page
      .getByRole('navigation', { name: 'WrongStack settings sections' })
      .getByRole('button', { name: 'Providers & models', exact: true })
      .click();
    const connections = page.getByRole('region', { name: 'Provider settings' });
    await connections
      .getByRole('button', { name: `Use key backup for ${providerId}`, exact: true })
      .click();
    await connections.getByText('Active key changed and verified.', { exact: true }).waitFor();
    assert.equal((await saved()).apiKeys.find((key) => key.label === 'backup').isActive, true);
    await connections
      .getByRole('button', { name: `Delete key backup for ${providerId}`, exact: true })
      .click();
    await connections.getByRole('button', { name: 'Keep connection', exact: true }).click();
    assert.ok((await saved()).apiKeys.some((key) => key.label === 'backup'));
    await connections
      .getByRole('button', { name: `Delete key backup for ${providerId}`, exact: true })
      .click();
    await connections.getByRole('button', { name: 'Confirm delete key', exact: true }).click();
    await connections.getByText('Saved key deleted and verified.', { exact: true }).waitFor();
    assert.equal(
      (await saved()).apiKeys.some((key) => key.label === 'backup'),
      false,
    );
    assert.equal((await saved()).apiKeys.find((key) => key.label === 'primary').isActive, true);
    const config = await readFile(configPath, 'utf8');
    assert.equal(
      config.includes('native-catalog-primary-fixture'),
      false,
      'Keys are encrypted at rest',
    );
    assert.equal(
      (await page.content()).includes('native-catalog-primary-fixture'),
      false,
      'Only masked credentials enter markup',
    );
    await page.screenshot({
      path: join(artifactDir, 'native-provider-key-management.png'),
      fullPage: true,
    });
    await connections
      .getByRole('button', { name: `Remove connection ${providerId}`, exact: true })
      .click();
    await connections.getByRole('button', { name: 'Keep connection', exact: true }).click();
    assert.ok(await saved());
    await connections
      .getByRole('button', { name: `Remove connection ${providerId}`, exact: true })
      .click();
    await connections
      .getByRole('button', { name: 'Confirm remove connection', exact: true })
      .click();
    await connections
      .getByText('Provider connection removed and verified.', { exact: true })
      .waitFor();
    assert.equal(await saved(), undefined);
    await page
      .getByRole('navigation', { name: 'WrongStack settings sections' })
      .getByRole('button', { name: 'Model catalog', exact: true })
      .click();
    await catalog.getByRole('button', { name: 'Refresh catalog', exact: true }).click();
    await waitFor(
      async () =>
        (await catalog.getByLabel('Catalog provider', { exact: true }).inputValue()) === '',
      'Removed provider catalog cleared',
    );
    await call('provider.add', {
      id: providerId,
      type: 'openai-compatible',
      family: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      models: ['baseline'],
    });
    await catalog.getByRole('button', { name: 'Refresh catalog', exact: true }).click();
    await waitFor(
      async () =>
        (await catalog.getByLabel('Catalog provider', { exact: true }).inputValue()) === providerId,
      'Empty catalog discovers newly saved connection',
    );
    assert.equal((await rpc('snapshot')).sessions.length, count);
  } finally {
    if (await saved()) await call('provider.remove', { providerId });
  }
  console.log(
    'PASS: native model catalog/detail, custom definition create/edit/remove, readback/config persistence, stale edit refusal, schema preservation, active key/delete/provider removal and encrypted credentials without sessions',
  );
}
