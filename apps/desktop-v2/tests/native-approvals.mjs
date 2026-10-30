import assert from 'node:assert/strict';
import { join } from 'node:path';

/** Real provider tool call -> engine permission policy -> desktop decision -> real tool result. */
export async function exerciseNativeApprovals({
  page,
  agent,
  rpc,
  artifactDir,
  waitFor,
  providerFixture,
}) {
  const input = () => page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  const card = () => page.getByRole('article', { name: 'Approval for exec', exact: true });
  const idle = () =>
    waitFor(
      async () => !(await page.getByRole('button', { name: 'Stop run', exact: true }).count()),
      'Approval turn settles',
      60000,
    );
  let offset = 0;
  const call = async (type, payload, replies) => {
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
          (row) =>
            row.payload?.requestId === requestId &&
            (replies.includes(row.type) || row.type === 'error'),
        );
        if (event?.type === 'error' || event?.payload?.success === false)
          throw Error(event.payload.message ?? 'Preference refused');
        return event?.payload;
      },
      `Approval fixture ${type}`,
      60000,
    );
  };
  const originalPrefs = await call('prefs.get', {}, ['prefs.updated']);
  await call('prefs.update', { yolo: false, yoloPlus: false, autonomy: 'off' }, [
    'key.operation_result',
  ]);
  const actualPrefs = await call('prefs.get', {}, ['prefs.updated']);
  assert.equal(actualPrefs.yolo, false, 'The isolated session must actually ask for permission');
  const send = async (kind) => {
    await idle();
    const latest = page.getByRole('button', { name: 'Jump to latest', exact: true });
    if (await latest.count()) await latest.click();
    await page.getByRole('combobox', { name: 'Message delivery mode' }).selectOption('btw');
    await input().fill(`[native-composer-approval-${kind}] Run the isolated fixture command.`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
  };
  const result = async (kind) => {
    await waitFor(
      () => providerFixture.toolResults.some((item) => item.challenge === `approval-${kind}`),
      `Provider received ${kind} tool result`,
      60000,
    );
    await idle();
    return String(
      providerFixture.toolResults.findLast((item) => item.challenge === `approval-${kind}`).content,
    );
  };
  await send('allow');
  await card().waitFor({ timeout: 60000 });
  await waitFor(async () => {
    const pane = await page.locator('.native-chat-messages').boundingBox();
    const button = await card()
      .getByRole('button', { name: 'Allow once', exact: true })
      .boundingBox();
    return pane && button && button.y >= pane.y && button.y + button.height <= pane.y + pane.height;
  }, 'New approval actions follow the conversation into view');
  await card()
    .getByRole('region', { name: 'Command to run', exact: true })
    .getByText('git', { exact: true })
    .waitFor();
  await card()
    .getByRole('region', { name: 'Tool arguments', exact: true })
    .getByText('desktopfixture.first', { exact: true })
    .waitFor();
  const scope = card().getByRole('combobox', { name: 'Remembered approval scope', exact: true });
  assert.equal(await scope.inputValue(), 'always-exact');
  await scope.selectOption('always-command');
  assert.match(await scope.locator('option:checked').textContent(), /any arguments/);
  await scope.selectOption('always-exact');
  await page.setViewportSize({ width: 800, height: 640 });
  await card().scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-tool-approval-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await card().getByRole('button', { name: 'Allow once', exact: true }).click();
  await card().waitFor({ state: 'detached' });
  assert.match(await result('allow'), /exit_code.?[=:]\s*0|"exitCode"\s*:\s*0/i);
  // The finished turn keeps its tool work with its answer, and it opens the activity view.
  const turnTools = page.locator('.native-chat-messages .turn-tools').last();
  const turnSummary = turnTools.locator(':scope > summary');
  await turnSummary.filter({ hasText: /Worked with \d+ tool calls?/ }).waitFor();
  await turnSummary.click();
  await turnTools.locator('.activity-entry').first().waitFor();
  await turnSummary.click();
  await send('deny');
  await card().waitFor({ timeout: 60000 });
  await card().getByRole('button', { name: 'Deny', exact: true }).click();
  await card().waitFor({ state: 'detached' });
  assert.match(await result('deny'), /denied|not executed|permission/i);
  await send('remember');
  await card().waitFor({ timeout: 60000 });
  await card()
    .getByRole('region', { name: 'Tool arguments', exact: true })
    .getByText('desktopfixture.second', { exact: true })
    .waitFor();
  await card().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifactDir, 'native-tool-approval.png'), fullPage: true });
  await card().getByRole('button', { name: 'Allow & remember', exact: true }).click();
  await card().waitFor({ state: 'detached' });
  await result('remember');
  await send('again');
  await result('again');
  assert.equal(await card().count(), 0, 'The engine remembers the exact allowed invocation');
  await page
    .getByRole('navigation', { name: 'Agent workspace views' })
    .getByRole('button', { name: 'Tools', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Session tools' })
    .getByRole('button', { name: /Run activity/ })
    .click();
  const activity = page.getByRole('region', { name: 'Conversation activity', exact: true });
  await activity.getByRole('heading', { name: 'Run activity', exact: true }).waitFor();
  await activity.getByRole('button', { name: 'Tools', exact: true }).click();
  const execution = activity
    .locator('details.activity-entry')
    .filter({ hasText: 'desktopfixture.first' })
    .first();
  await execution.locator('summary').click();
  // An exec input reads as one command line that still names every argument.
  await execution
    .getByRole('region', { name: 'Tool input', exact: true })
    .locator('.tool-command')
    .filter({ hasText: 'desktopfixture.first' })
    .waitFor();
  await execution.getByRole('heading', { name: /^Output(?: preview)?$/ }).waitFor();
  assert.match(await execution.innerText(), /exit_code.?[=:]\s*0/i);
  await page.screenshot({ path: join(artifactDir, 'native-run-activity.png'), fullPage: true });
  await call(
    'prefs.update',
    {
      yolo: originalPrefs.yolo === true,
      yoloPlus: originalPrefs.yoloPlus === true,
      ...(typeof originalPrefs.autonomy === 'string' ? { autonomy: originalPrefs.autonomy } : {}),
    },
    ['key.operation_result'],
  );
  console.log(
    'PASS: real exec approval, complete command arguments, scope selection, one-time allow, deny, remembered exact rule, acknowledged resolution, structured run activity and compact layout',
  );
}
