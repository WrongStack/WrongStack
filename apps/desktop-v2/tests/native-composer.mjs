import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixtureModel } from './local-provider.mjs';
import { exerciseNativePasteHint } from './native-paste-hint.mjs';
import { exerciseNativeProfileModelPolicy } from './native-profile-model-policy.mjs';
import { exerciseNativeSessionAgentPlan } from './native-session-agent-plan.mjs';
import { exerciseNativeTopicBoundary } from './native-topic-boundary.mjs';

/** Actual Tauri composer -> native IPC -> production engine -> isolated provider. */
export async function exerciseNativeComposer({
  page,
  identity,
  agent,
  rpc,
  artifactDir,
  waitFor,
  providerFixture,
  configPath,
}) {
  await exerciseNativeProfileModelPolicy({
    page,
    rpc,
    agent,
    waitFor,
    artifactDir,
    providerFixture,
  });
  let offset = 0;
  const call = async (type, payload = {}, replies = []) => {
    const requestId = crypto.randomUUID();
    await rpc('engine.send', {
      id: agent.id,
      message: { type, payload: { ...payload, requestId } },
    });
    return await waitFor(
      async () => {
        const batch = await rpc('engine.events', { id: agent.id, offset });
        offset = batch.offset;
        const event = batch.events.find(
          (e) =>
            e.payload?.requestId === requestId && (replies.includes(e.type) || e.type === 'error'),
        );
        if (
          event?.type === 'error' ||
          event?.payload?.success === false ||
          typeof event?.payload?.error === 'string'
        )
          throw Error(event.payload.error ?? event.payload.message);
        return event?.payload;
      },
      'Composer ' + type,
      45000,
    );
  };
  const composer = () => page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  await exerciseNativeSessionAgentPlan({
    page,
    rpc,
    agent,
    call,
    waitFor,
    artifactDir,
    configPath,
  });
  await exerciseNativePasteHint({ page });
  const idle = () =>
    waitFor(
      async () => !(await page.getByRole('button', { name: 'Stop run', exact: true }).count()),
      'Composer run completion',
      60000,
    );
  const send = async (text, mode = 'btw') => {
    await page.getByRole('combobox', { name: 'Message delivery mode' }).selectOption(mode);
    await composer().fill(text);
    await page.locator('.composer-send').click();
  };
  const options = async () => {
    const details = page.locator('.composer-options');
    if (!(await details.evaluate((el) => el.open)))
      await details.getByLabel('Composer options', { exact: true }).click();
    return details;
  };
  await idle();
  await page.getByRole('button', { name: 'Choose session model', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a model' });
  await picker.getByRole('textbox', { name: 'Search session models' }).fill(fixtureModel);
  await picker
    .getByRole('button')
    .filter({ has: page.locator('strong', { hasText: fixtureModel }) })
    .click();
  await picker.waitFor({ state: 'detached' });
  await page.getByRole('combobox', { name: 'Session reasoning effort' }).selectOption('high');
  await waitFor(
    async () => (await call('prefs.get', {}, ['prefs.updated'])).reasoningEffort === 'high',
    'Session effort readback',
  );
  await page.getByRole('combobox', { name: 'Session reasoning effort' }).selectOption('auto');
  await waitFor(
    async () => (await call('prefs.get', {}, ['prefs.updated'])).reasoningEffort === 'auto',
    'Session effort inheritance',
  );
  await page.screenshot({ path: join(artifactDir, 'native-composer-calm.png'), fullPage: true });

  await send('[native-composer-hold-queue] Keep this turn open.');
  await waitFor(() => providerFixture.holds.has('queue'), 'Real provider held turn');
  const turnCalls = providerFixture.calls.filter((c) => c.stream).length;
  await send('[native-composer-btw] Keep the public API stable.', 'btw');
  await page.getByRole('status').filter({ hasText: 'BTW saved for this session' }).waitFor();
  assert.equal(
    providerFixture.calls.filter((c) => c.stream).length,
    turnCalls,
    'BTW does not interrupt or start a provider turn',
  );
  assert.ok(providerFixture.holds.has('queue'), 'BTW leaves the active provider request running');
  // The sent note is followed through its real mailbox record.
  const receipts = page.locator('.btw-receipts');
  await receipts.locator('summary').filter({ hasText: 'BTW notes · 1' }).click();
  const receipt = receipts
    .getByRole('region', { name: 'BTW receipts', exact: true })
    .locator('li')
    .filter({ hasText: '[native-composer-btw] Keep the public API stable.' });
  await waitFor(
    async () => /Saved · not read yet|Read by the leader|Handled/.test(await receipt.innerText()),
    'BTW receipt read from the mailbox',
  );
  const btwMail = (
    await call('mailbox.messages', { limit: 200 }, ['mailbox.messages'])
  ).messages.find((mail) => mail.body === '[native-composer-btw] Keep the public API stable.');
  assert.ok(btwMail, 'The receipt follows a real mailbox record');
  assert.equal(
    (await receipt.innerText()).includes('Handled'),
    btwMail.completed === true,
    'Handled is shown exactly when the mailbox record is completed',
  );
  await receipts.locator('summary').click();
  await send('[native-composer-remove] Remove this pending task.', 'queue');
  const queue = page.locator('.composer-queue');
  await queue.locator('summary').filter({ hasText: '1 queued prompt' }).waitFor();
  await queue.locator('summary').click();
  await queue
    .getByRole('button', {
      name: 'Remove queued prompt [native-composer-remove] Remove this pending task.',
      exact: true,
    })
    .click();
  await queue.waitFor({ state: 'detached' });
  await send('[native-composer-queued] Run this next task.', 'queue');
  await queue.locator('summary').filter({ hasText: '1 queued prompt' }).waitFor();
  assert.equal((await call('queue.get', {}, ['queue.state'])).items.length, 1);
  await page.screenshot({ path: join(artifactDir, 'native-composer-queue.png'), fullPage: true });
  await page.reload();
  await page.locator(`[data-engine-session="${identity.sessionId}"]`).waitFor();
  await queue.locator('summary').filter({ hasText: '1 queued prompt' }).waitFor();
  assert.ok(providerFixture.holds.has('queue'), 'Queue and active turn survive renderer reload');
  await send('Do not lose this steering draft.', 'steer');
  await page.getByRole('alert').filter({ hasText: 'Remove pending queued prompts' }).waitFor();
  assert.equal(await composer().inputValue(), 'Do not lose this steering draft.');
  assert.ok(
    providerFixture.holds.has('queue'),
    'Ambiguous steering does not interrupt or drop queued work',
  );
  await composer().fill('');
  providerFixture.releaseHold('queue');
  await waitFor(
    () => providerFixture.calls.some((c) => c.composerPrompt.includes('[native-composer-queued]')),
    'Engine drains the queue after the held turn',
  );
  await idle();
  assert.equal((await call('queue.get', {}, ['queue.state'])).items.length, 0);
  assert.equal(
    await page
      .locator('.chat-message.user')
      .filter({ hasText: '[native-composer-queued]' })
      .count(),
    1,
    'Drained prompt appears exactly once after reload',
  );
  assert.ok(
    !providerFixture.calls.some((c) => c.composerPrompt.includes('[native-composer-remove]')),
    'Removed prompt never reaches the provider',
  );

  await send('[native-composer-hold-steer] Wait for a new instruction.');
  await waitFor(() => providerFixture.holds.has('steer'), 'Real steer fixture run');
  await send('[native-composer-steered] Follow the revised instruction.', 'steer');
  await waitFor(
    () => providerFixture.canceledHolds.has('steer'),
    'Steer aborts the real provider request',
  );
  await waitFor(
    () => providerFixture.calls.some((c) => c.composerPrompt.includes('[native-composer-steered]')),
    'Steer starts a new provider request',
  );
  await idle();

  await send('[native-composer-hold-edit] Keep this prompt available to edit.');
  await waitFor(() => providerFixture.holds.has('edit'), 'Real stop-and-edit fixture run');
  await composer().fill('Existing unsent draft must survive.');
  await page.getByRole('button', { name: 'Stop and edit last prompt', exact: true }).click();
  await page.getByText('Your composer already contains a draft.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Keep current draft', exact: true }).click();
  assert.equal(await composer().inputValue(), 'Existing unsent draft must survive.');
  await waitFor(
    () => providerFixture.canceledHolds.has('edit'),
    'Stop and edit aborts the active request',
  );
  await idle();
  await composer().fill('');
  await send('[native-composer-hold-restore] Restore this exact last prompt.');
  await waitFor(() => providerFixture.holds.has('restore'), 'Real prompt restoration fixture');
  await page.getByRole('button', { name: 'Stop and edit last prompt', exact: true }).click();
  await waitFor(
    async () =>
      (await composer().inputValue()) ===
      '[native-composer-hold-restore] Restore this exact last prompt.',
    'Last prompt restored into empty composer',
  );
  await idle();
  await composer().fill('');

  await page.getByRole('combobox', { name: 'Message delivery mode' }).selectOption('queue');
  await composer().fill('[native-composer-refine] Build the desktop composer.');
  await (await options()).getByRole('button', { name: 'Refine this draft', exact: true }).click();
  let refine = page.getByRole('dialog', { name: 'Refine your prompt' });
  await refine.getByRole('button', { name: 'Refined', exact: true }).waitFor();
  await waitFor(
    async () => await refine.getByRole('button', { name: 'Refined', exact: true }).isEnabled(),
    'Real model refinement result',
    120000,
  );
  assert.equal(
    await refine.getByRole('button', { name: 'English', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  await refine.getByRole('button', { name: 'Refined', exact: true }).click();
  await refine
    .getByRole('region', { name: 'Prompt preview', exact: true })
    .getByText('Build the desktop composer and preserve the requested session boundaries.', {
      exact: true,
    })
    .waitFor();
  assert.ok(
    providerFixture.calls.some((c) => c.refiner),
    'Refinement calls the production refiner/provider path',
  );
  // Word-level comparison against the original draft.
  await refine.getByRole('checkbox', { name: 'Compare with original', exact: true }).check();
  const comparison = refine.getByRole('region', {
    name: 'Changes from your original draft',
    exact: true,
  });
  await comparison.getByText(/words? added/).waitFor();
  assert.ok((await comparison.locator('ins').count()) > 0, 'Refined words are marked as added');
  assert.equal(
    (await comparison.locator('.refine-comparison-text').innerText()).includes('desktop composer'),
    true,
  );
  await refine.getByRole('checkbox', { name: 'Compare with original', exact: true }).uncheck();
  const refinerPrefs = await call('prefs.get', {}, ['prefs.updated']);
  const refinerIdentity = await rpc('engine.identity', { id: agent.id });
  let profileOffset = 0;
  const profileCall = async (type, payload) => {
    const requestId = crypto.randomUUID();
    await rpc('profile.send', { message: { type, payload: { ...payload, requestId } } });
    return await waitFor(async () => {
      const batch = await rpc('profile.events', { offset: profileOffset });
      profileOffset = batch.offset;
      const event = batch.events.find((event) => event.payload?.requestId === requestId);
      if (event?.type === 'error' || event?.payload?.success === false || event?.payload?.error)
        throw Error(event.payload.error ?? event.payload.message);
      return event?.payload;
    }, `Refiner profile ${type}`);
  };
  await profileCall('provider.custom_models.set', {
    providerId: refinerIdentity.provider,
    modelId: 'alternate-refiner',
    customModel: { name: 'Alternate refiner', capabilities: { streaming: true } },
  });
  const optionsForRefiner = async () => {
    const details = refine.locator('.refine-options');
    if (!(await details.evaluate((element) => element.open)))
      await details.locator('summary').click();
    return details;
  };
  const refinerCallsBeforeSelection = providerFixture.calls.filter((call) => call.refiner).length;
  await (await optionsForRefiner())
    .getByRole('button', { name: 'Choose refiner model', exact: true })
    .click();
  const refinerPicker = page.getByRole('dialog', { name: 'Choose a refiner', exact: true });
  await refinerPicker
    .getByLabel('Search refiner models', { exact: true })
    .fill('no-native-model-matches');
  await refinerPicker
    .getByText('No available models match the current profile policy.', { exact: true })
    .waitFor();
  await refinerPicker
    .getByLabel('Search refiner models', { exact: true })
    .fill('alternate-refiner');
  await refinerPicker
    .locator('.composer-model-list button')
    .filter({ hasText: 'alternate-refiner' })
    .waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-refiner-picker.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(
    await refinerPicker.evaluate((element) => element.scrollWidth > element.clientWidth),
    false,
  );
  await page.screenshot({
    path: join(artifactDir, 'native-refiner-picker-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await refinerPicker
    .locator('.composer-model-list button')
    .filter({ hasText: 'alternate-refiner' })
    .click();
  await refine.waitFor();
  await optionsForRefiner();
  assert.equal(
    await refine.getByLabel('Refiner model', { exact: true }).inputValue(),
    'alternate-refiner',
  );
  assert.equal(
    providerFixture.calls.filter((call) => call.refiner).length,
    refinerCallsBeforeSelection,
    'Choosing a refiner does not invoke it',
  );
  assert.equal(
    (await rpc('engine.identity', { id: agent.id })).model,
    refinerIdentity.model,
    'Refiner picker never switches the chat model',
  );
  const prefsAfterSelection = await call('prefs.get', {}, ['prefs.updated']);
  for (const key of ['refinerProvider', 'refinerModel', 'refinerFallbackProfile'])
    assert.equal(
      prefsAfterSelection[key],
      refinerPrefs[key],
      'Refiner selection never changes profile defaults',
    );
  await refine.getByRole('button', { name: 'Retry refinement', exact: true }).click();
  await refine
    .getByText(`Refined with ${refinerIdentity.provider} / alternate-refiner`, { exact: true })
    .waitFor();
  assert.ok(
    providerFixture.calls.some((call) => call.refiner && call.model === 'alternate-refiner'),
  );

  await call(
    'prefs.update',
    { fallbackModels: [`${refinerIdentity.provider}/alternate-refiner`] },
    ['key.operation_result'],
  );
  await (await optionsForRefiner())
    .getByLabel('Refiner provider', { exact: true })
    .fill('desktop-refiner-unavailable');
  await refine.getByRole('button', { name: 'Retry refinement', exact: true }).click();
  await refine
    .getByRole('alert')
    .filter({ hasText: 'Check the connection or choose another model' })
    .waitFor();
  const beforeFallback = providerFixture.calls.filter((call) => call.refiner).length;
  await page.screenshot({ path: join(artifactDir, 'native-refiner-recovery.png'), fullPage: true });
  assert.equal(
    await composer().inputValue(),
    '[native-composer-refine] Build the desktop composer.',
  );
  await refine
    .getByRole('button', {
      name: `Retry with ${refinerIdentity.provider}/alternate-refiner`,
      exact: true,
    })
    .click();
  await waitFor(
    async () =>
      !(await refine.getByRole('alert').count()) &&
      (await refine.getByRole('button', { name: 'Retry refinement', exact: true }).isEnabled()),
    'Explicit refiner fallback completion',
  );
  assert.ok(providerFixture.calls.filter((call) => call.refiner).length > beforeFallback);
  assert.equal((await rpc('engine.identity', { id: agent.id })).model, refinerIdentity.model);
  await refine.getByRole('button', { name: 'Use configured refiner', exact: true }).click();
  assert.equal(await refine.getByLabel('Refiner model', { exact: true }).inputValue(), '');
  await call('prefs.update', { fallbackModels: refinerPrefs.fallbackModels ?? [] }, [
    'key.operation_result',
  ]);
  await profileCall('provider.custom_models.remove', {
    providerId: refinerIdentity.provider,
    modelId: 'alternate-refiner',
  });
  console.log(
    'PASS: searchable per-request refiner, no selection-time completion/chat-model change, provider failure guidance and explicit actual-model fallback',
  );
  assert.equal(
    await refine.evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
    'Refinement dialog has no clipped horizontal content',
  );
  await page.screenshot({
    path: join(artifactDir, 'native-composer-refinement.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(
    await refine.evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
    'Compact refinement dialog fits its container',
  );
  await page.screenshot({
    path: join(artifactDir, 'native-composer-refinement-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await refine.getByRole('button', { name: 'Keep original draft', exact: true }).click();
  assert.equal(
    await composer().inputValue(),
    '[native-composer-refine] Build the desktop composer.',
    'Leaving refinement keeps the original',
  );
  await (await options()).getByRole('button', { name: 'Refine this draft', exact: true }).click();
  refine = page.getByRole('dialog', { name: 'Refine your prompt' });
  await waitFor(
    async () => await refine.getByRole('button', { name: 'English', exact: true }).isEnabled(),
    'English refinement version',
    120000,
  );
  await refine.getByRole('button', { name: 'English', exact: true }).click();
  await refine.getByRole('checkbox', { name: 'Edit this version', exact: true }).check();
  await refine
    .getByRole('textbox', { name: 'Edit refined prompt' })
    .fill(
      '[native-composer-refined-approved] Implement the desktop composer and preserve all session boundaries.',
    );
  // A completed, edited review survives a renderer reload without a new refiner request.
  const storedReview = () =>
    page.evaluate(
      (id) =>
        window.__TAURI_INTERNALS__.invoke('host_request', {
          method: 'draft.object',
          params: { id, part: 'refine' },
        }),
      agent.id,
    );
  await waitFor(
    async () =>
      (await storedReview()).value?.edited?.startsWith('[native-composer-refined-approved]'),
    'Refinement review saved natively',
  );
  const refinerCallsBeforeReload = providerFixture.calls.filter((call) => call.refiner).length;
  await page.reload();
  await composer().waitFor();
  await page.getByText(/is waiting for review/).waitFor();
  await page.getByRole('button', { name: 'Review refined prompt', exact: true }).click();
  refine = page.getByRole('dialog', { name: 'Refine your prompt' });
  assert.equal(
    await refine.getByRole('textbox', { name: 'Edit refined prompt' }).inputValue(),
    '[native-composer-refined-approved] Implement the desktop composer and preserve all session boundaries.',
  );
  assert.equal(
    await refine.getByRole('button', { name: 'English', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(
    providerFixture.calls.filter((call) => call.refiner).length,
    refinerCallsBeforeReload,
    'Restoring a review does not call the refiner again',
  );
  await refine.getByRole('button', { name: 'Approve & send', exact: true }).click();
  await waitFor(async () => {
    if ((await storedReview()).value === null) return true;
    const alert = refine.getByRole('alert');
    if (await alert.count())
      throw Error(`Restored review send failed: ${await alert.first().innerText()}`);
    return false;
  }, 'Sent review leaves storage');
  await refine.waitFor({ state: 'detached' });
  await waitFor(
    () =>
      providerFixture.calls.some(
        (c) => !c.refiner && c.composerPrompt.includes('[native-composer-refined-approved]'),
      ),
    'Approved refinement reaches the actual next turn',
  );
  await idle();
  assert.equal(await composer().inputValue(), '');
  await (await options())
    .getByRole('checkbox', { name: 'Refine before sending', exact: true })
    .check();
  await waitFor(
    async () => (await call('prefs.get', {}, ['prefs.updated'])).enhanceEnabled === true,
    'Automatic refinement enabled',
  );
  await page.locator('.composer-options').getByLabel('Composer options', { exact: true }).click();
  await send(
    '[native-composer-auto] Build the native composer with a clear model selector.',
    'queue',
  );
  refine = page.getByRole('dialog', { name: 'Refine your prompt' });
  await waitFor(
    async () => await refine.getByRole('button', { name: 'Refined', exact: true }).isEnabled(),
    'Automatic refinement preview',
    120000,
  );
  await refine.getByRole('button', { name: 'Original', exact: true }).click();
  await refine.getByRole('button', { name: 'Approve & send', exact: true }).click();
  await refine.waitFor({ state: 'detached' });
  await waitFor(
    () =>
      providerFixture.calls.some(
        (c) => !c.refiner && c.composerPrompt.includes('[native-composer-auto]'),
      ),
    'Original prompt approved from automatic refinement',
  );
  await idle();
  await (await options())
    .getByRole('checkbox', { name: 'Refine before sending', exact: true })
    .uncheck();
  await waitFor(
    async () => (await call('prefs.get', {}, ['prefs.updated'])).enhanceEnabled === false,
    'Automatic refinement preference restored',
  );
  await page.locator('.composer-options').getByLabel('Composer options', { exact: true }).click();
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'Compact composer does not overflow',
  );
  await page.screenshot({ path: join(artifactDir, 'native-composer-compact.png'), fullPage: true });
  await page.setViewportSize({ width: 1480, height: 960 });
  await page.getByRole('combobox', { name: 'Message delivery mode' }).selectOption('btw');
  await exerciseNativeTopicBoundary({
    page,
    rpc,
    agent,
    call,
    idle,
    waitFor,
    artifactDir,
    providerFixture,
  });
  console.log(
    'PASS: native model/effort, BTW without interrupt, persistent queue/reload/remove/drain, stop-and-steer, real bilingual refinement approval, draft retention and compact composer',
  );
}
