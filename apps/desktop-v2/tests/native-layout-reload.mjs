import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Gate the WebView's 400 ms timers while lazy loading and normal IPC continue. */
export async function exerciseNativeLayoutReload({
  page,
  rpc,
  projects,
  waitFor,
  artifactDir,
  sessionIds,
}) {
  const checks = [];
  const agents = [];
  const pass = (text) => {
    checks.push(text);
    console.log('PASS: ' + text);
  };
  const composer = () => page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  const selectedTitle = () => page.locator('.active-session-tab .session-tab-label').textContent();
  const savedLayout = async () => JSON.parse((await rpc('snapshot')).layout ?? '{}');
  const show = async (agent) => {
    await page.locator('.tree-session').filter({ hasText: agent.title }).dispatchEvent('click');
    await page.locator(`[data-engine-session="${agent.identity.sessionId}"]`).waitFor();
    await composer().waitFor();
  };
  for (const [index, project] of projects.entries()) {
    const agent = await rpc('session.open', {
      projectId: project.id,
      kind: 'agent',
      title: `Reload ${index ? 'Beta' : 'Alpha'}`,
    });
    sessionIds.push(agent.id);
    const identity = await waitFor(
      async () => {
        const row = (await rpc('snapshot')).sessions.find((item) => item.id === agent.id);
        if (row?.status === 'error') throw Error(row.error);
        if (row?.status !== 'running') return null;
        const value = await rpc('engine.identity', { id: agent.id });
        return value.sessionId ? value : null;
      },
      agent.title + ' ready',
      100000,
    );
    const draft = `Private ${agent.title} draft — never send this.`;
    await page.evaluate(
      (params) =>
        window.__TAURI_INTERNALS__.invoke('host_request', { method: 'draft.save', params }),
      { id: agent.id, text: draft, expectedRevision: 0 },
    );
    agents.push({ ...agent, identity, draft });
  }
  const [alpha, beta] = agents;
  // Pausing every timer also freezes React's lazy-workspace reveal. Hold only the debounce
  // duration, with cancellable handles, and replay the same clock seam before scripts on reload.
  await page.addInitScript(() => {
    const key = 'native-fixture:hold-layout-debounce';
    const schedule = window.setTimeout.bind(window);
    const cancel = window.clearTimeout.bind(window);
    const held = new Map();
    let handle = -1;
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 400 && typeof callback === 'function' && sessionStorage.getItem(key)) {
        const id = handle--;
        held.set(id, () => callback(...args));
        return id;
      }
      return schedule(callback, delay, ...args);
    };
    window.clearTimeout = (id) => {
      if (!held.delete(id)) cancel(id);
    };
    window.__nativeLayoutClock = {
      count: () => held.size,
      hold: () => sessionStorage.setItem(key, '1'),
      release: () => {
        sessionStorage.removeItem(key);
        for (const callback of held.values()) schedule(callback, 0);
        held.clear();
      },
    };
  });
  await page.reload();
  await page.getByRole('status', { name: 'Local engine connected', exact: true }).waitFor();
  await show(alpha);
  await waitFor(async () => (await composer().inputValue()) === alpha.draft, 'Alpha draft');
  await show(beta);
  await waitFor(async () => (await composer().inputValue()) === beta.draft, 'Beta draft');
  await waitFor(async () => (await savedLayout()).selected === beta.id, 'Acknowledged Beta layout');
  await page.reload();
  await composer().waitFor();
  await waitFor(async () => (await composer().inputValue()) === beta.draft, 'Acknowledged control');
  assert.equal(await selectedTitle(), beta.title);
  pass('A host-acknowledged selection reloads with its own native draft');

  const receipt = { checks, agents, hostBefore: await savedLayout() };
  try {
    await page.evaluate(() => window.__nativeLayoutClock.hold());
    await show(alpha);
    await waitFor(
      async () => (await composer().inputValue()) === alpha.draft,
      'Selected Alpha draft',
    );
    assert.equal(await selectedTitle(), alpha.title);
    assert.equal((await savedLayout()).selected, beta.id, 'The real host debounce is still held');
    assert.ok(await page.evaluate(() => window.__nativeLayoutClock.count() > 0));
    receipt.pendingBefore = await page.evaluate(() =>
      Object.fromEntries(
        Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]),
      ),
    );
    // No elapsed-time race: the real layout callback stays behind the explicit clock barrier.
    await page.reload();
    await page.getByRole('status', { name: 'Local engine connected', exact: true }).waitFor();
    await composer().waitFor();
    await waitFor(async () => !!(await composer().inputValue()), 'Restored native draft');
    receipt.selectedAfter = await selectedTitle();
    receipt.draftAfter = await composer().inputValue();
    receipt.hostWhilePaused = await savedLayout();
    assert.ok(await page.evaluate(() => window.__nativeLayoutClock.count() > 0));
    assert.equal(receipt.hostWhilePaused.selected, beta.id, 'The host still contains the control');
    assert.equal(
      receipt.selectedAfter,
      alpha.title,
      'Reload restores the visible, unacknowledged selection',
    );
    assert.equal(receipt.draftAfter, alpha.draft, 'Alpha keeps its own unsent native draft');
    pass(
      'Reload before host persistence restores Alpha and its draft while the host still selects Beta',
    );
  } finally {
    await writeFile(
      join(artifactDir, 'layout-reload-receipt.json'),
      JSON.stringify(receipt, null, 2),
    );
    await page.evaluate(() => window.__nativeLayoutClock.release());
  }
  await waitFor(
    async () => (await savedLayout()).selected === alpha.id,
    'Recovered selection persisted',
  );
  await show(beta);
  await waitFor(
    async () => (await composer().inputValue()) === beta.draft,
    'Beta draft remains intact',
  );
  await page.setViewportSize({ width: 800, height: 600 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(artifactDir, 'native-layout-reload.png'), fullPage: true });
  pass(
    'Recovered state persists to the host, the other draft remains intact, and 800×600 CSS fits',
  );
  await writeFile(
    join(artifactDir, 'layout-reload-receipt.json'),
    JSON.stringify(receipt, null, 2),
  );
}
