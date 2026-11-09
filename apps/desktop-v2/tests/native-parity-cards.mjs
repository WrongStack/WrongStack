import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonlReportStore } from '../../../packages/builtin-plugins/dist/index.js';
import { resolveWstackPaths } from '../../../packages/core/dist/utils/index.js';
import { fixtureText } from './local-provider.mjs';
import { findConversationMessages } from './transcript-test-helpers.mjs';

/**
 * Native UI + native journal acceptance. The Chimera report/notification is a recorded fixture,
 * not a newly executed reviewer. Brain outcomes below come from the real engine arbiter.
 */
export async function exerciseNativeParityCards({
  page,
  rpc,
  project,
  waitFor,
  artifactDir,
  sessionIds,
  providerFixture,
  wrongstackHome,
  nativeDataDir,
}) {
  const session = await rpc('session.open', {
    projectId: project.id,
    kind: 'agent',
    title: 'Native parity cards',
  });
  sessionIds.push(session.id);
  const open = async () => {
    await page.locator('.tree-session').filter({ hasText: 'Native parity cards' }).click();
    await page
      .getByRole('textbox', { name: 'Message WrongStack', exact: true })
      .waitFor({ timeout: 60000 });
  };
  await open();
  const identity = await waitFor(
    async () => {
      const value = await rpc('engine.identity', { id: session.id });
      return value.sessionId ? value : null;
    },
    'Native conversation identity',
    60000,
  );
  let offset = 0;
  const call = async (type, payload = {}) => {
    const requestId = crypto.randomUUID();
    await rpc('engine.send', {
      id: session.id,
      message: { type, payload: { ...payload, requestId } },
    });
    const result = await waitFor(
      async () => {
        const batch = await rpc('engine.events', { id: session.id, offset });
        offset = batch.offset;
        return batch.events.find((event) => event.payload?.requestId === requestId)?.payload;
      },
      'Native parity ' + type,
      60000,
    );
    if (result.error || result.success === false || result.persisted === false)
      throw Error(result.error ?? result.message ?? type);
    return result;
  };
  const status = await call('chronicle.status');
  const projectDir = resolveWstackPaths({
    projectRoot: status.projectRoot,
    globalRoot: wrongstackHome,
  }).projectDir;
  const reportId = crypto.randomUUID();
  const reports = new JsonlReportStore(projectDir);
  await reports.persist({
    id: reportId,
    sessionId: identity.sessionId,
    agentId: 'recorded-reviewer',
    reviewerModel: 'recorded-fixture',
    source: 'chimera',
    reviewStatus: 'success',
    files: [{ path: 'README.md', status: 'modified' }],
    counts: { critical: 0, high: 1, medium: 0, low: 0 },
    totalFindings: 1,
    unparseableCount: 0,
    durationSeconds: 1,
    rawText:
      '# Recorded native card fixture\nThis report was seeded for UI acceptance; no reviewer ran.',
  });
  const event = {
    type: 'chimera.report_available',
    at: Date.now(),
    payload: {
      sessionId: identity.sessionId,
      reportId,
      message: 'Recorded native review awaits explicit action',
      hasActionableFindings: true,
      findingCount: 1,
      fileCount: 1,
    },
  };
  const foreign = {
    ...event,
    payload: { ...event.payload, reportId: 'foreign-card', sessionId: 'foreign-session' },
  };
  const journal = join(nativeDataDir, 'transcripts', session.id + '.events.jsonl');
  await appendFile(
    journal,
    [foreign, event, event].map((frame) => JSON.stringify(frame) + '\n').join(''),
  );
  const card = page.locator('[data-chimera-report="' + reportId + '"]');
  await card.waitFor({ timeout: 60000 });
  assert.equal(await card.count(), 1, 'Repeated notification produces one report card');
  assert.equal(await page.locator('[data-chimera-report="foreign-card"]').count(), 0);
  const composer = page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  const draft = () =>
    page.evaluate(
      (id) =>
        window.__TAURI_INTERNALS__.invoke('host_request', {
          method: 'draft.get',
          params: { id },
        }),
      session.id,
    );
  await composer.fill('Keep the existing draft');
  await waitFor(
    async () => (await draft()).text === 'Keep the existing draft',
    'The draft is saved',
  );
  assert(await card.getByRole('button', { name: 'Prepare follow-up', exact: true }).isDisabled());
  await card.getByRole('button', { name: 'Open report', exact: true }).click();
  const report = page.getByRole('region', { name: 'Project Chimera reviews', exact: true });
  await report
    .getByRole('heading', { name: 'Review ' + reportId.slice(0, 16), exact: true })
    .waitFor({ timeout: 60000 });
  await report.getByText('Full review report', { exact: true }).click();
  await report
    .getByRole('heading', { name: 'Recorded native card fixture', exact: true })
    .waitFor();
  assert.equal((await draft()).text, 'Keep the existing draft');
  await open();
  await composer.fill('');
  await waitFor(async () => (await draft()).text === '', 'The composer is empty before preparing');
  const streamCount = () => providerFixture.calls.filter((entry) => entry.stream === true).length;
  const before = streamCount();
  await card.getByRole('button', { name: 'Prepare follow-up', exact: true }).click();
  await waitFor(
    async () => (await composer.inputValue()).includes(reportId),
    'Report-specific follow-up in composer',
  );
  const prepared = await composer.inputValue();
  assert.equal(streamCount(), before, 'Preparing a follow-up never starts a turn');
  await waitFor(async () => {
    const snapshot = await rpc('snapshot');
    return JSON.parse(snapshot.layout || '{}').selected === session.id;
  }, 'The selected native conversation is saved before reload');
  await page.reload();
  await composer.waitFor({ timeout: 60000 });
  await waitFor(
    async () => (await composer.inputValue()) === prepared,
    'Prepared follow-up survives reload',
  );
  await findConversationMessages(page, 'Recorded native review awaits explicit action', 1);
  await card.waitFor({ timeout: 60000 });
  assert.equal(await card.count(), 1, 'Journal replay does not duplicate the card');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Refine your prompt', exact: true });
  await review.waitFor({ timeout: 60000 });
  const approve = review.getByRole('button', { name: 'Approve & send', exact: true });
  await waitFor(() => approve.isEnabled(), 'The real refinement response is ready', 60000);
  // Keep the fixture refiner's changed text: receipt tracking must use the original journal text.
  await approve.click();
  await page
    .locator('.chat-message.assistant')
    .filter({ hasText: fixtureText })
    .last()
    .waitFor({ timeout: 60000 });
  await findConversationMessages(page, 'Recorded native review awaits explicit action', 1);
  await card.getByText('Follow-up already sent.', { exact: true }).waitFor();
  assert(await card.getByRole('button', { name: 'Prepare follow-up', exact: true }).isDisabled());
  await page.screenshot({ path: join(artifactDir, 'native-chimera-card.png'), fullPage: true });
  console.log(
    'PASS: recorded Chimera notification -> native journal/card -> exact report -> preserved draft -> reload -> real refinement/send/receipt; foreign and duplicate notifications refused',
  );

  await call('brain.config.set', {
    patch: {
      mode: 'headless',
      maxAutoRisk: 'all',
      cache: { enabled: false },
      rules: [
        {
          id: 'native-card-allow',
          when: { source: 'user', question: 'native live allow' },
          // biome-ignore lint/suspicious/noThenProperty: BrainRule's canonical action field.
          then: { action: 'answer', text: 'Native arbiter accepted' },
        },
        {
          id: 'native-card-deny',
          when: { source: 'user', question: 'native live deny' },
          // biome-ignore lint/suspicious/noThenProperty: BrainRule's canonical action field.
          then: { action: 'deny', reason: 'Native arbiter refused' },
        },
      ],
    },
  });
  for (const [question, answer] of [
    ['native live allow', 'Native arbiter accepted'],
    ['native live deny', 'Native arbiter refused'],
  ]) {
    await call('brain.ask', { question });
    await findConversationMessages(page, answer, 1);
    await page
      .locator('[data-brain-decision]')
      .filter({ hasText: answer })
      .last()
      .waitFor({ timeout: 60000 });
  }
  await page.screenshot({ path: join(artifactDir, 'native-brain-cards.png'), fullPage: true });
  console.log(
    'PASS: real native Brain arbiter answer and denial events reach structured conversation cards',
  );
}
