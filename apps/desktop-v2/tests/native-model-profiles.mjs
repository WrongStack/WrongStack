import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function exerciseNativeModelProfiles({
  getPage,
  rpc,
  waitFor,
  restart,
  artifactDir,
  wrongstackHome,
}) {
  const providerId = 'shared-profile-provider',
    modelId = 'shared/model';
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
      `Profile draft ${type}`,
      45000,
    );
    if (reply.success === false || reply.ok === false || typeof reply.error === 'string')
      throw Error(reply.error ?? reply.message);
    return reply;
  };
  const ipc = (method, params) =>
    getPage().evaluate(
      ({ method, params }) => window.__TAURI_INTERNALS__.invoke('host_request', { method, params }),
      { method, params },
    );
  const key = (profileId) =>
    'model-editor:' +
    createHash('sha256')
      .update(profileId ? JSON.stringify(['model-editor', profileId, providerId]) : providerId)
      .digest('hex');
  const draft = (profileId) => ipc('profile-draft.get', { formKey: key(profileId) });
  const put = (profileId, value, expectedRevision) =>
    ipc('profile-draft.save', { formKey: key(profileId), value, expectedRevision });
  const profile = async () => (await call('prefs.get')).profileIdentity;
  const config = async (name) =>
    JSON.parse(await readFile(join(wrongstackHome, 'profiles', name, 'config.json'), 'utf8'));
  const open = async () => {
    const page = getPage();
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'WrongStack settings', exact: true })
      .click();
    await waitFor(
      async () => (await rpc('profile.status')).status === 'running',
      'Selected profile engine ready',
      100000,
    );
    await page
      .getByRole('navigation', { name: 'WrongStack settings sections' })
      .getByRole('button', { name: 'Model catalog', exact: true })
      .click();
    const catalog = page.getByRole('region', { name: 'Model catalog settings', exact: true });
    await catalog.getByLabel('Catalog provider', { exact: true }).selectOption(providerId);
    return catalog;
  };
  const switchTo = async (name) => {
    const bootstrapPath = join(wrongstackHome, 'config.json');
    await restart(true, async () => {
      const bootstrap = JSON.parse(await readFile(bootstrapPath, 'utf8'));
      await writeFile(bootstrapPath, JSON.stringify({ ...bootstrap, activeProfile: name }));
    });
    offset = 0;
    const catalog = await open();
    return { catalog, profile: await profile() };
  };
  const before = await rpc('snapshot');
  await call('provider.add', {
    id: providerId,
    type: 'openai-compatible',
    family: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:9/v1',
    models: [modelId],
    customModels: {
      [modelId]: {
        name: 'Shared base model',
        modelsDev: { name: 'Shared base model', cost: { input: 1 } },
      },
    },
  });
  let catalog = await open();
  const first = await profile();
  assert.equal(first.name, 'default');
  assert.match(first.id, /^[a-f0-9]{64}$/);
  await catalog
    .locator('.model-catalog-list')
    .getByRole('button', { name: /Shared base model/ })
    .click();
  await catalog.getByRole('button', { name: 'Edit model definition', exact: true }).click();
  let editor = getPage().getByRole('dialog');
  await editor.getByLabel('Model display name', { exact: true }).fill('Profile A pending model');
  await waitFor(
    async () => (await draft(first.id)).value?.editor.draft.text.name === 'Profile A pending model',
    'Profile A draft acknowledged',
  );
  const firstDraft = await draft(first.id);
  assert.equal(firstDraft.value.profileId, first.id);
  assert.equal(
    firstDraft.value.profileName,
    'default',
    'Display name is recorded beside ownership',
  );
  const legacy = structuredClone(firstDraft.value);
  delete legacy.profileId;
  legacy.editor.draft.text.name = 'Earlier unassigned model';
  await put(undefined, legacy, (await draft()).revision);
  const secondDir = join(wrongstackHome, 'profiles', 'second');
  await mkdir(secondDir, { recursive: true });
  await writeFile(join(secondDir, 'config.json'), JSON.stringify(await config('default')));
  const next = await switchTo('second');
  catalog = next.catalog;
  const second = next.profile;
  assert.equal(second.name, 'second');
  assert.notEqual(second.id, first.id);
  assert.equal(
    await catalog.getByRole('button', { name: 'Continue saved model draft', exact: true }).count(),
    0,
    'The same provider in another real profile cannot restore profile A’s draft',
  );
  assert.equal((await draft(second.id)).value, null);
  assert.deepEqual(await draft(first.id), firstDraft);
  await catalog.getByRole('button', { name: 'Review unassigned model draft', exact: true }).click();
  const legacyNotice = catalog.getByRole('region', { name: 'Unassigned model draft', exact: true });
  await getPage().screenshot({
    path: join(artifactDir, 'native-model-profile-legacy-review.png'),
    fullPage: true,
  });
  await legacyNotice
    .getByRole('button', { name: 'Copy and review in this profile', exact: true })
    .click();
  editor = getPage().getByRole('dialog');
  await editor.getByLabel('Model display name', { exact: true }).waitFor();
  assert.equal(
    await editor.getByLabel('Model display name', { exact: true }).inputValue(),
    'Earlier unassigned model',
  );
  assert.equal((await draft(second.id)).value.profileId, second.id);
  assert.deepEqual(
    (await draft()).value,
    legacy,
    'Reviewed migration copies without deleting or rewriting the unassigned source',
  );
  assert.equal(
    (await config('second')).providers[providerId].customModels[modelId].modelsDev.name,
    'Shared base model',
    'Copy does not apply provider settings',
  );
  await editor.getByLabel('Model display name', { exact: true }).fill('Profile B applied model');
  await editor.getByRole('button', { name: 'Save model definition', exact: true }).click();
  await catalog.getByText('Model definition saved and verified.', { exact: true }).waitFor();
  assert.equal(
    (await config('second')).providers[providerId].customModels[modelId].modelsDev.name,
    'Profile B applied model',
  );
  assert.equal(
    (await config('default')).providers[providerId].customModels[modelId].modelsDev.name,
    'Shared base model',
  );
  assert.deepEqual(await draft(first.id), firstDraft);
  const back = await switchTo('default');
  catalog = back.catalog;
  assert.equal(back.profile.id, first.id);
  await catalog.getByRole('button', { name: 'Continue saved model draft', exact: true }).click();
  editor = getPage().getByRole('dialog');
  assert.equal(
    await editor.getByLabel('Model display name', { exact: true }).inputValue(),
    'Profile A pending model',
  );
  await getPage().screenshot({
    path: join(artifactDir, 'native-model-profile-owned-recovery.png'),
    fullPage: true,
  });
  await editor.getByRole('button', { name: 'Save model definition', exact: true }).click();
  await catalog.getByText('Model definition saved and verified.', { exact: true }).waitFor();
  assert.equal(
    (await config('default')).providers[providerId].customModels[modelId].modelsDev.name,
    'Profile A pending model',
  );
  assert.equal(
    (await config('second')).providers[providerId].customModels[modelId].modelsDev.name,
    'Profile B applied model',
  );
  await catalog.getByRole('button', { name: 'Review unassigned model draft', exact: true }).click();
  const source = await draft(),
    newer = structuredClone(source.value);
  newer.editor.draft.text.name = 'Newer unassigned draft';
  await put(undefined, newer, source.revision);
  await catalog
    .getByRole('button', { name: 'Discard unassigned model draft', exact: true })
    .click();
  await catalog
    .getByRole('alert')
    .filter({ hasText: 'The unassigned draft changed. Review its latest version before choosing.' })
    .waitFor();
  assert.deepEqual((await draft()).value, newer);
  await catalog
    .getByRole('button', { name: 'Discard unassigned model draft', exact: true })
    .click();
  await waitFor(
    async () => (await draft()).value === null,
    'Reviewed legacy removal is acknowledged',
  );
  assert.equal((await draft(first.id)).value, null);
  assert.equal((await draft(second.id)).value, null);
  const administration = await exerciseDraftAdministration({
    getPage,
    catalog,
    ipc,
    waitFor,
    artifactDir,
    first,
    second,
    template: firstDraft.value,
    config: () => config('default'),
  });
  const after = await rpc('snapshot');
  assert.deepEqual(
    after.sessions.map((row) => row.id),
    before.sessions.map((row) => row.id),
  );
  await writeFile(
    join(artifactDir, 'native-model-profile-proof.json'),
    JSON.stringify(
      {
        first,
        second,
        sameProvider: providerId,
        namespaceIsolation: true,
        profileFileIsolation: true,
        explicitLegacyCopy: true,
        staleLegacyDeleteRefused: true,
        administration,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: actual bootstrap-selected profile isolation through cold restarts, same-provider native drafts, separate model config writes, explicit legacy copy, revision-protected legacy removal and saved-draft administration',
  );
  return { first, second };
}

/** Drafts the provider editor cannot reach: removed connections, other profiles, forged owners. */
async function exerciseDraftAdministration({
  getPage,
  catalog,
  ipc,
  waitFor,
  artifactDir,
  first,
  second,
  template,
  config,
}) {
  const keyFor = (profileId, provider) =>
    'model-editor:' +
    createHash('sha256')
      .update(JSON.stringify(['model-editor', profileId, provider]))
      .digest('hex');
  const get = (formKey) => ipc('profile-draft.get', { formKey });
  const seed = async (formKey, patch, label) => {
    const value = structuredClone(template);
    Object.assign(value, patch);
    value.editor.draft.id = label;
    await ipc('profile-draft.save', {
      formKey,
      value,
      expectedRevision: (await get(formKey)).revision,
    });
    return formKey;
  };
  const orphan = await seed(
    keyFor(first.id, 'removed-connection'),
    { providerId: 'removed-connection', profileId: first.id, profileName: 'default' },
    'orphaned-model',
  );
  const foreign = await seed(
    keyFor(second.id, 'shared-profile-provider'),
    { providerId: 'shared-profile-provider', profileId: second.id, profileName: 'second' },
    'second-profile-model',
  );
  // Claims profile A but is stored under another owner's key: never trusted or loaded.
  const forged = await seed(
    keyFor(second.id, 'forged-connection'),
    { providerId: 'forged-connection', profileId: first.id, profileName: 'default' },
    'forged-model',
  );
  const configBefore = await config();
  const listed = await ipc('profile-draft.list', {});
  assert.equal(listed.truncated, false);
  const summary = listed.drafts.find((row) => row.formKey === orphan);
  assert.equal(summary.modelId, 'orphaned-model');
  assert.ok(!JSON.stringify(listed).includes('Profile A pending model'), 'Listing omits bodies');
  await catalog.getByRole('button', { name: 'Saved drafts', exact: true }).click();
  const dialog = getPage().getByRole('dialog', { name: 'Saved model drafts' });
  const group = (name) => dialog.getByRole('region', { name, exact: true });
  await group('Connection removed').getByText('orphaned-model', { exact: true }).waitFor();
  await group('Another profile').getByText('second-profile-model', { exact: true }).waitFor();
  await group('Another profile')
    .getByText(/second \(name when saved\)/)
    .waitFor();
  await group('Unrecognized draft').getByText('forged-model', { exact: true }).waitFor();
  await group('Unrecognized draft')
    .getByText(/Owner not verified/)
    .waitFor();
  assert.equal(
    await group('This profile').count(),
    0,
    'A forged envelope is not presented as owned by this profile',
  );
  await getPage().screenshot({
    path: join(artifactDir, 'native-model-draft-administration.png'),
    fullPage: true,
  });
  // A peer window rewrites the orphan after it was listed; the old listing cannot erase it.
  const listedOrphan = await get(orphan),
    newer = structuredClone(listedOrphan.value);
  newer.editor.draft.text.name = 'Newer orphan edit';
  await ipc('profile-draft.save', {
    formKey: orphan,
    value: newer,
    expectedRevision: listedOrphan.revision,
  });
  const discard = async (name) => {
    const row = group(name).getByRole('listitem');
    await row.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await row.getByRole('button', { name: 'Confirm discard', exact: true }).click();
  };
  await discard('Connection removed');
  await dialog
    .getByRole('alert')
    .filter({ hasText: 'This draft changed after it was listed. Refresh and review it again.' })
    .waitFor();
  assert.deepEqual((await get(orphan)).value, newer, 'Stale discard kept the newer peer draft');
  await discard('Connection removed');
  await waitFor(async () => (await get(orphan)).value === null, 'Orphan discard acknowledged');
  await discard('Another profile');
  await waitFor(async () => (await get(foreign)).value === null, 'Foreign discard acknowledged');
  await discard('Unrecognized draft');
  await waitFor(async () => (await get(forged)).value === null, 'Forged discard acknowledged');
  await dialog.getByText('No unfinished model drafts are saved.', { exact: true }).waitFor();
  assert.deepEqual(
    await config(),
    configBefore,
    'Draft administration never writes provider config',
  );
  await dialog.getByRole('button', { name: 'Close saved model drafts', exact: true }).click();
  return {
    orphanedDiscarded: true,
    otherProfileDiscarded: true,
    forgedOwnerUnverified: true,
    staleListingDiscardRefused: true,
    providerConfigUnchanged: true,
  };
}
