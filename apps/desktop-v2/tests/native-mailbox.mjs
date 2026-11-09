import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  getSharedProjectMailbox,
  resolveProjectDir,
} from '../../../packages/coordination/dist/index.js';
import { openProjectView } from './native-project-navigation.mjs';

export async function exerciseNativeMailbox({
  page,
  rpc,
  project,
  otherProject,
  waitFor,
  artifactDir,
  wrongstackHome,
}) {
  let offset = 0;
  const call = async (type, payload = {}, owner = project) => {
    const requestId = crypto.randomUUID();
    await rpc('project.send', {
      projectId: owner.id,
      message: { type, payload: { ...payload, requestId } },
    });
    const reply = await waitFor(
      async () => {
        const batch = await rpc('project.events', {
          projectId: owner.id,
          offset: owner.id === project.id ? offset : 0,
        });
        if (owner.id === project.id) offset = batch.offset;
        return batch.events.find((event) => event.payload?.requestId === requestId)?.payload;
      },
      `Native mailbox ${type}`,
      60000,
    );
    if (reply.success === false || typeof reply.error === 'string')
      throw Error(reply.error ?? reply.message ?? 'Mailbox action refused');
    return reply;
  };
  const open = async (owner) => {
    await page.locator('.project-item').filter({ hasText: owner.name }).click();
    await openProjectView(page, owner, 'Mailbox');
    await page
      .getByRole('region', { name: 'Project mailbox' })
      .getByRole('searchbox', { name: 'Search mailbox messages', exact: true })
      .waitFor({ timeout: 60000 });
  };
  const count = (await rpc('snapshot')).sessions.length;
  await open(project);
  // Start the detached project mailbox from the engine before attaching this fixture client.
  await call('mailbox.messages', { limit: 200 });
  const identity = await call('chronicle.status');
  assert.equal(typeof identity.projectRoot, 'string');
  const mb = getSharedProjectMailbox(resolveProjectDir(identity.projectRoot, wrongstackHome));
  const actor = 'native-mailbox-worker';
  try {
    await mb.registerAgent({
      agentId: actor,
      sessionId: 'native-mailbox-fixture',
      name: 'Native mailbox worker',
      role: 'worker',
      pid: process.pid,
      source: 'http',
    });
    const root = await mb.send({
      from: actor,
      to: 'desktop',
      type: 'ask',
      subject: 'Native investigation thread',
      body: '# Investigation\n\nPlease review the project findings.',
      priority: 'high',
    });
    assert.ok(
      (await call('mailbox.messages', { limit: 200 })).messages.some((mail) => mail.id === root.id),
      'Fixture and native engine share the same canonical mailbox',
    );
    await mb.send({
      from: actor,
      to: 'desktop',
      type: 'note',
      subject: 'Native follow-up',
      body: 'A second piece of evidence.',
      replyTo: root.id,
    });
    let mailbox = page.getByRole('region', { name: 'Project mailbox' });
    await mailbox
      .locator('.mailbox-thread-list')
      .getByRole('button', { name: /Native investigation thread/ })
      .waitFor({ timeout: 60000 });
    await mailbox.getByRole('button', { name: 'Refresh mailbox', exact: true }).click();
    await mailbox
      .locator('.mailbox-thread-list')
      .getByRole('button', { name: /Native investigation thread/ })
      .click();
    await mailbox.getByRole('heading', { name: 'Native investigation thread', level: 3 }).waitFor();
    assert.equal(await mailbox.locator('.mailbox-message').count(), 2);
    assert.equal(
      await mailbox.getByRole('button', { name: 'Mark read', exact: true }).first().isDisabled(),
      true,
    );
    await mailbox.getByLabel('Mailbox actor', { exact: true }).fill('desktop');
    await mailbox
      .locator('.mailbox-thread-list')
      .getByRole('button', { name: /Native investigation thread/ })
      .click();
    await mailbox.getByRole('button', { name: 'Mark read', exact: true }).first().click();
    await mailbox.getByText('Mailbox action recorded for desktop.', { exact: true }).waitFor();
    let records = (await call('mailbox.messages', { limit: 200, agentId: 'desktop' })).messages;
    assert.equal(records.find((mail) => mail.id === root.id).readByMe, true);
    await mailbox.getByRole('button', { name: 'Complete message', exact: true }).first().click();
    await mailbox.getByRole('button', { name: 'Reopen message', exact: true }).first().waitFor();
    records = (await call('mailbox.messages', { limit: 200, agentId: 'desktop' })).messages;
    assert.equal(records.find((mail) => mail.id === root.id).completedByMe, true);
    await mailbox.getByRole('button', { name: 'Reopen message', exact: true }).first().click();
    await mailbox.getByRole('button', { name: 'Complete message', exact: true }).first().waitFor();
    await mailbox.getByRole('button', { name: 'Reply', exact: true }).first().click();
    let composer = page.getByRole('dialog');
    assert.equal(
      await composer.getByLabel('Mailbox recipient', { exact: true }).inputValue(),
      actor,
    );
    await composer
      .getByLabel('Mailbox message body', { exact: true })
      .fill('Native reviewed reply.');
    await composer.getByRole('button', { name: 'Send mailbox message', exact: true }).click();
    await mailbox.getByText(/Message recorded in the project mailbox/).waitFor();
    let sent = (await mb.query({ limit: 200 })).find(
      (mail) => mail.body === 'Native reviewed reply.',
    );
    assert.equal(sent?.replyTo, root.id);
    assert.equal(sent?.from, 'desktop');
    assert.equal(sent?.to, actor);
    await mailbox.getByRole('button', { name: 'Compose message', exact: true }).click();
    composer = page.getByRole('dialog');
    await composer.getByLabel('Mailbox recipient', { exact: true }).fill('*');
    await composer.getByLabel('Mailbox message type', { exact: true }).selectOption('assign');
    await composer
      .getByLabel('Mailbox subject', { exact: true })
      .fill('Refused ambiguous assignment');
    await composer
      .getByLabel('Mailbox message body', { exact: true })
      .fill('Keep this rejected draft.');
    await composer.getByRole('button', { name: 'Send mailbox message', exact: true }).click();
    await composer
      .getByRole('alert')
      .filter({ hasText: /specific recipient/ })
      .waitFor();
    assert.equal(
      await composer.getByLabel('Mailbox message body', { exact: true }).inputValue(),
      'Keep this rejected draft.',
    );
    assert.equal(
      (await mb.query({ limit: 200 })).some(
        (mail) => mail.subject === 'Refused ambiguous assignment',
      ),
      false,
    );
    await composer.getByRole('button', { name: 'Close mailbox composer', exact: true }).click();
    await open(otherProject);
    await page
      .getByRole('region', { name: 'Project mailbox' })
      .getByText('No messages in this view.', { exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Resume message draft', exact: true }).count(),
      0,
    );
    // The unsent message is saved natively for this project and survives a renderer reload.
    const storedDraft = () =>
      page.evaluate(
        (params) =>
          window.__TAURI_INTERNALS__.invoke('host_request', { method: 'form-draft.get', params }),
        { projectId: project.id, formKey: 'mailbox-compose' },
      );
    await waitFor(
      async () => (await storedDraft()).value?.draft?.body === 'Keep this rejected draft.',
      'Mailbox draft saved natively',
    );
    assert.equal((await storedDraft()).value.draft.subject, 'Refused ambiguous assignment');
    await page.reload();
    await open(project);
    mailbox = page.getByRole('region', { name: 'Project mailbox' });
    await mailbox.getByText(/Restored an unsent message saved/).waitFor();
    await mailbox.getByRole('button', { name: 'Resume message draft', exact: true }).click();
    composer = page.getByRole('dialog');
    assert.equal(
      await composer.getByLabel('Mailbox message body', { exact: true }).inputValue(),
      'Keep this rejected draft.',
    );
    assert.equal(
      await composer.getByLabel('Mailbox message type', { exact: true }).inputValue(),
      'assign',
    );
    await composer.getByLabel('Mailbox recipient', { exact: true }).fill(actor);
    await composer.getByLabel('Mailbox message type', { exact: true }).selectOption('note');
    await composer.getByLabel('Mailbox subject', { exact: true }).fill('Native direct message');
    await composer.getByRole('button', { name: 'Send mailbox message', exact: true }).click();
    await mailbox.getByText(/Message recorded in the project mailbox/).waitFor();
    sent = (await mb.query({ limit: 200 })).find(
      (mail) => mail.subject === 'Native direct message',
    );
    assert.ok(sent);
    await waitFor(
      async () => (await storedDraft()).value === null,
      'Confirmed send removes the saved mailbox draft',
    );
    await mailbox.getByText(/Registered agents/).click();
    await mailbox
      .locator('.mailbox-agents')
      .getByText('Native mailbox worker', { exact: true })
      .waitFor();
    await mailbox.getByLabel('Mailbox actor', { exact: true }).fill('desktop');
    await mailbox
      .locator('.mailbox-thread-list')
      .getByRole('button', { name: /Native investigation thread/ })
      .click();
    const followup = mailbox
      .locator('.mailbox-message')
      .filter({ hasText: 'A second piece of evidence.' });
    await followup.getByRole('button', { name: 'Remove message', exact: true }).click();
    await followup.getByRole('button', { name: 'Keep message', exact: true }).click();
    assert.ok(
      (await mb.query({ limit: 200 })).some((mail) => mail.body === 'A second piece of evidence.'),
    );
    await followup.getByRole('button', { name: 'Remove message', exact: true }).click();
    await followup.getByRole('button', { name: 'Confirm remove message', exact: true }).click();
    await mailbox.getByText('Message removed from the active mailbox.', { exact: true }).waitFor();
    assert.equal(
      (await mb.query({ limit: 200 })).some((mail) => mail.body === 'A second piece of evidence.'),
      false,
    );
    await mailbox
      .getByRole('heading', { name: 'Native investigation thread', level: 3 })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(artifactDir, 'native-project-mailbox.png'),
      fullPage: true,
    });
    await mailbox.getByText('Retention and maintenance', { exact: true }).click();
    for (const [button, action] of [
      ['Purge stale messages', 'purge'],
      ['Compact mailbox', 'compact'],
    ]) {
      await mailbox.getByRole('button', { name: button, exact: true }).click();
      await mailbox
        .getByRole('button', { name: 'Review mailbox maintenance', exact: true })
        .click();
      await mailbox.getByRole('button', { name: `Confirm ${action} mailbox`, exact: true }).click();
      await mailbox
        .getByRole('status')
        .filter({ hasText: action === 'purge' ? /Purge completed/ : /Compaction completed/ })
        .waitFor();
    }
    await page.setViewportSize({ width: 800, height: 640 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: join(artifactDir, 'native-project-mailbox-compact.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1480, height: 960 });
    await mailbox.getByRole('button', { name: 'Clear all messages', exact: true }).click();
    await mailbox.getByRole('button', { name: 'Cancel mailbox maintenance', exact: true }).click();
    assert.ok((await mb.query({ limit: 200 })).length > 0);
    await mailbox.getByRole('button', { name: 'Clear all messages', exact: true }).click();
    await mailbox.getByRole('button', { name: 'Review mailbox maintenance', exact: true }).click();
    await mailbox.getByRole('button', { name: 'Confirm clear mailbox', exact: true }).click();
    await mailbox.getByText('All project mailbox messages cleared.', { exact: true }).waitFor();
    assert.equal((await mb.query({ limit: 200 })).length, 0);
    assert.equal((await rpc('snapshot')).sessions.length, count);
  } finally {
    await mb.deregisterAgent(actor);
    await mb.close();
  }
  console.log(
    'PASS: native project mailbox threads/Markdown, actor receipts/completion/reopen, reply/direct send, refusal/draft/project isolation, registered agents, purge/compact/clear without conversations',
  );
}
