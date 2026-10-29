import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureModel } from './local-provider.mjs';

export async function exerciseNativeSessionAgentPlan({
  page,
  rpc,
  agent,
  call,
  waitFor,
  artifactDir,
  configPath,
}) {
  const input = () => page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  const dialog = () => page.getByRole('dialog', { name: 'Agent model plan', exact: true });
  const original = await call('prefs.get', {}, ['prefs.updated']);
  const originalPlan = original.subagentModelPlan ?? {
    enabled: true,
    lock: true,
    followSessionModel: false,
    slots: Array.from({ length: 8 }, () => ({})),
  };
  const seed = {
    enabled: true,
    lock: true,
    followSessionModel: false,
    slots: [
      {
        provider: 'desktop-local',
        model: fixtureModel,
        label: 'Build lane',
        modelRuntime: { reasoning: { effort: 'high' } },
      },
      { tier: 'native-demo-tier', label: 'Analysis lane' },
      { fallbackProfile: 'native-demo-profile' },
    ],
    roles: {
      reviewer: {
        provider: 'desktop-local',
        model: fixtureModel,
        modelRuntime: { reasoning: { effort: 'low', preserve: true } },
      },
    },
  };
  const config = await readFile(configPath, 'utf8');
  const sessions = (await rpc('snapshot')).sessions.map((session) => session.id);
  const draft = await input().inputValue();
  const marker = '[native-agent-plan-draft] Keep this local chat draft.';
  const open = async () => {
    const options = page.locator('.composer-options');
    if (!(await options.evaluate((element) => element.open)))
      await options.getByLabel('Composer options', { exact: true }).click();
    await options.getByRole('button', { name: 'Agent model plan', exact: true }).click();
    await dialog().getByRole('spinbutton', { name: 'Model lane count', exact: true }).waitFor();
  };
  const save = async () => {
    await dialog().getByRole('button', { name: 'Save session plan', exact: true }).click();
    await dialog()
      .getByRole('status')
      .filter({ hasText: 'Model plan saved and verified' })
      .waitFor();
  };
  const humanFrames = async () => {
    let offset = 0,
      count = 0;
    for (;;) {
      const batch = await rpc('engine.events', { id: agent.id, offset });
      count += batch.events.filter((event) => event.type === 'desktop.user_message').length;
      if (!batch.events.length || batch.offset === offset) return count;
      offset = batch.offset;
    }
  };
  const messages = await humanFrames();
  await call('prefs.update', { subagentModelPlan: seed }, ['key.operation_result']);
  try {
    await input().fill(marker);
    await open();
    assert.equal(
      await dialog()
        .getByRole('spinbutton', { name: 'Model lane count', exact: true })
        .inputValue(),
      '3',
    );
    await dialog().getByLabel('Lane 1 label', { exact: true }).fill('Build lane edited');
    const first = dialog()
      .locator('.agent-plan-route')
      .filter({ has: page.locator('legend', { hasText: /^Lane 1$/ }) });
    await first.locator('summary').click();
    await dialog().getByLabel('Lane 1 reasoning effort', { exact: true }).selectOption('xhigh');
    await dialog().getByLabel('Lane 2 model source', { exact: true }).selectOption('model');
    const picker = page.getByRole('dialog', { name: 'Choose lane 2 model', exact: true });
    await picker.locator('.composer-model-list button').filter({ hasText: fixtureModel }).click();
    await picker.waitFor({ state: 'hidden' });
    assert.equal(
      (await call('prefs.get', {}, ['prefs.updated'])).subagentModelPlan.slots[1].tier,
      'native-demo-tier',
      'Picker edits are local until Save',
    );
    await save();
    let actual = (await call('prefs.get', {}, ['prefs.updated'])).subagentModelPlan;
    assert.equal(actual.slots[0].modelRuntime.reasoning.effort, 'xhigh');
    assert.deepEqual(actual.slots[1], {
      provider: 'desktop-local',
      model: fixtureModel,
      label: 'Analysis lane',
    });
    assert.deepEqual(actual.roles, seed.roles);
    await dialog().evaluate((element) => {
      element.scrollTop = 0;
    });
    assert.equal(
      await dialog().evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.top >= 0 && bounds.bottom <= innerHeight;
      }),
      true,
      'Plan dialog fits vertically',
    );
    await page.screenshot({
      path: join(artifactDir, 'native-session-agent-plan.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 800, height: 640 });
    assert.equal(
      await dialog().evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.top >= 0 && bounds.bottom <= innerHeight;
      }),
      true,
      'Compact plan dialog fits vertically',
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: join(artifactDir, 'native-session-agent-plan-compact.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1480, height: 960 });
    await dialog()
      .getByLabel('Follow the session model for plain workers', { exact: true })
      .check();
    assert.equal(await dialog().getByLabel('Lane 1 label', { exact: true }).isEnabled(), false);
    await save();
    actual = (await call('prefs.get', {}, ['prefs.updated'])).subagentModelPlan;
    assert.equal(actual.followSessionModel, true);
    assert.equal(actual.slots[1].model, fixtureModel, 'Following retains lane pins');
    await dialog()
      .getByLabel('Follow the session model for plain workers', { exact: true })
      .uncheck();
    await dialog().getByRole('spinbutton', { name: 'Model lane count', exact: true }).fill('1');
    await dialog().getByRole('button', { name: 'Keep lanes', exact: true }).click();
    assert.equal(
      await dialog()
        .getByRole('spinbutton', { name: 'Model lane count', exact: true })
        .inputValue(),
      '3',
    );
    await dialog().getByRole('spinbutton', { name: 'Model lane count', exact: true }).fill('1');
    await dialog().getByRole('button', { name: 'Remove extra lanes', exact: true }).click();
    await dialog().getByLabel('New session role', { exact: true }).fill('architect');
    await dialog().getByRole('button', { name: 'Add role', exact: true }).click();
    await save();
    actual = (await call('prefs.get', {}, ['prefs.updated'])).subagentModelPlan;
    assert.equal(actual.slots.length, 1);
    assert.deepEqual(actual.roles.reviewer, seed.roles.reviewer);
    assert.equal(actual.roles.architect.modelRuntime.reasoning.mode, 'auto');
    await dialog().getByLabel('Lane 1 label', { exact: true }).fill('Keep competing local edit');
    const peer = { ...actual, lock: false };
    await call('prefs.update', { subagentModelPlan: peer }, ['key.operation_result']);
    await dialog().getByRole('button', { name: 'Save session plan', exact: true }).click();
    await dialog().getByRole('alert').filter({ hasText: 'changed elsewhere' }).waitFor();
    assert.equal(
      await dialog().getByLabel('Lane 1 label', { exact: true }).inputValue(),
      'Keep competing local edit',
    );
    assert.deepEqual((await call('prefs.get', {}, ['prefs.updated'])).subagentModelPlan, peer);
    await dialog().getByRole('button', { name: 'Reload saved plan', exact: true }).click();
    await dialog().getByRole('button', { name: 'Keep editing plan', exact: true }).click();
    assert.equal(
      await dialog().getByLabel('Lane 1 label', { exact: true }).inputValue(),
      'Keep competing local edit',
    );
    await dialog().getByRole('button', { name: 'Reload saved plan', exact: true }).click();
    await dialog().getByRole('button', { name: 'Discard plan and reload', exact: true }).click();
    await waitFor(
      async () =>
        (await dialog().getByLabel('Lane 1 label', { exact: true }).inputValue()) ===
        'Build lane edited',
      'Explicit plan reload',
    );
    assert.equal(
      await dialog()
        .getByLabel('User model pins override leader choices', { exact: true })
        .isChecked(),
      false,
    );
    await dialog().getByRole('button', { name: 'Close agent model plan', exact: true }).click();
    await waitFor(
      async () =>
        (
          await page.evaluate(
            (id) =>
              window.__TAURI_INTERNALS__.invoke('host_request', {
                method: 'draft.get',
                params: { id },
              }),
            agent.id,
          )
        ).text === marker,
      'Session plan preserves persisted chat draft',
    );
    await page.reload();
    await input().waitFor();
    assert.equal(await input().inputValue(), marker);
    await open();
    assert.equal(
      await dialog()
        .getByRole('spinbutton', { name: 'Model lane count', exact: true })
        .inputValue(),
      '1',
    );
    assert.equal(
      await dialog()
        .getByLabel('User model pins override leader choices', { exact: true })
        .isChecked(),
      false,
    );
    // Unsaved plan edits are kept in native session storage across a renderer reload.
    const storedPlan = () =>
      page.evaluate(
        (id) =>
          window.__TAURI_INTERNALS__.invoke('host_request', {
            method: 'draft.object',
            params: { id, part: 'plan' },
          }),
        agent.id,
      );
    await dialog().getByLabel('Lane 1 label', { exact: true }).fill('Unsaved across reload');
    await waitFor(
      async () => (await storedPlan()).value?.plan?.slots?.[0]?.label === 'Unsaved across reload',
      'Plan draft saved natively',
    );
    await page.reload();
    await input().waitFor();
    await open();
    await dialog()
      .getByText(/Restored your unsaved model plan draft/)
      .waitFor();
    assert.equal(
      await dialog().getByLabel('Lane 1 label', { exact: true }).inputValue(),
      'Unsaved across reload',
    );
    // A draft edited from an older plan is offered, never applied silently.
    const changed = (await call('prefs.get', {}, ['prefs.updated'])).subagentModelPlan;
    await call('prefs.update', { subagentModelPlan: { ...changed, lock: true } }, [
      'key.operation_result',
    ]);
    await page.reload();
    await input().waitFor();
    await open();
    await dialog().getByRole('alert').filter({ hasText: 'edited from an older version' }).waitFor();
    assert.equal(
      await dialog().getByLabel('Lane 1 label', { exact: true }).inputValue(),
      'Build lane edited',
      'The current plan is shown until the older draft is chosen',
    );
    await dialog().getByRole('button', { name: 'Discard saved draft', exact: true }).click();
    await waitFor(async () => (await storedPlan()).value === null, 'Discarded plan draft cleared');
    await dialog().getByRole('button', { name: 'Close agent model plan', exact: true }).click();
    assert.equal(
      await readFile(configPath, 'utf8'),
      config,
      'Session model plans never write profile config',
    );
    assert.equal(await humanFrames(), messages, 'Plan edits create no human turns');
    assert.deepEqual(
      (await rpc('snapshot')).sessions.map((session) => session.id),
      sessions,
    );
    await page
      .getByRole('button', { name: 'Choose session model', exact: true })
      .filter({ hasText: fixtureModel })
      .waitFor();
  } finally {
    if (await dialog().count()) {
      await page.keyboard.press('Escape');
      if (
        await dialog().getByRole('button', { name: 'Discard plan and close', exact: true }).count()
      )
        await dialog().getByRole('button', { name: 'Discard plan and close', exact: true }).click();
    }
    await call('prefs.update', { subagentModelPlan: originalPlan }, ['key.operation_result']);
    await call('prefs.get', {}, ['prefs.updated']);
    if (await input().count()) await input().fill(draft);
  }
  console.log(
    'PASS: session-only lane/role models, explicit save/readback, retained runtime metadata, following/lock, shrink review, stale-write refusal, reload/draft preservation and unchanged profile/chat model without human turns or extra sessions',
  );
}
