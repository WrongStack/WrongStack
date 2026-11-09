import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixtureText } from './local-provider.mjs';
import { findConversationMessages } from './transcript-test-helpers.mjs';

/** Uses the production engine and its actual clarify tool, not injected renderer events. */
export async function exerciseNativeConversation({
  page,
  identity,
  artifactDir,
  waitFor,
  providerFixture,
}) {
  const views = () => page.getByRole('navigation', { name: 'Agent workspace views' });
  const assistant = page
    .locator('.chat-message.assistant')
    .filter({ hasText: fixtureText })
    .first();
  await assistant.getByRole('heading', { name: 'Native result', exact: true }).waitFor();
  assert.equal(await assistant.locator('table tbody tr').count(), 1);
  assert.equal(await assistant.locator('a[href^="javascript:"]').count(), 0);
  assert.equal(await assistant.locator('img,script').count(), 0);
  assert.equal(await page.evaluate(() => window.nativeUnsafeScriptRan), undefined);
  await assistant.getByRole('button', { name: 'Copy code', exact: true }).click();
  await assistant.locator('.markdown-code-block').getByText('Copied', { exact: true }).waitFor();
  const composer = page.getByRole('textbox', { name: 'Message WrongStack' });
  await composer.fill('');
  await composer.focus();
  await page.keyboard.press('Control+v');
  assert.equal(
    await composer.inputValue(),
    'const native = true;\n',
    'Code copies the original text, without toolbar labels',
  );
  await composer.fill('');
  await assistant.getByRole('button', { name: 'Copy message', exact: true }).click();
  await assistant.locator('header').getByText('Copied', { exact: true }).waitFor();
  const invalidLinks = await page.evaluate(async () => {
    const results = [];
    for (const url of [
      'file:///C:/private',
      'javascript:alert(1)',
      'https://user:secret@example.com/',
    ]) {
      try {
        await window.__TAURI_INTERNALS__.invoke('open_external', { url });
        results.push(false);
      } catch {
        results.push(true);
      }
    }
    return results;
  });
  assert.deepEqual(invalidLinks, [true, true, true]);
  await assistant.getByRole('link', { name: 'project note', exact: true }).click();
  await page
    .locator('.native-file-content')
    .getByText('Native Markdown links read project files through the engine.', { exact: true })
    .waitFor();
  await views().getByRole('button', { name: 'Chat', exact: true }).click();
  await page.screenshot({ path: join(artifactDir, 'native-markdown.png'), fullPage: true });
  await assistant.locator('.markdown-code-block').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifactDir, 'native-markdown-code.png'), fullPage: true });
  const send = async (text) => {
    await page.getByRole('textbox', { name: 'Message WrongStack' }).fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
  };
  await send('[native-clarify-submit] Ask for the native project decisions using clarify.');
  let card = page.getByRole('article', { name: 'Native project decisions', exact: true });
  await card.waitFor({ timeout: 60000 });
  assert.equal(
    await page.getByRole('textbox', { name: 'Message WrongStack' }).count(),
    0,
    'Pending questions receive the conversation area',
  );
  await page.getByRole('button', { name: 'Review conversation', exact: true }).click();
  await findConversationMessages(page, fixtureText, 1);
  await assistant.getByRole('heading', { name: 'Native result', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Focus questions', exact: true }).click();
  assert.equal(await page.locator('.chat-message').count(), 0);
  // Reload the UI while the real engine is blocked on the user's form.
  await page.reload();
  await page.locator(`[data-engine-session="${identity.sessionId}"]`).waitFor();
  card = page.getByRole('article', { name: 'Native project decisions', exact: true });
  await card.waitFor();
  await card.getByRole('radio', { name: 'React', exact: true }).check();
  await card.getByRole('checkbox', { name: 'Chat', exact: true }).check();
  await card.getByRole('button', { name: 'Apply decisions', exact: true }).click();
  await card.getByRole('alert').filter({ hasText: 'Release notes' }).waitFor();
  await card
    .getByRole('textbox', { name: 'Release notes', exact: true })
    .fill('Keep all project screens native.');
  await page.locator('.session-tab-label').filter({ hasText: 'Concurrent terminal' }).click();
  await page.locator('.session-tab-label').filter({ hasText: 'WrongStack engine proof' }).click();
  card = page.getByRole('article', { name: 'Native project decisions', exact: true });
  await card.getByRole('button', { name: 'Delivery', exact: true }).click();
  assert.equal(
    await card.getByRole('textbox', { name: 'Release notes', exact: true }).inputValue(),
    'Keep all project screens native.',
  );
  await card.getByRole('button', { name: 'Build', exact: true }).click();
  assert.equal(await card.getByRole('radio', { name: 'React', exact: true }).isChecked(), true);
  assert.equal(await card.getByRole('checkbox', { name: 'Chat', exact: true }).isChecked(), true);
  await page.setViewportSize({ width: 800, height: 640 });
  const questionPane = await page.locator('.native-chat-messages').boundingBox();
  assert.ok(
    questionPane.height >= 200,
    `Compact question pane must remain usable; got ${questionPane.height}px`,
  );
  console.log(`PASS: compact question pane ${questionPane.height}px (minimum 200px)`);
  await card.getByRole('radio', { name: 'React', exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(artifactDir, 'native-question-compact.png'), fullPage: true });
  await page.setViewportSize({ width: 1480, height: 960 });
  await card.getByRole('button', { name: 'Delivery', exact: true }).click();
  await card.getByRole('textbox', { name: 'Release notes', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifactDir, 'native-question-form.png'), fullPage: true });
  await card.getByRole('button', { name: 'Apply decisions', exact: true }).click();
  await card.waitFor({ state: 'detached' });
  await waitFor(
    () => providerFixture.toolResults.some((result) => result.challenge === 'submit'),
    'Real clarify answers reach the provider',
    60000,
  );
  const result = providerFixture.toolResults.find((result) => result.challenge === 'submit');
  const output = JSON.stringify(result.content);
  assert.ok(output.includes('Keep all project screens native.'));
  assert.ok(output.includes('React') && output.includes('Terminal') && output.includes('Chat'));
  assert.ok(output.includes('answered'));
  await waitFor(
    async () => !(await page.getByRole('button', { name: 'Stop run', exact: true }).count()),
    'Run resumes after answering the form',
    60000,
  );
  await send('[native-clarify-cancel] Ask for a decision using clarify.');
  card = page.getByRole('article', { name: 'Native optional decision', exact: true });
  await card.waitFor({ timeout: 60000 });
  await card.getByRole('button', { name: 'Cancel request', exact: true }).click();
  await card.waitFor({ state: 'detached' });
  await waitFor(
    () => providerFixture.toolResults.some((item) => item.challenge === 'cancel'),
    'Real clarification cancellation',
    60000,
  );
  assert.ok(
    JSON.stringify(
      providerFixture.toolResults.find((item) => item.challenge === 'cancel').content,
    ).includes('skipped'),
  );
  await waitFor(
    async () => !(await page.getByRole('button', { name: 'Stop run', exact: true }).count()),
    'Run resumes after cancelling the form',
    60000,
  );
  console.log(
    'PASS: native Markdown/copy/file links and real clarify submit/cancel/reload/tab-isolated drafts',
  );
}
