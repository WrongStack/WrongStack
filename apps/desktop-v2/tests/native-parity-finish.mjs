import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Real Tauri controls, profile disk writes and retained collaboration socket recovery. */
export async function exerciseNativeParityFinish({
  page,
  rpc,
  project,
  waitFor,
  artifactDir,
  configPath,
  sessionIds,
  providerFixture,
}) {
  const streamCount = () => providerFixture.calls.filter((call) => call.stream).length;
  const beforeCalls = streamCount(),
    beforeSessions = (await rpc('snapshot')).sessions.length;
  const initialConfig = JSON.parse(await readFile(configPath, 'utf8'));
  const settings = async () => {
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'WrongStack settings', exact: true })
      .click();
    await page
      .getByRole('navigation', { name: 'WrongStack settings sections' })
      .getByRole('button', { name: 'Terminal display', exact: true })
      .click();
    await page.getByRole('switch', { name: 'CLI title animation', exact: true }).waitFor();
  };
  const toggle = async (name, value) => {
    const control = page.getByRole('switch', { name, exact: true });
    if ((await control.getAttribute('aria-checked')) !== String(value)) await control.click();
    assert.equal(await control.getAttribute('aria-checked'), String(value));
  };
  const save = async (patch) => {
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'saved to your active profile' }).waitFor();
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(saved.autonomy.terminalTitleAnimation, patch.titleAnimation);
    assert.equal(saved.autonomy.showAgentSwarmPanel, patch.showAgentSwarmPanel);
    assert.equal(saved.autonomy.confirmExit, patch.confirmExit);
    assert.deepEqual(
      saved.features,
      initialConfig.features,
      'CLI preferences retain unrelated profile features',
    );
  };
  for (const patch of [
    { titleAnimation: false, showAgentSwarmPanel: 'sidebar', confirmExit: false },
    { titleAnimation: true, showAgentSwarmPanel: 'off', confirmExit: true },
    { titleAnimation: true, showAgentSwarmPanel: 'bottom', confirmExit: true },
  ]) {
    await settings();
    await toggle('CLI title animation', patch.titleAnimation);
    await toggle('CLI exit confirmation', patch.confirmExit);
    await page
      .getByRole('combobox', { name: 'CLI agent swarm panel', exact: true })
      .selectOption(patch.showAgentSwarmPanel);
    await save(patch);
    await page.reload();
    await settings();
    assert.equal(
      await page
        .getByRole('switch', { name: 'CLI title animation', exact: true })
        .getAttribute('aria-checked'),
      String(patch.titleAnimation),
    );
    assert.equal(
      await page
        .getByRole('switch', { name: 'CLI exit confirmation', exact: true })
        .getAttribute('aria-checked'),
      String(patch.confirmExit),
    );
    assert.equal(
      await page.getByRole('combobox', { name: 'CLI agent swarm panel', exact: true }).inputValue(),
      patch.showAgentSwarmPanel,
    );
  }
  assert.equal(
    (await rpc('snapshot')).sessions.length,
    beforeSessions,
    'Profile controls create no conversations',
  );
  assert.equal(streamCount(), beforeCalls, 'CLI preference changes start no completion');
  await page
    .getByRole('switch', { name: 'CLI title animation', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifactDir, 'native-cli-preferences.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 680 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-cli-preferences-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });

  const session = await rpc('session.open', {
    projectId: project.id,
    kind: 'agent',
    title: 'Native collaboration reload',
  });
  sessionIds.push(session.id);
  const identity = await waitFor(
    async () => {
      const value = await rpc('engine.identity', { id: session.id });
      return value.sessionId ? value : null;
    },
    'Native collaboration identity',
    100000,
  );
  await page.locator('.tree-session').filter({ hasText: 'Native collaboration reload' }).click();
  const composer = () => page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  await composer().waitFor({ timeout: 60000 });
  const draft = 'Preserve this native collaboration draft.';
  await composer().fill(draft);
  const savedDraft = () =>
    page.evaluate(
      (id) =>
        window.__TAURI_INTERNALS__.invoke('host_request', { method: 'draft.get', params: { id } }),
      session.id,
    );
  await waitFor(
    async () => (await savedDraft()).text === draft,
    'Collaboration composer draft saved',
  );
  const activity = async () => {
    if (
      await page
        .locator('.session-collab')
        .isVisible()
        .catch(() => false)
    )
      return;
    await page
      .getByRole('navigation', { name: 'Agent workspace views' })
      .getByRole('button', { name: 'Tools', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Session tools', exact: true })
      .getByRole('button')
      .filter({ hasText: 'Run activity' })
      .click();
    await page.locator('.session-collab').waitFor({ timeout: 60000 });
  };
  const panel = () => page.locator('.session-collab');
  await activity();
  await panel().getByRole('button', { name: 'Observer', exact: true }).click();
  await panel().getByText('1 observer', { exact: true }).waitFor();
  const hostPid = (await rpc('snapshot')).hostPid;
  await waitFor(
    async () => JSON.parse((await rpc('snapshot')).layout || '{}').selected === session.id,
    'Collaboration selected layout saved',
  );
  await new Promise((resolve) => setTimeout(resolve, 1200)); // The prior live frame must be older than the adapter's skew.
  await page.reload();
  await activity();
  assert.equal((await rpc('snapshot')).hostPid, hostPid, 'Renderer reload retains native host');
  assert.equal((await rpc('engine.identity', { id: session.id })).sessionId, identity.sessionId);
  await panel().getByRole('button', { name: 'Observer', exact: true }).click();
  await panel()
    .getByText(/requires leaving the current session first/)
    .waitFor();
  const beforeLeave = await rpc('engine.events', { id: session.id, offset: 0 });
  assert.equal(
    beforeLeave.events.filter((event) => event.type === 'collab.participant.left').length,
    0,
    'Join refusal never implicitly leaves',
  );
  await panel().getByRole('button', { name: 'Leave', exact: true }).click();
  await panel().getByText('No live observers', { exact: true }).waitFor();
  await panel().getByRole('button', { name: 'Observer', exact: true }).click();
  await panel().getByText('1 observer', { exact: true }).waitFor();
  await page.screenshot({
    path: join(artifactDir, 'native-collaboration-recovered.png'),
    fullPage: true,
  });
  await panel().getByRole('button', { name: 'Leave', exact: true }).click();
  await panel().getByRole('button', { name: 'Controller', exact: true }).click();
  await panel()
    .getByText(/requires explicit server authorization/)
    .waitFor();
  await panel().getByRole('button', { name: 'Leave', exact: true }).click();
  await panel().getByText('No live observers', { exact: true }).waitFor();
  await page
    .getByRole('navigation', { name: 'Agent workspace views' })
    .getByRole('button', { name: 'Chat', exact: true })
    .click();
  await composer().waitFor();
  assert.equal(await composer().inputValue(), draft);
  assert.equal((await savedDraft()).text, draft);
  assert.equal(streamCount(), beforeCalls, 'Collaboration actions never start a model or leader');
  console.log(
    'PASS: native CLI/TUI preference controls, all placement values, boolean save/readback/disk/reload, compact layout, no conversations/completions; retained host collaboration membership after renderer reload, explicit leave/rejoin, unauthorized role refusal and preserved composer draft',
  );
  return {
    cliPreferences: true,
    collaborationReloadRecovery: true,
    explicitLeave: true,
    roleRefusal: true,
    preservedDraft: true,
    noModelRun: true,
  };
}
