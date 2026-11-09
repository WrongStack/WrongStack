import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureChimeraText, fixtureText } from './local-provider.mjs';
import { findConversationMessages } from './transcript-test-helpers.mjs';

/** No seeded review/event: actual leader read/write, real producer, reviewer and store. */
export async function exerciseNativeGeneratedChimera({
  page,
  rpc,
  project,
  waitFor,
  artifactDir,
  sessionIds,
  providerFixture,
}) {
  const session = await rpc('session.open', {
    projectId: project.id,
    kind: 'agent',
    title: 'Native generated Chimera',
  });
  sessionIds.push(session.id);
  const open = async () => {
    await page.locator('.tree-session').filter({ hasText: 'Native generated Chimera' }).click();
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
    'Generated review session identity',
    60000,
  );
  let offset = 0;
  const frames = [];
  const pump = async () => {
    const batch = await rpc('engine.events', { id: session.id, offset });
    offset = batch.offset;
    frames.push(...batch.events);
    return batch.events;
  };
  const call = async (type, payload = {}) => {
    const requestId = crypto.randomUUID();
    await rpc('engine.send', {
      id: session.id,
      message: { type, payload: { ...payload, requestId } },
    });
    return waitFor(
      async () => {
        const reply = (await pump()).find((e) => e.payload?.requestId === requestId)?.payload;
        if (reply?.success === false || reply?.error) throw Error(reply.error ?? reply.message);
        return reply;
      },
      'Generated review ' + type,
      60000,
    );
  };
  const original = await readFile(join(project.root, 'README.md'), 'utf8');
  assert(!original.includes('# Native Code Assist edit'));
  const beforeReviews = providerFixture.calls.filter((c) => c.chimeraReview).length;
  await rpc('engine.send', {
    id: session.id,
    message: {
      type: 'user_message',
      payload: {
        id: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        content:
          '[native-code-assist-edit] [native-chimera-producer] Read README.md, then overwrite it with # Native Code Assist edit. Do not call other mutation tools.',
        timestamp: Date.now(),
      },
    },
  });
  await waitFor(
    async () => {
      await pump();
      const result = frames.find((event) => event.type === 'run.result');
      if (result && result.payload?.status !== 'done')
        throw Error('Initial native leader failed: ' + JSON.stringify(result.payload));
      return result?.payload?.status === 'done';
    },
    'Actual leader write completes',
    90000,
  );
  assert.equal(
    await readFile(join(project.root, 'README.md'), 'utf8'),
    '# Native Code Assist edit\n',
    'Actual tool changed the tracked file',
  );
  const leaderCalls = () =>
    providerFixture.calls.filter(
      (c) => c.stream && !c.refiner && !c.topicAdvisor && !c.chimeraReview,
    ).length;
  const settledLeaderCalls = leaderCalls();
  await waitFor(
    async () => {
      await pump();
      return frames.some(
        (e) => e.type === 'chimera.report_available' && e.payload?.sessionId === identity.sessionId,
      );
    },
    'Real quiet-window reviewer produces report',
    90000,
  );
  const notice = frames.find(
    (e) => e.type === 'chimera.report_available' && e.payload?.sessionId === identity.sessionId,
  ).payload;
  assert.equal(
    providerFixture.calls.filter((c) => c.chimeraReview).length,
    beforeReviews + 1,
    'Real reviewer provider request',
  );
  assert.equal(leaderCalls(), settledLeaderCalls, 'Report availability never starts the leader');
  const reviewer = providerFixture.calls.findLast((c) => c.chimeraReview);
  assert(reviewer.reviewTools?.includes('read'));
  assert(
    !reviewer.reviewTools.some((name) =>
      ['write', 'edit', 'bash', 'exec', 'delegate'].includes(name),
    ),
    'Reviewer is read-only',
  );
  assert.equal(
    notice.hasActionableFindings,
    true,
    'Controlled finding is verified against the actual changed file',
  );
  const reportId = notice.reportId;
  const detail = await call('chimera.report.get', { reportId });
  assert.equal(detail.report.id, reportId);
  assert.equal(detail.report.sessionId, identity.sessionId);
  assert.equal(detail.report.rawText, fixtureChimeraText);
  assert(detail.report.files.some((file) => file.path === 'README.md'));
  const card = page.locator('[data-chimera-report="' + reportId + '"]');
  await card.waitFor({ timeout: 60000 });
  assert.equal(await card.count(), 1);
  const composer = () => page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  const draft = () =>
    page.evaluate(
      (id) =>
        window.__TAURI_INTERNALS__.invoke('host_request', {
          method: 'draft.get',
          params: { id },
        }),
      session.id,
    );
  await composer().fill('Keep the user draft while opening the generated report');
  await waitFor(
    async () => (await draft()).text === 'Keep the user draft while opening the generated report',
    'Generated report draft saved',
  );
  assert(await card.getByRole('button', { name: 'Prepare follow-up', exact: true }).isDisabled());
  await card.getByRole('button', { name: 'Open report', exact: true }).click();
  const hub = page.getByRole('region', { name: 'Project Chimera reviews', exact: true });
  await hub
    .getByRole('heading', { name: 'Review ' + reportId.slice(0, 16), exact: true })
    .waitFor({ timeout: 60000 });
  await hub.getByText('Full review report', { exact: true }).click();
  await hub.getByText('Native generated reviewer fixture.', { exact: true }).waitFor();
  assert.equal((await draft()).text, 'Keep the user draft while opening the generated report');
  await open();
  await composer().fill('');
  await waitFor(async () => (await draft()).text === '', 'Explicitly emptied draft');
  const beforePrepare = leaderCalls();
  await card.getByRole('button', { name: 'Prepare follow-up', exact: true }).click();
  await waitFor(
    async () => (await composer().inputValue()).includes(reportId),
    'Generated report explicit follow-up draft',
  );
  const prepared = await composer().inputValue();
  assert.equal(leaderCalls(), beforePrepare);
  await waitFor(
    async () => JSON.parse((await rpc('snapshot')).layout || '{}').selected === session.id,
    'Generated review selected layout saved',
  );
  await page.reload();
  await composer().waitFor({ timeout: 60000 });
  await waitFor(
    async () => (await composer().inputValue()) === prepared,
    'Generated report follow-up draft survives reload',
  );
  await findConversationMessages(page, notice.message, 1);
  await card.waitFor({ timeout: 60000 });
  assert.equal(await card.count(), 1);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Refine your prompt', exact: true });
  await review.waitFor({ timeout: 60000 });
  const approve = review.getByRole('button', { name: 'Approve & send', exact: true });
  await waitFor(() => approve.isEnabled(), 'Real report follow-up refinement', 60000);
  assert.equal(leaderCalls(), beforePrepare, 'Refinement awaits explicit approval');
  await approve.click();
  await page
    .locator('.chat-message.assistant')
    .filter({ hasText: fixtureText })
    .last()
    .waitFor({ timeout: 60000 });
  await waitFor(() => leaderCalls() > beforePrepare, 'Only explicit approval starts follow-up');
  await findConversationMessages(page, notice.message, 1);
  await card.getByText('Follow-up already sent.', { exact: true }).waitFor();
  assert(await card.getByRole('button', { name: 'Prepare follow-up', exact: true }).isDisabled());
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifactDir, 'native-generated-chimera-follow-up.png'),
    fullPage: true,
  });
  const result = {
    result: 'PASS',
    reportId,
    sessionId: identity.sessionId,
    realReviewer: true,
    realReadWrite: true,
    passiveAvailability: true,
    explicitRefinedFollowup: true,
    reviewerModel: reviewer.model,
    leaderCallsBeforeFollowup: beforePrepare,
    leaderCallsAfterFollowup: leaderCalls(),
  };
  await writeFile(
    join(artifactDir, 'generated-chimera-evidence.json'),
    JSON.stringify(
      {
        ...result,
        report: detail.report,
        events: frames.filter((e) => e.type.startsWith('chimera.') || e.type === 'run.result'),
      },
      null,
      2,
    ),
  );
  return result;
}
