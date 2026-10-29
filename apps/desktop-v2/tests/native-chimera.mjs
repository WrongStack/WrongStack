import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  JsonlFindingStore,
  JsonlReportStore,
} from '../../../packages/builtin-plugins/dist/index.js';
import { resolveWstackPaths } from '../../../packages/core/dist/utils/index.js';
import { revealProjectTools } from './native-project-navigation.mjs';

export async function exerciseNativeChimera({
  page,
  rpc,
  project,
  otherProject,
  wrongstackHome,
  waitFor,
  artifactDir,
  sessionIds,
}) {
  const offsets = new Map();
  const call = async (type, payload = {}, owner = project) => {
    const requestId = crypto.randomUUID();
    await rpc('project.send', {
      projectId: owner.id,
      message: { type, payload: { ...payload, requestId } },
    });
    const result = await waitFor(
      async () => {
        const batch = await rpc('project.events', {
          projectId: owner.id,
          offset: offsets.get(owner.id) ?? 0,
        });
        offsets.set(owner.id, batch.offset);
        return batch.events.find((event) => event.payload?.requestId === requestId)?.payload;
      },
      `Native ${type}`,
      60000,
    );
    if (result.success === false || result.error)
      throw Error(String(result.error ?? 'Review request refused'));
    return result;
  };
  const open = async (owner) => {
    await page.locator('.project-item').filter({ hasText: owner.name }).click();
    await revealProjectTools(page, owner);
    await page
      .getByRole('navigation', { name: `${owner.name} workspace` })
      .getByRole('button', { name: 'Chimera Reviews', exact: true })
      .click();
    await page.getByRole('region', { name: 'Project Chimera reviews' }).waitFor();
  };
  const count = (await rpc('snapshot')).sessions.length;
  const identity = await call('chronicle.status');
  const directory = resolveWstackPaths({
    projectRoot: identity.projectRoot,
    globalRoot: wrongstackHome,
  }).projectDir;
  assert.ok(
    resolve(directory)
      .toLowerCase()
      .startsWith(resolve(wrongstackHome).toLowerCase() + sep),
  );
  await mkdir(directory, { recursive: true });
  const reports = new JsonlReportStore(directory),
    findings = new JsonlFindingStore(directory);
  const reportId = crypto.randomUUID(),
    otherReportId = crypto.randomUUID(),
    findingId = crypto.randomUUID();
  const base = {
    agentId: 'native-recorded-reviewer',
    reviewerModel: 'recorded-native-model',
    source: 'chimera',
    reviewStatus: 'success',
    files: [{ path: 'README.md', status: 'modified' }],
    counts: { critical: 0, high: 1, medium: 0, low: 0 },
    totalFindings: 1,
    unparseableCount: 0,
    durationSeconds: 12,
    rawText:
      '# Native recorded review\n\nThis is a recorded UI fixture, not a newly executed review.',
    evidenceStatus: 'failed',
    evidenceChecks: [
      {
        name: 'tests',
        command: 'recorded fixture command (not executed)',
        claimedExitCode: 0,
        actualExitCode: 1,
        ok: false,
      },
    ],
  };
  await reports.persist({ ...base, id: reportId, sessionId: 'recorded-native-session-a' });
  await reports.persist({
    ...base,
    id: otherReportId,
    sessionId: 'recorded-native-session-b',
    reviewStatus: 'failed',
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
    totalFindings: 0,
  });
  await findings.upsert(
    [
      {
        id: findingId,
        fingerprint: crypto.randomUUID().replaceAll('-', '').repeat(2),
        severity: 'high',
        source: 'chimera',
        category: 'bug',
        confidence: 'medium',
        location: { file: 'README.md', line: 1 },
        title: 'Native recorded citation finding',
        description: 'A recorded finding for desktop review tracking.',
        suggestedFix: 'Investigate the current code before deciding.',
        verification: {
          status: 'verified',
          reason: 'anchor_found',
          evidence: 'Native recorded citation fixture',
        },
        createdAt: new Date().toISOString(),
        status: 'active',
        originReport: {
          reportId,
          sessionId: 'recorded-native-session-a',
          agentId: base.agentId,
          reviewerModel: base.reviewerModel,
        },
      },
    ],
    {
      sessionId: 'recorded-native-session-a',
      reportId,
      agentId: base.agentId,
      model: base.reviewerModel,
    },
  );
  const control = await call('chimera.reports.query', {
    all: true,
    sessionId: 'native-project-carrier-control',
  });
  assert.equal(
    control.reports.length,
    0,
    'Carrier identity remains a legacy session filter when projectWide is absent',
  );
  const catalog = await call('chimera.reports.query', { all: true, projectWide: true });
  assert.deepEqual(
    catalog.reports.map((item) => item.reportId).sort(),
    [reportId, otherReportId].sort(),
  );
  await open(project);
  let screen = page.getByRole('region', { name: 'Project Chimera reviews' });
  await screen.getByRole('button', { name: `Open review ${reportId}`, exact: true }).click();
  await screen
    .getByRole('heading', { name: 'Native recorded citation finding', exact: true })
    .waitFor();
  await screen
    .getByRole('combobox', { name: 'Review finding severity', exact: true })
    .selectOption('low');
  await screen.getByText('No findings match these filters.', { exact: true }).waitFor();
  await screen
    .getByRole('combobox', { name: 'Review finding severity', exact: true })
    .selectOption('');
  await screen
    .getByRole('textbox', { name: 'Chimera review note', exact: true })
    .fill('Keep this project report note.');
  const formKey = 'chimera-note:' + createHash('sha256').update(reportId).digest('hex');
  const noteParams = { projectId: project.id, formKey };
  const invokeForm = (method, params) =>
    page.evaluate(
      ({ method, params }) => window.__TAURI_INTERNALS__.invoke('host_request', { method, params }),
      { method, params },
    );
  const noteGet = () => invokeForm('form-draft.get', noteParams);
  await waitFor(
    async () => (await noteGet()).value?.text === 'Keep this project report note.',
    'Native note autosave',
  );
  assert.equal(
    (await invokeForm('form-draft.get', { projectId: otherProject.id, formKey })).value,
    null,
  );
  await screen.getByRole('button', { name: `Open review ${otherReportId}`, exact: true }).click();
  assert.equal(
    await screen.getByRole('textbox', { name: 'Chimera review note', exact: true }).inputValue(),
    '',
  );
  await screen.getByText('Review execution failed', { exact: true }).waitFor();
  await open(otherProject);
  await page.getByRole('heading', { name: 'No reports in this view.', exact: true }).waitFor();
  await open(project);
  screen = page.getByRole('region', { name: 'Project Chimera reviews' });
  await screen.getByRole('button', { name: `Open review ${reportId}`, exact: true }).click();
  await waitFor(
    async () =>
      (await screen
        .getByRole('textbox', { name: 'Chimera review note', exact: true })
        .inputValue()) === 'Keep this project report note.',
    'Recovered project/report draft',
  );
  await page.reload();
  await open(project);
  screen = page.getByRole('region', { name: 'Project Chimera reviews' });
  await screen.getByRole('button', { name: `Open review ${reportId}`, exact: true }).click();
  await waitFor(
    async () =>
      (await screen
        .getByRole('textbox', { name: 'Chimera review note', exact: true })
        .inputValue()) === 'Keep this project report note.',
    'Native draft after renderer reload',
  );
  const externalSave = async (text) =>
    invokeForm('form-draft.save', {
      ...noteParams,
      expectedRevision: (await noteGet()).revision,
      value: { version: 1, reportId, text },
    });
  await externalSave('Competing saved note');
  await screen
    .getByRole('textbox', { name: 'Chimera review note', exact: true })
    .fill('Local reviewed project note.');
  const conflict = screen.getByRole('region', { name: 'Review note draft conflict', exact: true });
  await conflict.waitFor();
  assert.equal(
    await conflict.getByLabel('Saved review note', { exact: true }).inputValue(),
    'Competing saved note',
  );
  assert.equal(
    await screen.getByRole('button', { name: 'Record review note', exact: true }).isDisabled(),
    true,
  );
  await externalSave('Newer competing saved note');
  await conflict.getByRole('button', { name: 'Keep my review note', exact: true }).click();
  await waitFor(
    async () =>
      (await conflict.getByLabel('Saved review note', { exact: true }).inputValue()) ===
      'Newer competing saved note',
    'Fresh competing note review',
  );
  assert.equal((await noteGet()).value.text, 'Newer competing saved note');
  await conflict.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifactDir, 'native-chimera-note-conflict.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 640 });
  await conflict.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-chimera-note-conflict-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await conflict.getByRole('button', { name: 'Keep my review note', exact: true }).click();
  await waitFor(
    async () => (await noteGet()).value?.text === 'Local reviewed project note.',
    'Reviewed local note saved',
  );
  await externalSave('Choose the saved version');
  await screen
    .getByRole('textbox', { name: 'Chimera review note', exact: true })
    .fill('Alternate local note');
  await conflict.waitFor();
  await conflict.getByRole('button', { name: 'Use saved review note', exact: true }).click();
  await waitFor(
    async () =>
      (await screen
        .getByRole('textbox', { name: 'Chimera review note', exact: true })
        .inputValue()) === 'Choose the saved version',
    'Reviewed saved note adopted',
  );
  assert.equal(
    (await reports.getEvents(reportId)).some((event) =>
      [
        'Keep this project report note.',
        'Local reviewed project note.',
        'Competing saved note',
        'Newer competing saved note',
        'Choose the saved version',
        'Alternate local note',
      ].includes(event.reason),
    ),
    false,
    'Recovery choices do not post report notes',
  );
  await screen
    .getByRole('textbox', { name: 'Chimera review note', exact: true })
    .fill('Keep this project report note.');
  await waitFor(
    async () => (await noteGet()).value?.text === 'Keep this project report note.',
    'Final draft saved before posting',
  );
  await screen.getByRole('button', { name: 'Record review note', exact: true }).click();
  await screen.getByText('Review note recorded.', { exact: true }).waitFor();
  assert.equal(
    (await reports.getEvents(reportId)).filter(
      (event) => event.reason === 'Keep this project report note.',
    ).length,
    1,
  );
  assert.equal(
    await screen.getByRole('textbox', { name: 'Chimera review note', exact: true }).inputValue(),
    '',
  );
  await waitFor(
    async () => (await noteGet()).value === null,
    'Acknowledged note clears the saved draft',
  );
  await page.reload();
  await open(project);
  screen = page.getByRole('region', { name: 'Project Chimera reviews' });
  await screen.getByRole('button', { name: `Open review ${reportId}`, exact: true }).click();
  await screen.getByText('Note draft saved on this device.', { exact: true }).waitFor();
  assert.equal(
    await screen.getByRole('textbox', { name: 'Chimera review note', exact: true }).inputValue(),
    '',
  );
  const finding = () =>
    screen.getByRole('article', { name: 'Native recorded citation finding', exact: true });
  const decide = async (button, reason, outcome) => {
    await button.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Review decision reason', exact: true }).fill(reason);
    if (outcome)
      await dialog
        .getByRole('combobox', { name: 'Review resolution outcome', exact: true })
        .selectOption(outcome);
    await dialog.getByRole('button', { name: 'Confirm review status', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  };
  await decide(
    finding().getByRole('button', { name: 'Mark triaged', exact: true }),
    'Inspected the recorded fixture.',
  );
  await finding().getByRole('button', { name: 'Start finding work', exact: true }).waitFor();
  await decide(
    finding().getByRole('button', { name: 'Start finding work', exact: true }),
    'Working on the recorded fixture.',
  );
  await decide(
    finding().getByRole('button', { name: 'Record resolution', exact: true }),
    'This fixture represents an operator false-positive decision.',
    'false_positive',
  );
  await waitFor(
    async () => (await findings.get(findingId)).status === 'resolved',
    'Persisted finding resolution',
  );
  assert.equal((await findings.get(findingId)).resolution.outcome, 'false_positive');
  await screen.getByRole('button', { name: 'Reopen report', exact: true }).waitFor();
  assert.equal((await reports.get(reportId)).lifecycle, 'completed');
  await decide(
    finding().getByRole('button', { name: 'Reopen finding', exact: true }),
    'Reopening the recorded fixture.',
  );
  await screen.getByRole('button', { name: 'Complete report', exact: true }).waitFor();
  assert.equal((await reports.get(reportId)).lifecycle, 'open');
  await screen.getByRole('button', { name: 'Complete report', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByText(/1 findings are still open/)
    .waitFor();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Keep reviewing', exact: true })
    .click();
  assert.equal((await reports.get(reportId)).lifecycle, 'open');
  await decide(
    screen.getByRole('button', { name: 'Skip report', exact: true }),
    'Defer recorded review follow-up.',
  );
  assert.equal((await reports.get(reportId)).lifecycle, 'skipped');
  await decide(
    screen.getByRole('button', { name: 'Reopen report', exact: true }),
    'Review this recorded report again.',
  );
  await screen
    .getByRole('combobox', { name: 'Review origin session', exact: true })
    .selectOption('recorded-native-session-b');
  assert.equal(
    await screen.getByRole('button', { name: `Open review ${reportId}`, exact: true }).count(),
    0,
  );
  await screen
    .getByRole('combobox', { name: 'Review origin session', exact: true })
    .selectOption('');
  await screen.getByText('Claimed and observed checks (1)', { exact: true }).click();
  await screen.getByText(/Claimed exit: 0 · Observed exit: 1/).waitFor();
  await screen.getByText('Full review report', { exact: true }).click();
  await screen.getByRole('heading', { name: 'Native recorded review', exact: true }).waitFor();
  await screen
    .getByRole('heading', { name: 'Chimera Reviews.', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifactDir, 'native-chimera-reviews.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(
    await screen.evaluate((element) => element.scrollWidth > element.clientWidth),
    false,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(artifactDir, 'native-chimera-compact.png'), fullPage: true });
  await page.setViewportSize({ width: 1480, height: 960 });
  // The finding's location opens the file at its recorded line.
  await screen.locator('.review-file-link').filter({ hasText: 'README.md:1' }).first().click();
  await page.locator('.file-source-line.search-match[data-source-line="1"]').waitFor();
  await open(project);
  screen = page.getByRole('region', { name: 'Project Chimera reviews' });
  await screen.getByRole('button', { name: `Open review ${reportId}`, exact: true }).click();
  assert.equal((await rpc('snapshot')).sessions.length, count);
  const target = await rpc('session.open', {
    projectId: project.id,
    kind: 'agent',
    title: 'Review follow-up target',
  });
  sessionIds.push(target.id);
  await waitFor(
    async () => (await rpc('engine.identity', { id: target.id })).sessionId,
    'Review follow-up engine ready',
    100000,
  );
  const draftRpc = (method, params) =>
    page.evaluate(
      ({ method, params }) => window.__TAURI_INTERNALS__.invoke('host_request', { method, params }),
      { method, params },
    );
  await draftRpc('draft.save', {
    id: target.id,
    text: 'Preserve the existing follow-up draft.',
    expectedRevision: 0,
  });
  await screen.getByText('Prepare a review follow-up', { exact: true }).click();
  await screen
    .getByRole('combobox', { name: 'Chimera follow-up conversation', exact: true })
    .selectOption(target.id);
  const beforeHandoff = (await reports.get(reportId)).lifecycle;
  await screen.getByRole('button', { name: 'Add review follow-up to draft', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Message WrongStack', exact: true })
    .waitFor({ timeout: 100000 });
  const draft = await draftRpc('draft.get', { id: target.id });
  assert.ok(draft.text.startsWith('Preserve the existing follow-up draft.\n\n'));
  assert.ok(draft.text.includes(reportId));
  assert.equal(
    (await reports.get(reportId)).lifecycle,
    beforeHandoff,
    'Draft preparation does not claim dispatch or mark a report actioned',
  );
  console.log(
    'PASS: native recorded Chimera reports across core sessions without conversations, citation/claimed evidence, notes and project isolation, triage/start/resolution/reopen with parent synchronization, report decisions/cancel, full Markdown report, compact layout and preserved review follow-up draft',
  );
}
