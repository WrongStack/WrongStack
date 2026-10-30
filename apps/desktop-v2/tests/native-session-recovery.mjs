import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { resolveWstackPaths, sessionScopedPath } from '../../../packages/core/dist/utils/index.js';
import { fixtureKey, fixtureModel, fixtureText } from './local-provider.mjs';

export async function exerciseNativeSessionRecovery({
  page,
  rpc,
  waitFor,
  project,
  wrongstackHome,
  artifactDir,
  sessionIds,
  providerFixture,
  configPath,
}) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  // Only the isolated test profile: real local protocol fixture, no external credential.
  await writeFile(
    configPath,
    JSON.stringify({
      ...config,
      provider: 'recovery-local',
      model: fixtureModel,
      autonomy: { ...config.autonomy, defaultMode: 'off', enhance: false },
      maxIterations: 3,
      extensions: {
        ...config.extensions,
        'wstack-chimera': { enabled: false },
        'wstack-auto-review': { enabled: false },
      },
      providers: {
        ...config.providers,
        'recovery-local': {
          type: 'openai-compatible',
          family: 'openai-compatible',
          baseUrl: providerFixture.baseUrl,
          models: [fixtureModel],
          customModels: {
            [fixtureModel]: { name: fixtureModel, capabilities: { streaming: true, tools: true } },
          },
          apiKeys: [{ label: 'fixture', apiKey: fixtureKey }],
          activeKey: 'fixture',
        },
      },
    }),
  );
  const target = await rpc('session.open', {
    projectId: project.id,
    kind: 'agent',
    title: 'Recovery proof',
  });
  sessionIds.push(target.id);
  const identity = await waitFor(
    async () => {
      const data = await rpc('engine.identity', { id: target.id });
      return data.sessionId ? data : null;
    },
    'Recovery runtime ready',
    100000,
  );
  let offset = 0;
  const call = async (type, payload = {}) => {
    const requestId = crypto.randomUUID();
    await rpc('engine.send', {
      id: target.id,
      message: { type, payload: { ...payload, requestId } },
    });
    const reply = await waitFor(
      async () => {
        const batch = await rpc('engine.events', { id: target.id, offset });
        offset = batch.offset;
        return batch.events.find((event) => event.payload?.requestId === requestId)?.payload;
      },
      `Recovery ${type}`,
      60000,
    );
    if (reply.success === false || reply.error) throw Error(reply.error ?? reply.message);
    return reply;
  };
  const status = await call('chronicle.status');
  assert.equal((await call('prefs.get')).enhanceEnabled, false);
  const paths = resolveWstackPaths({ projectRoot: status.projectRoot, globalRoot: wrongstackHome });
  assert.ok(
    resolve(paths.projectSessions)
      .toLowerCase()
      .startsWith(resolve(wrongstackHome).toLowerCase() + sep),
  );
  const journal = sessionScopedPath(paths.projectSessions, identity.sessionId, '.jsonl');
  const file = join(status.projectRoot, 'recovery-proof.txt');
  const append = async (events) =>
    appendFile(
      journal,
      events.map((event) => JSON.stringify({ ts: new Date().toISOString(), ...event })).join('\n') +
        '\n',
    );
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Mission control', exact: true })
    .click();
  await page
    .locator('.session-card')
    .filter({ hasText: 'Recovery proof' })
    .locator('.session-card-main')
    .click();
  const input = page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  await input.waitFor({ timeout: 100000 });
  const send = async (text) => {
    await input.fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
  };
  await send('First recovery prompt. Confirm the connection without tools.');
  await page.getByText(fixtureText, { exact: true }).waitFor();
  await waitFor(
    async () => !(await page.getByRole('button', { name: 'Stop run', exact: true }).count()),
    'First real turn completed',
  );
  const first = await call('session.checkpoints', { includeRevision: true });
  assert.equal(first.checkpoints.length, 1);
  const firstIndex = first.checkpoints[0].promptIndex;
  // Recorded file snapshots are explicit fixtures; the local model did not edit these files.
  await writeFile(file, 'after first prompt');
  await send('[native-composer-hold-recovery] Second recovery prompt. Confirm without tools.');
  await waitFor(() => providerFixture.holds.has('recovery'), 'Second local model turn held');
  const open = async () => {
    await page
      .getByRole('navigation', { name: 'Agent workspace views' })
      .getByRole('button', { name: 'Tools', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Session tools' })
      .getByRole('button', { name: /History & recovery/ })
      .click();
    await page.getByRole('region', { name: 'Session history and recovery' }).waitFor();
  };
  await open();
  const screen = page.getByRole('region', { name: 'Session history and recovery' });
  await screen
    .getByText('Stop the active run and refresh before reviewing a rewind.', { exact: true })
    .waitFor();
  await assert.rejects(call('session.rewind', { checkpointIndex: firstIndex }), /active/);
  providerFixture.releaseHold('recovery');
  await waitFor(
    async () => {
      const events = await rpc('engine.events', { id: target.id, offset: 0 });
      return events.events.filter((event) => event.type === 'run.result').length >= 2;
    },
    'Second actual turn complete',
    60000,
  );
  const second = await call('session.checkpoints', { includeRevision: true });
  assert.equal(second.checkpoints.length, 2);
  const secondIndex = second.checkpoints[1].promptIndex;
  await writeFile(file, 'after second prompt');
  // Seed both historical snapshots only after all model turns stop writing the journal.
  await append([
    {
      type: 'file_snapshot',
      promptIndex: firstIndex,
      files: [
        {
          path: file,
          action: 'modified',
          before: 'before recovery prompts',
          after: 'after first prompt',
        },
      ],
    },
    { type: 'file_event', operation: 'write', filePath: file, toolName: 'recorded_fixture' },
    {
      type: 'file_snapshot',
      promptIndex: secondIndex,
      files: [
        {
          path: file,
          action: 'modified',
          before: 'after first prompt',
          after: 'after second prompt',
        },
      ],
    },
  ]);
  await screen.getByRole('button', { name: 'Refresh session history', exact: true }).click();
  const review = () =>
    screen.getByRole('button', { name: `Review rewind to prompt ${firstIndex}`, exact: true });
  await waitFor(async () => await review().isEnabled(), 'Stable checkpoint available');
  await screen.getByRole('button', { name: 'Back to chat', exact: true }).click();
  assert.equal(await page.getByText(fixtureText, { exact: true }).count(), 2);
  await input.fill('Keep my separate composer draft');
  const draftRpc = (method, params) =>
    page.evaluate(
      ({ method, params }) => window.__TAURI_INTERNALS__.invoke('host_request', { method, params }),
      { method, params },
    );
  await waitFor(
    async () =>
      (await draftRpc('draft.get', { id: target.id })).text === 'Keep my separate composer draft',
    'Composer draft persisted',
  );
  await open();
  await waitFor(async () => await review().isEnabled(), 'Checkpoint review loaded');
  const beforeRewind = await call('session.inspect', { id: identity.sessionId });
  assert.equal(beforeRewind.retainedMessageCount, 4);
  assert.equal(beforeRewind.journalTokenTotal, 210);
  await screen
    .getByRole('heading', { name: 'History & recovery.', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifactDir, 'native-session-history.png'), fullPage: true });
  await screen
    .getByRole('textbox', { name: 'Search recorded session events', exact: true })
    .fill('Second recovery prompt');
  await screen
    .getByRole('list')
    .getByText(/Second recovery prompt/)
    .first()
    .waitFor();
  await screen
    .getByRole('textbox', { name: 'Search recorded session events', exact: true })
    .fill('no-such-recorded-event');
  await screen.getByText('No recorded events match.', { exact: true }).waitFor();
  await screen
    .getByRole('textbox', { name: 'Search recorded session events', exact: true })
    .fill('');
  await review().click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Keep current history', exact: true })
    .click();
  assert.equal(await readFile(file, 'utf8'), 'after second prompt');
  await review().click();
  const lateIndex = secondIndex + 1;
  await append([
    { type: 'checkpoint', promptIndex: lateIndex, promptPreview: 'Late recorded checkpoint' },
  ]);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm checkpoint rewind', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByText(
      'The session changed after this review. Close this dialog and refresh checkpoints.',
      { exact: true },
    )
    .waitFor();
  assert.equal(await readFile(file, 'utf8'), 'after second prompt');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Keep current history', exact: true })
    .click();
  await screen.getByRole('button', { name: 'Refresh session history', exact: true }).click();
  await screen
    .getByRole('button', { name: `Review rewind to prompt ${lateIndex}`, exact: true })
    .waitFor();
  await review().click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm checkpoint rewind', exact: true })
    .click();
  await screen.getByRole('heading', { name: 'Rewind completed', exact: true }).waitFor();
  assert.equal(await readFile(file, 'utf8'), 'before recovery prompts');
  // Redo brings the prompts and the file back; rewinding again restores the state checked below.
  await screen.getByRole('button', { name: 'Redo last rewind', exact: true }).click();
  await screen.getByRole('heading', { name: 'Rewind redone', exact: true }).waitFor();
  assert.equal(await readFile(file, 'utf8'), 'after second prompt');
  await review().click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm checkpoint rewind', exact: true })
    .click();
  await screen.getByRole('heading', { name: 'Rewind completed', exact: true }).waitFor();
  assert.equal(await readFile(file, 'utf8'), 'before recovery prompts');
  // Each operation leaves a durable record, newest first, as the engine reported it.
  const records = screen.locator('details.recovery-records');
  await records.locator('summary').click();
  const recorded = records.getByRole('list', { name: 'Recovery operations', exact: true });
  await recorded
    .locator(':scope > li')
    .first()
    .filter({ hasText: /^Rewind · checkpoint/ })
    .waitFor();
  await recorded.locator(':scope > li').filter({ hasText: 'Redo last rewind' }).first().waitFor();
  assert.match(await recorded.locator(':scope > li').first().innerText(), /Completed/);
  await records.locator('summary').click();
  // The rewound prompt is offered for editing; the composer's unsent draft is kept unless the
  // replacement is chosen explicitly.
  const rewoundPrompt = screen.locator('.recovery-rewound-prompt');
  await rewoundPrompt
    .getByText('First recovery prompt. Confirm the connection without tools.', { exact: true })
    .waitFor();
  await rewoundPrompt.getByRole('button', { name: 'Edit and resend', exact: true }).click();
  await rewoundPrompt.getByText('The composer has unsent text.', { exact: true }).waitFor();
  await rewoundPrompt.getByRole('button', { name: 'Keep current draft', exact: true }).click();
  await rewoundPrompt.getByRole('button', { name: 'Edit and resend', exact: true }).waitFor();
  const loaded = await call('session.inspect', { id: identity.sessionId });
  assert.equal(loaded.retainedMessageCount, 0);
  assert.equal(loaded.journalTokenTotal, 0);
  assert.equal(
    loaded.events.some((event) => event.label.includes('Second recovery prompt')),
    false,
  );
  await screen
    .getByRole('heading', { name: 'History & recovery.', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifactDir, 'native-session-recovery.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(
    await screen.evaluate((element) => element.scrollWidth > element.clientWidth),
    false,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-session-recovery-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  const outside = join(wrongstackHome, 'recovery-outside-proof.txt');
  await writeFile(outside, 'protected outside-project content');
  const errorIndex = lateIndex + 1;
  await append([
    {
      type: 'checkpoint',
      promptIndex: errorIndex,
      promptPreview: 'Recorded partial restore proof',
    },
    {
      type: 'file_snapshot',
      promptIndex: errorIndex,
      files: [
        {
          path: outside,
          action: 'modified',
          before: 'must not be written',
          after: 'protected outside-project content',
        },
      ],
    },
  ]);
  await screen.getByRole('button', { name: 'Refresh session history', exact: true }).click();
  const errorReview = screen.getByRole('button', {
    name: `Review rewind to prompt ${errorIndex}`,
    exact: true,
  });
  await waitFor(async () => await errorReview.isEnabled(), 'Partial restoration checkpoint');
  await errorReview.click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm checkpoint rewind', exact: true })
    .click();
  await screen
    .getByRole('heading', {
      name: 'Conversation rewound · file errors need attention',
      exact: true,
    })
    .waitFor();
  assert.equal(await readFile(outside, 'utf8'), 'protected outside-project content');
  await screen
    .getByRole('heading', {
      name: 'Conversation rewound · file errors need attention',
      exact: true,
    })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifactDir, 'native-session-recovery-partial.png'),
    fullPage: true,
  });
  await screen.getByRole('button', { name: 'Back to chat', exact: true }).click();
  assert.equal(await page.getByText(fixtureText, { exact: true }).count(), 0);
  assert.equal(await input.inputValue(), 'Keep my separate composer draft');
  assert.equal(
    (await draftRpc('draft.get', { id: target.id })).text,
    'Keep my separate composer draft',
  );
  console.log(
    'PASS: native real local-model session inspection/search and retained-message/usage counters, active-run refusal, reviewed rewind cancel/staleness, recorded file snapshot/journal/live-transcript rewind, visible partial restoration errors with protected outside file, preserved composer draft and compact layout',
  );
}
