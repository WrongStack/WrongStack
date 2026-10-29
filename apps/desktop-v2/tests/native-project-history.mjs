import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { DefaultSessionStore } from '../../../packages/core/dist/storage/index.js';
import { resolveWstackPaths, sessionScopedPath } from '../../../packages/core/dist/utils/index.js';
import { exerciseNativeHistoryPaging } from './native-history-paging.mjs';
import { revealProjectTools } from './native-project-navigation.mjs';

export async function exerciseNativeProjectHistory({
  page,
  rpc,
  waitFor,
  project,
  otherProject,
  wrongstackHome,
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
      `Project history ${type}`,
      60000,
    );
    if (result.success === false || result.error) throw Error(result.error ?? result.message);
    return result;
  };
  const beforeCount = (await rpc('snapshot')).sessions.length;
  const identity = await call('chronicle.status');
  const paths = resolveWstackPaths({
    projectRoot: identity.projectRoot,
    globalRoot: wrongstackHome,
  });
  assert.ok(
    resolve(paths.projectSessions)
      .toLowerCase()
      .startsWith(resolve(wrongstackHome).toLowerCase() + sep),
  );
  const store = new DefaultSessionStore({
    dir: paths.projectSessions,
    projectRoot: identity.projectRoot,
  });
  const writer = await store.create({
    id: '',
    title: 'Recorded history fixture',
    model: 'recorded-history-model',
    provider: 'recorded-history-provider',
  });
  const id = writer.id;
  const longText = 'Recorded long response. '.repeat(2400) + 'late-history-needle';
  const messages = [
    {
      role: 'user',
      origin: 'user_input',
      authoredLength: 3,
      content: [
        { type: 'text', text: 'Recorded opening prompt. Read the [project README](README.md).' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'opaque-image-fixture-not-for-rendering',
          },
        },
        {
          type: 'document',
          name: 'recorded-notes.pdf',
          text: 'Recorded extracted document text.',
          pages: 2,
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: 'opaque-pdf-fixture-not-for-rendering',
          },
        },
      ],
    },
    { role: 'assistant', content: longText },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'recorded-tool',
          name: 'recorded_test',
          input: { command: 'test-fixture-only', scope: ['one', 'two'] },
        },
      ],
    },
    {
      role: 'user',
      origin: 'runtime',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'recorded-tool',
          name: 'recorded_test',
          content: 'Recorded test result: PASS. No command executed by this UI fixture.',
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'Recorded reasoning fixture.',
          signature: 'opaque-signature-not-for-rendering',
        },
      ],
    },
    ...Array.from({ length: 19 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      origin: index % 2 ? undefined : 'user_input',
      content: `History retained message ${index + 6}`,
    })),
  ];
  try {
    for (const message of messages)
      await writer.append({
        type: 'message_appended',
        version: 1,
        ts: new Date().toISOString(),
        message,
      });
    await writer.flush();
  } finally {
    await writer.close();
  }
  await store.rename(id, 'Archive notebook');
  const searchable = [];
  for (let index = 0; index < 6; index++) {
    const archive = await store.create({ id: '', title: '', model: 'test', provider: 'test' });
    await archive.append({
      type: 'message_appended',
      version: 1,
      ts: new Date().toISOString(),
      message: { role: 'assistant', content: `Shared-search-needle in archive ${index}` },
    });
    await archive.close();
    await store.rename(archive.id, `Search notebook ${index + 1}`);
    searchable.push(archive.id);
  }
  await store.dispose();
  const journal = sessionScopedPath(paths.projectSessions, id, '.jsonl');
  const original = await readFile(journal, 'utf8');
  const recordedCatalog = await call('sessions.list', { limit: 100, includeContentState: true });
  await writeFile(
    join(artifactDir, 'history-catalog-proof.json'),
    JSON.stringify(recordedCatalog.sessions),
  );
  assert.ok(
    recordedCatalog.sessions.some((row) => row.id === id),
    'The canonical project catalog contains the fixture journal',
  );
  assert.equal(
    recordedCatalog.sessions.find((row) => row.id === id).isEmpty,
    false,
    'Actual retained content is independent of zero summary counters',
  );
  const open = async (owner = project) => {
    await page.locator('.project-item').filter({ hasText: owner.name }).click();
    await revealProjectTools(page, owner);
    await page
      .getByRole('navigation', { name: `${owner.name} workspace` })
      .getByRole('button', { name: 'Session history', exact: true })
      .click();
    await page.getByRole('region', { name: 'Project session history' }).waitFor();
  };
  await open();
  const screen = page.getByRole('region', { name: 'Project session history' });
  await screen.getByRole('button', { name: `Open history ${id}`, exact: true }).click();
  let transcript = page.getByRole('region', { name: 'Recorded session transcript' });
  await transcript.getByText('Recorded opening prompt.', { exact: false }).first().waitFor();
  await transcript.getByText('Image attachment', { exact: true }).waitFor();
  await transcript.getByText('recorded-notes.pdf', { exact: true }).waitFor();
  assert.equal((await page.content()).includes('opaque-image-fixture-not-for-rendering'), false);
  // Image bytes load only on request; the fixture's placeholder is not valid image data, so the
  // engine refuses it and nothing is rendered.
  await transcript.getByRole('button', { name: 'Show image', exact: true }).click();
  await transcript
    .getByRole('alert')
    .filter({ hasText: 'The stored image data is not valid.' })
    .waitFor();
  assert.equal((await page.content()).includes('opaque-image-fixture-not-for-rendering'), false);
  assert.equal((await page.content()).includes('opaque-pdf-fixture-not-for-rendering'), false);
  assert.equal((await page.content()).includes('opaque-signature-not-for-rendering'), false);
  const longMessage = transcript.getByRole('article', { name: 'Recorded message 2', exact: true });
  for (let part = 0; part < 8; part++) {
    const more = longMessage.getByRole('button', { name: 'Read next text part', exact: true });
    if (!(await more.count())) break;
    await more.click();
    await waitFor(
      async () =>
        !(await longMessage.getByRole('button', { name: 'Reading…', exact: true }).count()),
      'Long transcript part read',
    );
  }
  await longMessage.getByText(/late-history-needle/).waitFor();
  await transcript.getByText('Tool request · recorded_test', { exact: true }).click();
  await transcript.getByText('test-fixture-only', { exact: true }).waitFor();
  await transcript.getByText('Recorded reasoning', { exact: true }).click();
  await transcript.getByText('Recorded reasoning fixture.', { exact: true }).waitFor();
  await screen
    .getByRole('heading', { name: 'Session history.', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifactDir, 'native-project-history.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(
    await screen.evaluate((element) => element.scrollWidth > element.clientWidth),
    false,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-project-history-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await transcript
    .getByRole('textbox', { name: 'Search full retained transcript', exact: true })
    .fill('late-history-needle');
  await transcript.getByRole('button', { name: 'Search transcript', exact: true }).click();
  await transcript.getByText(/late-history-needle/).waitFor();
  assert.equal(await transcript.getByRole('article').count(), 1);
  await transcript
    .getByRole('textbox', { name: 'Search full retained transcript', exact: true })
    .fill('no-history-match');
  await transcript.getByRole('button', { name: 'Search transcript', exact: true }).click();
  await transcript.getByText('No retained messages match this search.', { exact: true }).waitFor();
  await transcript
    .getByRole('textbox', { name: 'Search full retained transcript', exact: true })
    .fill('');
  await transcript.getByRole('button', { name: 'Search transcript', exact: true }).click();
  await transcript.getByRole('article', { name: 'Recorded message 1', exact: true }).waitFor();
  // A later retained message invalidates the previous pagination snapshot.
  const addedEvent =
    JSON.stringify({
      type: 'message_appended',
      version: 1,
      ts: new Date().toISOString(),
      message: { role: 'user', content: 'Later retained history edit' },
    }) + '\n';
  await appendFile(journal, addedEvent);
  await transcript.getByRole('button', { name: 'Load next 10 messages', exact: true }).click();
  await transcript
    .getByText('The transcript changed. Refresh before loading more history.', { exact: true })
    .waitFor();
  await transcript.getByRole('button', { name: 'Refresh transcript', exact: true }).click();
  await transcript.getByRole('article', { name: 'Recorded message 1', exact: true }).waitFor();
  await transcript.getByRole('button', { name: 'Load next 10 messages', exact: true }).click();
  await transcript.getByRole('article', { name: 'Recorded message 20', exact: true }).waitFor();
  await transcript.getByRole('button', { name: 'Load next 10 messages', exact: true }).click();
  await transcript.getByText('Later retained history edit', { exact: true }).waitFor();
  await screen.getByRole('button', { name: 'Rename recorded session', exact: true }).click();
  await call('session.rename', { id, name: 'Name changed by a peer' });
  await page
    .getByRole('dialog')
    .getByRole('textbox', { name: 'Recorded session name', exact: true })
    .fill('Reviewed history notebook');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Save recorded name', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByText('This session name changed elsewhere. Cancel and refresh before renaming.', {
      exact: true,
    })
    .waitFor();
  assert.equal(
    (await call('sessions.list', { limit: 100 })).sessions.find((row) => row.id === id).name,
    'Name changed by a peer',
  );
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Keep recorded name', exact: true })
    .click();
  await screen.getByRole('button', { name: 'Refresh session history', exact: true }).click();
  await screen.getByRole('heading', { name: 'Name changed by a peer', exact: true }).waitFor();
  await screen.getByRole('button', { name: 'Rename recorded session', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('textbox', { name: 'Recorded session name', exact: true })
    .fill('Reviewed history notebook');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Save recorded name', exact: true })
    .click();
  await screen.getByText('Recorded session name saved and verified.', { exact: true }).waitFor();
  assert.equal(
    (await call('sessions.list', { limit: 100 })).sessions.find((row) => row.id === id).name,
    'Reviewed history notebook',
  );
  assert.equal(
    await readFile(journal, 'utf8'),
    original + addedEvent,
    'Reading and renaming do not append or rewrite the session journal',
  );
  await screen.getByText('Search across conversations', { exact: true }).click();
  const search = page.getByRole('region', {
    name: 'Search across project conversations',
    exact: true,
  });
  await search
    .getByRole('textbox', { name: 'Search conversation content', exact: true })
    .fill('shared-search-needle');
  await search.getByRole('button', { name: 'Search conversations', exact: true }).click();
  await search.getByRole('button', { name: 'Stop search', exact: true }).click();
  await waitFor(
    async () =>
      await search.getByRole('button', { name: 'Search conversations', exact: true }).isEnabled(),
    'Stopped content search drains its current read batch',
    90000,
  );
  assert.match(await search.getByRole('status').innerText(), /Stopped\./);
  const searchFor = async (query, role = '') => {
    await search
      .getByRole('textbox', { name: 'Search conversation content', exact: true })
      .fill(query);
    await search
      .getByRole('combobox', { name: 'Conversation search role', exact: true })
      .selectOption(role);
    await search.getByRole('button', { name: 'Search conversations', exact: true }).click();
    await search.getByRole('status').filter({ hasText: 'Search complete.' }).waitFor();
  };
  await searchFor('shared-search-needle');
  assert.equal(await search.locator('.history-search-results article').count(), 6);
  for (const archiveId of searchable) {
    assert.equal(
      await search
        .getByRole('button', { name: `Read search match ${archiveId} message 1`, exact: true })
        .count(),
      1,
    );
  }
  await searchFor('opaque-image-fixture');
  await search
    .getByText('No retained conversation text matches this search.', { exact: true })
    .waitFor();
  await searchFor('late-history-needle', 'user');
  await search
    .getByText('No retained conversation text matches this search.', { exact: true })
    .waitFor();
  await searchFor('late-history-needle', 'assistant');
  const match = search.getByRole('button', {
    name: `Read search match ${id} message 2`,
    exact: true,
  });
  await match.click();
  transcript = page.getByRole('region', { name: 'Recorded session transcript', exact: true });
  await transcript.getByRole('article', { name: 'Recorded message 2', exact: true }).waitFor();
  assert.equal(await transcript.getByRole('article').count(), 1);
  const searchChange =
    JSON.stringify({
      type: 'message_appended',
      version: 1,
      ts: new Date().toISOString(),
      message: { role: 'assistant', content: 'Later search revision control' },
    }) + '\n';
  await appendFile(journal, searchChange);
  const expectedJournal = original + addedEvent + searchChange;
  await match.click();
  await transcript
    .getByText('The transcript changed. Refresh before loading more history.', { exact: true })
    .waitFor();
  await transcript.getByRole('button', { name: 'Refresh transcript', exact: true }).click();
  await transcript.getByRole('article', { name: 'Recorded message 2', exact: true }).waitFor();
  await page.screenshot({ path: join(artifactDir, 'history-content-search.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(
    await screen.evaluate((element) => element.scrollWidth > element.clientWidth),
    false,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'history-content-search-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  console.log(
    'PASS: cross-session retained-text search over multiple read batches, role/media controls and revision-checked navigation',
  );
  await open(otherProject);
  const isolated = await call(
    'sessions.list',
    { contentSearch: { query: 'shared-search-needle', window: 100 } },
    otherProject,
  );
  assert.equal(isolated.contentSearch.results.length, 0);
  await assert.rejects(
    call('session.inspect', { id, transcriptOnly: true, transcript: { offset: 0 } }, otherProject),
    /not found|ENOENT|no such|does not exist/i,
  );
  await page.getByRole('checkbox', { name: 'Include empty journals', exact: true }).check();
  assert.equal(
    await page.getByRole('button', { name: `Open history ${id}`, exact: true }).count(),
    0,
  );
  assert.equal((await rpc('snapshot')).sessions.length, beforeCount);
  const target = await rpc('session.open', {
    projectId: project.id,
    kind: 'agent',
    title: 'History draft target',
  });
  sessionIds.push(target.id);
  const core = await waitFor(
    async () => {
      const value = await rpc('engine.identity', { id: target.id });
      return value.sessionId ? value : null;
    },
    'History target engine ready',
    100000,
  );
  const draftRpc = (method, params) =>
    page.evaluate(
      ({ method, params }) => window.__TAURI_INTERNALS__.invoke('host_request', { method, params }),
      { method, params },
    );
  await draftRpc('draft.save', {
    id: target.id,
    text: 'Keep this existing draft.',
    expectedRevision: 0,
  });
  await open();
  await page.getByRole('button', { name: `Open history ${id}`, exact: true }).click();
  transcript = page.getByRole('region', { name: 'Recorded session transcript' });
  await transcript
    .getByRole('article', { name: 'Recorded message 1', exact: true })
    .getByRole('button', { name: 'Add visible text to draft', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('combobox', { name: 'History draft destination', exact: true })
    .selectOption(target.id);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Append recorded text to draft', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'Message WrongStack', exact: true })
    .waitFor({ timeout: 100000 });
  assert.ok(
    (await draftRpc('draft.get', { id: target.id })).text.startsWith(
      'Keep this existing draft.\n\nRecorded opening prompt.',
    ),
  );
  await open();
  await page.getByRole('checkbox', { name: 'Include empty journals', exact: true }).check();
  await page.getByRole('button', { name: `Open history ${core.sessionId}`, exact: true }).click();
  await page.getByRole('button', { name: 'Open desktop conversation', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message WrongStack', exact: true }).waitFor();
  assert.equal((await rpc('engine.identity', { id: target.id })).sessionId, core.sessionId);
  assert.equal((await rpc('snapshot')).sessions.length, beforeCount + 1);
  const nativeRequest = (method, params) =>
    page.evaluate(
      ({ method, params }) => window.__TAURI_INTERNALS__.invoke('host_request', { method, params }),
      { method, params },
    );
  await assert.rejects(
    nativeRequest('session.restore', { projectId: project.id }),
    /Missing history source/,
  );
  const restoreThroughUi = async (mode) => {
    await open();
    await page.getByRole('button', { name: `Open history ${id}`, exact: true }).click();
    await page
      .getByRole('button', {
        name: mode === 'fork' ? 'Continue a copy' : 'Resume recorded conversation',
        exact: true,
      })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Keep reading', exact: true })
      .click();
    assert.equal((await rpc('snapshot')).sessions.length, beforeCount + (mode === 'fork' ? 1 : 2));
    await page
      .getByRole('button', {
        name: mode === 'fork' ? 'Continue a copy' : 'Resume recorded conversation',
        exact: true,
      })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', {
        name: mode === 'fork' ? 'Open separate copy' : 'Open original conversation',
        exact: true,
      })
      .click();
    const opened = await waitFor(
      async () => {
        const snapshot = await rpc('snapshot');
        return snapshot.sessions.find(
          (session) => !sessionIds.includes(session.id) && session.kind === 'agent',
        );
      },
      `Native ${mode} tab`,
      10000,
    );
    sessionIds.push(opened.id);
    const identity = await waitFor(
      async () => {
        const snapshot = await rpc('snapshot');
        const status = snapshot.sessions.find((session) => session.id === opened.id);
        if (status?.status === 'error') throw Error(status.error);
        const identity = await rpc('engine.identity', { id: opened.id });
        return identity.sessionId ? identity : null;
      },
      `Native ${mode} engine`,
      100000,
    );
    await page
      .getByRole('textbox', { name: 'Message WrongStack', exact: true })
      .waitFor({ timeout: 100000 });
    await page.getByText('Recorded opening prompt.', { exact: false }).first().waitFor();
    return { opened, identity };
  };
  const fork = await restoreThroughUi('fork');
  console.log('PASS: native history fork opens an independent recorded conversation');
  assert.notEqual(fork.identity.sessionId, id);
  assert.equal(
    await readFile(journal, 'utf8'),
    expectedJournal,
    'Fork leaves the parent journal unchanged',
  );
  const resumed = await restoreThroughUi('resume');
  console.log('PASS: native history resume reopens the original recorded identity');
  assert.equal(resumed.identity.sessionId, id);
  const beforeDuplicate = await readFile(journal, 'utf8');
  const duplicate = await nativeRequest('session.restore', {
    projectId: project.id,
    history: { id, mode: 'resume' },
  });
  sessionIds.push(duplicate.id);
  const refused = await waitFor(
    async () => {
      const row = (await rpc('snapshot')).sessions.find((session) => session.id === duplicate.id);
      return row?.status === 'error' ? row : null;
    },
    'Duplicate archive ownership refused',
    100000,
  );
  assert.match(refused.error, /already open in another running wstack/i);
  await assert.rejects(rpc('engine.identity', { id: duplicate.id }), /starting/);
  assert.equal(
    await readFile(journal, 'utf8'),
    beforeDuplicate,
    'A refused second writer leaves the original journal unchanged',
  );
  for (const session of [fork.opened, resumed.opened]) {
    const frames = await rpc('engine.events', { id: session.id, offset: 0 });
    assert.equal(
      frames.events.some((frame) => frame.type === 'desktop.user_message'),
      false,
      'Opening recorded work sends no new prompt',
    );
  }
  await page.screenshot({ path: join(artifactDir, 'history-resumed.png'), fullPage: true });
  await exerciseNativeHistoryPaging({
    page,
    rpc,
    call,
    open,
    paths,
    projectRoot: identity.projectRoot,
    project,
    otherProject,
    waitFor,
    artifactDir,
  });
  console.log(
    'PASS: native project history without conversations, bounded multimodal transcript/long-text paging and full retained-text search, stale-page refusal, verified rename, project isolation, preserved draft reuse and reopening the existing native conversation without another writer',
  );
}
