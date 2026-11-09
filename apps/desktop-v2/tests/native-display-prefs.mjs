import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Native persisted controls + recorded activity visualization; no model/tool execution is claimed. */
export async function exerciseNativeDisplayPrefs({
  page,
  rpc,
  project,
  waitFor,
  artifactDir,
  sessionIds,
  nativeDataDir,
  providerFixture,
}) {
  const before = providerFixture.calls.filter((call) => call.stream).length;
  const settings = async () => {
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Appearance', exact: true })
      .click();
    await page.getByRole('region', { name: 'Conversation display', exact: true }).waitFor();
  };
  const controls = () => page.getByRole('region', { name: 'Conversation display', exact: true });
  const set = async (label, value) => {
    await controls().getByRole('checkbox', { name: label, exact: false }).setChecked(value);
  };
  const saved = async (values) =>
    waitFor(async () => {
      const appearance = JSON.parse((await rpc('snapshot')).appearance ?? '{}');
      return Object.entries(values).every(([key, value]) => appearance[key] === value);
    }, 'Display choices saved in native appearance');
  await settings();
  await set('Show thinking logs', false);
  await set('Group tool calls', false);
  await set('Auto-collapse input under history', true);
  await set('Keyboard shortcuts', false);
  await saved({
    showThinkingLogs: false,
    groupToolCalls: false,
    autoCollapseInput: true,
    keyboardShortcuts: false,
  });
  await page.evaluate(
    (id) => window.__TAURI_INTERNALS__.invoke('open_project_window', { id }),
    project.id,
  );
  const peer = await waitFor(
    () =>
      page
        .context()
        .pages()
        .find((candidate) => candidate !== page && candidate.url().includes(project.id)),
    'Second native preference window',
    60000,
  );
  const peerErrors = [];
  peer.on('pageerror', (error) => peerErrors.push(String(error)));
  await peer
    .getByRole('status', { name: 'Local engine connected', exact: true })
    .waitFor({ timeout: 60000 });
  await peer
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Appearance', exact: true })
    .click();
  const peerControls = peer.getByRole('region', { name: 'Conversation display', exact: true });
  await peerControls.waitFor();
  assert.equal(
    await peerControls
      .getByRole('checkbox', { name: 'Keyboard shortcuts', exact: false })
      .isChecked(),
    false,
  );
  assert.equal(
    await peerControls
      .getByRole('checkbox', { name: 'Show thinking logs', exact: false })
      .isChecked(),
    false,
  );
  const session = await rpc('session.open', {
    projectId: project.id,
    kind: 'agent',
    title: 'Native display controls',
  });
  sessionIds.push(session.id);
  const open = async () => {
    await page.locator('.tree-session').filter({ hasText: 'Native display controls' }).click();
  };
  await open();
  const identity = await waitFor(
    async () => {
      const value = await rpc('engine.identity', { id: session.id });
      return value.sessionId ? value : null;
    },
    'Display fixture identity',
    60000,
  );
  // A test-owned journal boundary fixture exercises the actual native reducer and rendering.
  const frame = (type, payload) => ({
    type,
    at: Date.now(),
    payload: { sessionId: identity.sessionId, ...payload },
  });
  await appendFile(
    join(nativeDataDir, 'transcripts', session.id + '.events.jsonl'),
    [
      frame('provider.thinking_delta', { text: 'Recorded display reasoning' }),
      frame('tool.started', { id: 'display-tool', name: 'read', input: { path: 'README.md' } }),
      frame('tool.executed', {
        id: 'display-tool',
        name: 'read',
        ok: true,
        output: 'Recorded display tool evidence',
      }),
      frame('provider.text_delta', {
        messageId: 'display-answer',
        text: 'Recorded display answer',
      }),
      frame('run.result', { status: 'done', finalText: 'Recorded display answer' }),
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n',
  );
  const expand = () => page.getByRole('button', { name: 'Expand input', exact: true });
  await expand().waitFor({ timeout: 60000 });
  assert.equal(
    await page.getByRole('textbox', { name: 'Message WrongStack', exact: true }).count(),
    0,
  );
  const transcript = page.locator('.native-chat-messages');
  await waitFor(
    async () => (await transcript.textContent()).includes('Recorded display tool evidence'),
    'Individual recorded tool entry',
  );
  assert.equal(
    await transcript.locator('.chat-run-activity').count(),
    0,
    'Ungrouped tools have no turn-level collapse wrapper',
  );
  assert.equal((await transcript.textContent()).includes('Recorded display reasoning'), false);
  const tool = transcript
    .locator('.activity-entry')
    .filter({ hasText: 'Recorded display tool evidence' });
  await tool.locator(':scope > summary').click();
  await tool.getByText('Recorded display tool evidence', { exact: true }).first().waitFor();
  const chat = () =>
    page
      .getByRole('navigation', { name: 'Agent workspace views' })
      .getByRole('button', { name: 'Chat', exact: true });
  await chat().click();
  await page.keyboard.press('Control+/');
  assert.equal(await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'), false);
  await page.keyboard.press('Control+k');
  assert.equal(
    await page.getByRole('dialog').count(),
    0,
    'Disabled global shortcut does not open the palette',
  );
  await page.keyboard.press('Control+f');
  await page.locator('input[data-find-input="conversation"]').waitFor();
  await page.keyboard.press('Escape');
  await settings();
  await set('Show thinking logs', true);
  await set('Group tool calls', true);
  await set('Keyboard shortcuts', true);
  await saved({ showThinkingLogs: true, groupToolCalls: true, keyboardShortcuts: true });
  await waitFor(
    async () =>
      (await peerControls
        .getByRole('checkbox', { name: 'Keyboard shortcuts', exact: false })
        .isChecked()) &&
      (await peerControls
        .getByRole('checkbox', { name: 'Show thinking logs', exact: false })
        .isChecked()),
    'Appearance update propagates to the second window',
  );
  await open();
  await transcript.locator('.chat-run-activity').first().locator(':scope > summary').click();
  const reasoning = transcript
    .locator('.activity-entry')
    .filter({ hasText: 'Recorded display reasoning' });
  await reasoning.locator(':scope > summary').click();
  await reasoning.getByText('Recorded display reasoning', { exact: true }).first().waitFor();
  await chat().click();
  await page.keyboard.press('Control+/');
  const input = page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  await input.waitFor();
  await waitFor(
    () => page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'),
    'Enabled shortcut expands and focuses composer',
  );
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog').first().waitFor();
  await page.keyboard.press('Escape');
  await waitFor(
    async () => JSON.parse((await rpc('snapshot')).layout ?? '{}').selected === session.id,
    'Selected display session saved',
  );
  await page.reload();
  await expand().waitFor({ timeout: 60000 });
  await expand().click();
  await input.fill('Keep this draft while auto-collapse is enabled');
  await waitFor(
    async () =>
      (
        await page.evaluate(
          (id) =>
            window.__TAURI_INTERNALS__.invoke('host_request', {
              method: 'draft.get',
              params: { id },
            }),
          session.id,
        )
      ).text === 'Keep this draft while auto-collapse is enabled',
    'Display fixture draft persisted',
  );
  await page.reload();
  await input.waitFor({ timeout: 60000 });
  assert.equal(await input.inputValue(), 'Keep this draft while auto-collapse is enabled');
  assert.equal(
    providerFixture.calls.filter((call) => call.stream).length,
    before,
    'Display controls send no model prompt',
  );
  await page.screenshot({
    path: join(artifactDir, 'native-display-preferences.png'),
    fullPage: true,
  });
  assert.deepEqual(peerErrors, []);
  await peer.close();
  console.log(
    'PASS: two-window native appearance synchronization, persistence/reload, recorded thinking visibility and grouped/individual tool entries; opt-in composer collapse, focus expansion and draft protection; global shortcuts disabled/enabled while Find remains available',
  );
}
