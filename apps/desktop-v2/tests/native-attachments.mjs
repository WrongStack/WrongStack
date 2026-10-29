import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makePdf } from '../../../packages/tools/tests/pdf-fixture.ts';
import { nativeComposerCalls } from './local-provider.mjs';

export async function exerciseNativeAttachments({
  page,
  agent,
  rpc,
  artifactDir,
  waitFor,
  providerFixture,
  restartUi,
  identity,
}) {
  const input = () => page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  const tray = () => page.getByRole('region', { name: 'Draft attachments', exact: true });
  const picker = () => page.getByLabel('Attachment files', { exact: true });
  const idle = () =>
    waitFor(
      async () => !(await page.getByRole('button', { name: 'Stop run', exact: true }).count()),
      'Attachment run settles',
      60000,
    );
  const calls = () => nativeComposerCalls(providerFixture.calls);
  const accepted = async (marker) => {
    await waitFor(
      () => calls().some((call) => call.composerPrompt.includes(marker)),
      'Attachment reaches actual provider',
      60000,
    );
    await idle();
    return calls().findLast((call) => call.composerPrompt.includes(marker));
  };
  const png = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1657bc';
      ctx.fillRect(0, 0, 32, 32);
      return canvas.toDataURL('image/png').split(',')[1];
    }),
    'base64',
  );
  // A valid, comment-padded PDF crosses the old native frame cap without
  // flooding provider input: the canonical PDF processor extracts its text.
  const originalPdf = makePdf(['Native attachment PDF text verified.']).toString('latin1');
  const at = originalPdf.indexOf('xref\n');
  const padding = '%' + 'x'.repeat(900000) + '\n';
  const pdf = Buffer.from(
    (originalPdf.slice(0, at) + padding + originalPdf.slice(at)).replace(
      /startxref\n\d+/,
      `startxref\n${at + padding.length}`,
    ),
    'latin1',
  );
  assert.ok(
    pdf.toString('base64').length > 1024 * 1024,
    'Fixture exercises a real >1 MB native request',
  );
  await idle();
  assert.equal(
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(['local'], 'outside.txt'));
      const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    }),
    true,
    'Dropping outside the composer cannot navigate the native shell',
  );
  await page.getByRole('combobox', { name: 'Message delivery mode' }).selectOption('btw');
  await input().fill('[native-composer-attachment-direct] Review this image and PDF.');
  const initialCalls = calls().length;
  await picker().setInputFiles([
    { name: 'screen.png', mimeType: 'image/png', buffer: png },
    { name: 'brief.pdf', mimeType: 'application/pdf', buffer: pdf },
  ]);
  await tray().getByRole('button', { name: 'Remove attachment brief.pdf', exact: true }).waitFor();
  await input().fill('Inspect @README');
  await page
    .getByRole('region', { name: 'Project file suggestions', exact: true })
    .getByRole('option')
    .filter({ hasText: 'README.md' })
    .first()
    .waitFor();
  await input().press('Enter');
  await input().fill('[native-composer-attachment-direct] Review this image and PDF.');
  await page.getByRole('combobox', { name: 'Message delivery mode' }).selectOption('queue');
  const savedDraft = () =>
    page.evaluate(
      (id) =>
        window.__TAURI_INTERNALS__.invoke('host_request', { method: 'draft.get', params: { id } }),
      agent.id,
    );
  await waitFor(
    async () => {
      const saved = await savedDraft();
      return (
        saved.attachments?.length === 2 &&
        saved.references?.some((ref) => ref.path === 'README.md') &&
        saved.mode === 'queue'
      );
    },
    'Native attachment and reference persistence',
    60000,
  );
  page = await restartUi();
  await page.locator('.tree-session').filter({ hasText: 'WrongStack engine proof' }).click();
  await page.locator(`[data-engine-session="${identity.sessionId}"]`).waitFor({ timeout: 60000 });
  await tray().getByRole('button', { name: 'Remove attachment brief.pdf', exact: true }).waitFor();
  await page
    .getByRole('region', { name: 'Attached project files', exact: true })
    .getByRole('button', { name: 'Remove file reference README.md', exact: true })
    .waitFor();
  assert.equal(
    await input().inputValue(),
    '[native-composer-attachment-direct] Review this image and PDF.',
  );
  assert.equal(
    await page.getByRole('combobox', { name: 'Message delivery mode' }).inputValue(),
    'queue',
  );
  await page.getByRole('combobox', { name: 'Message delivery mode' }).selectOption('btw');
  assert.equal(calls().length, initialCalls, 'Choosing files never submits');
  await page.locator('.session-tab-label').filter({ hasText: 'Native UI terminal' }).click();
  await page.locator('.session-tab-label').filter({ hasText: 'WrongStack engine proof' }).click();
  await tray().getByRole('button', { name: 'Remove attachment screen.png', exact: true }).waitFor();
  assert.ok((await input().inputValue()).includes('attachment-direct'));
  await waitFor(
    async () => await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(),
    'Attachment composer ready after replay',
  );
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-attachment-draft-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const direct = await accepted('[native-composer-attachment-direct]');
  assert.ok(
    direct.composerPrompt.includes('data:image/png;base64,' + png.toString('base64')),
    'Actual image bytes reach the provider',
  );
  assert.ok(
    direct.composerPrompt.includes('Native attachment PDF text verified.'),
    'PDF uses the real engine extraction path',
  );
  assert.ok(
    direct.composerPrompt.includes('README.md'),
    'Restored file reference reaches the engine',
  );
  assert.equal(await tray().count(), 0);
  await waitFor(
    async () => {
      const saved = await savedDraft();
      return saved.attachments?.length === 0 && saved.references?.length === 0;
    },
    'Sent files removed from stored draft',
    60000,
  );
  const bubble = page
    .locator('.chat-message.user')
    .filter({ hasText: '[native-composer-attachment-direct]' });
  const reply = bubble.locator('xpath=following-sibling::article[1]');
  await reply.getByRole('heading', { name: 'Native result', exact: true }).waitFor();
  assert.ok(
    (await reply.getAttribute('class')).includes('assistant'),
    'The reply belongs after this user turn, not in an older assistant bubble',
  );
  await bubble.getByText('brief.pdf').waitFor();
  await bubble.getByRole('button', { name: 'Preview screen.png', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'screen.png', exact: true });
  await preview.getByRole('img', { name: 'screen.png', exact: true }).waitFor();
  await waitFor(
    async () =>
      await preview
        .getByRole('img', { name: 'screen.png', exact: true })
        .evaluate((img) => img.naturalWidth > 0),
    'Inline image preview decodes',
  );
  await preview.getByRole('button', { name: 'Close attachment preview', exact: true }).click();
  await page.screenshot({
    path: join(artifactDir, 'native-attachment-message.png'),
    fullPage: true,
  });

  // Refusal is acknowledged after canonical PDF parsing; no phantom turn,
  // no discarded draft or attached file.
  await input().fill('[native-composer-attachment-refused] Keep my request.');
  await picker().setInputFiles({
    name: 'broken.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\nnot a valid document\n%%EOF'),
  });
  await tray().getByRole('button', { name: 'Remove attachment broken.pdf', exact: true }).waitFor();
  const beforeRefusal = calls().length;
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page
    .locator('.composer-error')
    .filter({ hasText: /could not be read/ })
    .waitFor();
  assert.equal(calls().length, beforeRefusal);
  assert.ok((await input().inputValue()).includes('attachment-refused'));
  await tray().getByRole('button', { name: 'Remove attachment broken.pdf', exact: true }).click();
  assert.equal(
    await page.locator('.chat-message.user').filter({ hasText: 'attachment-refused' }).count(),
    0,
  );

  await picker().setInputFiles({
    name: 'not-image.png',
    mimeType: 'image/png',
    buffer: Buffer.from('not image data'),
  });
  await page.getByRole('alert').filter({ hasText: 'could not be decoded' }).waitFor();
  assert.equal(await tray().count(), 0);

  // Actual browser clipboard/drop data paths, not direct calls into the hook.
  await input().fill('[native-composer-attachment-reviewed] Read this screenshot.');
  await input().evaluate((el, b64) => {
    const data = new DataTransfer();
    data.items.add(
      new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'pasted.png', {
        type: 'image/png',
      }),
    );
    el.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
    );
  }, png.toString('base64'));
  await tray().getByRole('button', { name: 'Remove attachment pasted.png', exact: true }).waitFor();
  await page.locator('.native-composer').evaluate((el, b64) => {
    const data = new DataTransfer();
    data.items.add(
      new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'dropped.png', {
        type: 'image/png',
      }),
    );
    el.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }),
    );
  }, png.toString('base64'));
  await tray()
    .getByRole('button', { name: 'Remove attachment dropped.png', exact: true })
    .waitFor();
  await tray().getByRole('button', { name: 'Remove attachment dropped.png', exact: true }).click();
  // The options popover closes on Escape (focus back on its summary) and on an outside press.
  const optionsPopover = page.locator('.composer-options');
  const optionsSummary = optionsPopover.getByLabel('Composer options', { exact: true });
  if (!(await optionsPopover.evaluate((el) => el.open))) await optionsSummary.click();
  await optionsPopover.getByRole('button', { name: 'Prompt library', exact: true }).focus();
  await page.keyboard.press('Escape');
  assert.equal(await optionsPopover.evaluate((el) => el.open), false);
  assert.equal(
    await optionsSummary.evaluate((el) => el === document.activeElement),
    true,
    'Escape returns focus to the composer options summary',
  );
  await optionsSummary.click();
  await page.mouse.click(5, 5);
  assert.equal(await optionsPopover.evaluate((el) => el.open), false);
  const openRefine = async () => {
    const options = page.locator('.composer-options');
    if (!(await options.evaluate((el) => el.open)))
      await options.getByLabel('Composer options', { exact: true }).click();
    await options.getByRole('button', { name: 'Refine this draft', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Refine your prompt', exact: true });
    await waitFor(
      async () => await dialog.getByRole('button', { name: 'Refined', exact: true }).isEnabled(),
      'Attachment refinement ready',
      120000,
    );
    return dialog;
  };
  let refine = await openRefine();
  await refine
    .getByRole('region', { name: 'Attachments retained through refinement', exact: true })
    .waitFor();
  await refine.getByRole('button', { name: 'Keep original draft', exact: true }).click();
  await tray().getByRole('button', { name: 'Remove attachment pasted.png', exact: true }).waitFor();
  refine = await openRefine();
  await refine.getByRole('button', { name: 'Original', exact: true }).click();
  await refine.getByRole('button', { name: 'Approve & send', exact: true }).click();
  const reviewed = await accepted('[native-composer-attachment-reviewed]');
  assert.ok(reviewed.composerPrompt.includes('data:image/png;base64,') && !reviewed.refiner);

  await input().fill('[native-composer-hold-media] Hold while a file waits.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitFor(() => providerFixture.holds.has('media'), 'Hold media turn');
  const heldCalls = calls().length;
  await picker().setInputFiles({ name: 'queued.png', mimeType: 'image/png', buffer: png });
  await tray().getByRole('button', { name: 'Remove attachment queued.png', exact: true }).waitFor();
  await input().fill('[native-composer-attachment-queued] Review after the current turn.');
  await page.getByRole('button', { name: 'Send Queue attachments', exact: true }).click();
  await page.locator('.composer-queue summary').filter({ hasText: '1 queued' }).waitFor();
  assert.equal(
    await page
      .locator('.chat-message.user')
      .filter({ hasText: '[native-composer-attachment-queued]' })
      .count(),
    0,
    'Queued media is not accepted as a new human turn before drain',
  );
  assert.equal(calls().length, heldCalls, 'Attachment-aware BTW does not interrupt or use mailbox');
  await waitFor(
    async () => (await savedDraft()).attachments?.length === 0,
    'Queued attachment cleared from persisted draft',
    60000,
  );
  await page.reload();
  await page.locator('.composer-queue summary').filter({ hasText: '1 queued' }).waitFor();
  await waitFor(async () => {
    const queue = page.locator('.composer-queue');
    if (!(await queue.evaluate((element) => element.open))) await queue.locator('summary').click();
    return page.getByRole('button', { name: 'Copy text only', exact: true }).isVisible();
  }, 'Restored attachment queue is expanded');
  assert.equal(calls().length, heldCalls);
  providerFixture.releaseHold('media');
  const queued = await accepted('[native-composer-attachment-queued]');
  assert.ok(queued.composerPrompt.includes('data:image/png;base64,'));
  await page
    .locator('.chat-message.user')
    .filter({ hasText: 'attachment-queued' })
    .getByRole('region', { name: 'Message attachments', exact: true })
    .waitFor();
  assert.equal(await tray().count(), 0);
  await picker().setInputFiles({ name: 'restore.png', mimeType: 'image/png', buffer: png });
  await tray()
    .getByRole('button', { name: 'Remove attachment restore.png', exact: true })
    .waitFor();
  await input().fill('[native-composer-hold-editmedia] Restore this image after stop.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitFor(() => providerFixture.holds.has('editmedia'), 'Hold attachment turn for stop/edit');
  await page.getByRole('button', { name: 'Stop and edit last prompt', exact: true }).click();
  await tray()
    .getByRole('button', { name: 'Remove attachment restore.png', exact: true })
    .waitFor();
  assert.ok((await input().inputValue()).includes('hold-editmedia'));
  await idle();
  await tray().getByRole('button', { name: 'Clear attachments', exact: true }).click();
  await input().fill('');
  assert.ok((await rpc('engine.events', { id: agent.id, offset: 0 })).events.length > 0);
  console.log(
    'PASS: native image/PDF picker, >1 MB authenticated transport, actual image bytes and PDF extraction, tab-isolated drafts, clipboard/drop, preview, canonical refusal/draft retention, refinement approval, queued media/reload/drain and compact layout',
  );
}
