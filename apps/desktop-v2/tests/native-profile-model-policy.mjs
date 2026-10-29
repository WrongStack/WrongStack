import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureModel } from './local-provider.mjs';

export async function exerciseNativeProfileModelPolicy({
  page,
  rpc,
  agent,
  waitFor,
  artifactDir,
  providerFixture,
}) {
  const offsets = new Map();
  const profileRpc = (method, params = {}) =>
    page.evaluate(
      ({ method, params }) => window.__TAURI_INTERNALS__.invoke('host_request', { method, params }),
      { method, params },
    );
  await profileRpc('profile.open');
  await waitFor(
    async () => (await profileRpc('profile.status')).status === 'running',
    'Profile choices service',
    100000,
  );
  const call = async (scope, type, payload = {}, replies = ['key.operation_result']) => {
    const requestId = crypto.randomUUID(),
      transport = scope === 'profile' ? profileRpc : rpc;
    await transport(`${scope}.send`, {
      ...(scope === 'engine' ? { id: agent.id } : {}),
      message: { type, payload: { ...payload, requestId } },
    });
    return await waitFor(
      async () => {
        const batch = await transport(`${scope}.events`, {
          ...(scope === 'engine' ? { id: agent.id } : {}),
          offset: offsets.get(scope) ?? 0,
        });
        offsets.set(scope, batch.offset);
        const frame = batch.events.find(
          (event) =>
            event.payload?.requestId === requestId &&
            (replies.includes(event.type) || event.type === 'error'),
        );
        if (frame?.type === 'error' || frame?.payload?.success === false || frame?.payload?.error)
          throw Error(frame.payload.error ?? frame.payload.message);
        return frame?.payload;
      },
      `Profile policy ${scope}:${type}`,
      45000,
    );
  };
  const profileBefore = await call('profile', 'prefs.get', {}, ['prefs.updated']);
  const engineBefore = await call('engine', 'prefs.get', {}, ['prefs.updated']);
  const initial = await rpc('engine.identity', { id: agent.id });
  const providerId = initial.provider,
    alt = 'desktop-policy-alternate',
    ref = `${providerId}/${fixtureModel}`,
    altRef = `${providerId}/${alt}`;
  const composer = page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  const oldDraft = await composer.inputValue();
  const original = Object.fromEntries(
    ['disabledProviders', 'disabledModels', 'favoriteModels'].map((key) => [
      key,
      profileBefore[key] ?? [],
    ]),
  );
  const count = (await rpc('snapshot')).sessions.length;
  const humanFrames = async () => {
    let offset = 0,
      total = 0;
    for (let pageIndex = 0; pageIndex < 30; pageIndex++) {
      const batch = await rpc('engine.events', { id: agent.id, offset });
      total += batch.events.filter((event) => event.type === 'desktop.user_message').length;
      offset = batch.offset;
      if (!batch.hasMore) return total;
    }
    throw Error('Model-policy fixture history exceeded its read budget');
  };
  try {
    await call('profile', 'provider.custom_models.set', {
      providerId,
      modelId: alt,
      customModel: { name: 'Policy alternate', capabilities: { tools: true, streaming: true } },
    });
    await call('engine', 'prefs.update', { reasoningEffort: 'high' });
    await call('profile', 'prefs.update', {
      favoriteModels: [altRef],
      disabledModels: [],
      disabledProviders: [],
    });
    await composer.fill('[native-profile-policy-draft] Keep the model-policy draft.');
    const promptsBefore = await humanFrames();
    await page.getByRole('button', { name: 'Choose session model', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Choose a model', exact: true });
    const modelButton = (id) =>
      picker
        .locator('.composer-model-list > button')
        .filter({ has: page.locator('small', { hasText: id }) });
    await modelButton(alt).waitFor();
    assert.ok(
      (await picker.locator('.composer-model-list > button').first().innerText()).includes(alt),
    );
    await call('profile', 'prefs.update', { favoriteModels: [ref], disabledModels: [] });
    await waitFor(
      async () =>
        (await picker.locator('.composer-model-list > button').first().innerText()).includes(
          fixtureModel,
        ),
      'Live favorite ordering',
    );
    await call('profile', 'prefs.update', { disabledModels: [ref] });
    await modelButton(fixtureModel).waitFor({ state: 'detached' });
    await modelButton(alt).waitFor();
    assert.equal((await rpc('engine.identity', { id: agent.id })).model, fixtureModel);
    assert.equal(
      (await call('engine', 'prefs.get', {}, ['prefs.updated'])).reasoningEffort,
      'high',
    );
    await call('profile', 'prefs.update', { disabledProviders: [providerId] });
    await picker
      .getByText('No available models match the current profile policy.', { exact: true })
      .waitFor();
    await call('profile', 'prefs.update', { disabledProviders: [], disabledModels: [] });
    await modelButton(fixtureModel).waitFor();
    await picker.getByRole('button', { name: 'Refresh model choices', exact: true }).click();
    await modelButton(alt).waitFor();
    await page.screenshot({
      path: join(artifactDir, 'native-live-model-policy.png'),
      fullPage: true,
    });
    // Comparison mode: picking rows does not switch; the table offers the switch instead.
    await picker.getByRole('button', { name: 'Compare models', exact: true }).click();
    await modelButton(fixtureModel).click();
    await modelButton(alt).click();
    await picker.getByText('2 models picked from 1 provider(s).', { exact: false }).waitFor();
    assert.equal((await rpc('engine.identity', { id: agent.id })).model, fixtureModel);
    await picker.getByRole('button', { name: 'Show comparison', exact: true }).click();
    const comparison = picker.getByRole('table', { name: 'Model comparison', exact: true });
    const headers = await comparison.locator('thead th').allInnerTexts();
    assert.ok(headers[1].includes(fixtureModel) && headers[2].includes(alt), headers.join(' | '));
    const toolsRow = comparison
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name: 'Tools', exact: true }) });
    assert.equal((await toolsRow.locator('td').allInnerTexts())[1], 'Yes');
    await page.screenshot({
      path: join(artifactDir, 'native-model-comparison.png'),
      fullPage: true,
    });
    await comparison.getByRole('button', { name: /^Use / }).nth(1).click();
    await picker.waitFor({ state: 'detached' });
    assert.equal((await rpc('engine.identity', { id: agent.id })).model, alt);
    assert.equal(
      await composer.inputValue(),
      '[native-profile-policy-draft] Keep the model-policy draft.',
    );
    assert.equal(
      (await call('engine', 'prefs.get', {}, ['prefs.updated'])).reasoningEffort,
      'high',
    );
    await page.getByRole('button', { name: 'Choose session model', exact: true }).click();
    await modelButton(fixtureModel).click();
    await picker.waitFor({ state: 'detached' });
    assert.equal((await rpc('engine.identity', { id: agent.id })).model, fixtureModel);
    // The recently used alternate switches back with one click from the recents row.
    await page.getByRole('button', { name: 'Choose session model', exact: true }).click();
    await picker
      .getByRole('group', { name: 'Recent models', exact: true })
      .getByRole('button')
      .filter({ hasText: alt })
      .click();
    await picker.waitFor({ state: 'detached' });
    assert.equal((await rpc('engine.identity', { id: agent.id })).model, alt);
    await page.getByRole('button', { name: 'Choose session model', exact: true }).click();
    await modelButton(fixtureModel).click();
    await picker.waitFor({ state: 'detached' });
    assert.equal((await rpc('engine.identity', { id: agent.id })).model, fixtureModel);
    assert.equal(await humanFrames(), promptsBefore, 'Model choices do not enqueue a human prompt');
    assert.equal(
      providerFixture.calls.some((call) => call.profilePolicyDraft),
      false,
      'The retained policy draft never reaches the provider',
    );
    await writeFile(
      join(artifactDir, 'native-model-policy-provider-calls.json'),
      JSON.stringify(providerFixture.calls, null, 2),
    );
    assert.equal(
      (await rpc('snapshot')).sessions.length,
      count,
      'Profile choice reads do not create conversation tabs',
    );
  } catch (error) {
    await page.screenshot({
      path: join(artifactDir, 'native-model-policy-failure.png'),
      fullPage: true,
    });
    await writeFile(
      join(artifactDir, 'native-model-policy-failure.txt'),
      await page
        .getByRole('dialog')
        .allTextContents()
        .then((text) => text.join('\n')),
    );
    throw error;
  } finally {
    if (await page.getByRole('button', { name: 'Close model picker', exact: true }).count())
      await page.getByRole('button', { name: 'Close model picker', exact: true }).click();
    await call('profile', 'prefs.update', original);
    await call('engine', 'prefs.update', {
      reasoningEffort: engineBefore.reasoningEffort ?? 'auto',
    });
    await call('profile', 'provider.custom_models.remove', { providerId, modelId: alt });
    await composer.fill(oldDraft);
  }
  console.log(
    'PASS: open session picker uses current profile catalogs, live favorites/model/provider exclusions, preserves session effort/draft/identity, switches explicitly and creates no extra conversations or human prompts',
  );
}
