import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function exerciseNativeLiveFleet({
  page,
  rpc,
  waitFor,
  project,
  otherProject,
  artifactDir,
  configPath,
  sessionIds,
}) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  await writeFile(
    configPath,
    JSON.stringify({
      ...config,
      autonomy: { ...config.autonomy, defaultMode: 'off', enhance: false },
      maxIterations: 3,
      extensions: {
        ...config.extensions,
        'wstack-chimera': { enabled: false },
        'wstack-auto-review': { enabled: false },
      },
    }),
  );
  const openProject = async (target) => {
    await page.locator('.project-item').filter({ hasText: target.name }).click();
    await page.getByRole('button', { name: 'Open project live fleet', exact: true }).click();
    await page.getByRole('region', { name: 'Project live fleet', exact: true }).waitFor();
  };
  const panel = () => page.getByRole('region', { name: 'Project live fleet', exact: true });
  const http = async (target, resource) => {
    const reply = await rpc('project.http', {
      projectId: target.id,
      resource,
      method: 'GET',
      body: null,
    });
    assert.equal(reply.ok, true, JSON.stringify(reply.data));
    return reply.data;
  };
  await openProject(project);
  await panel()
    .getByRole('heading', { name: 'No registered conversation runtimes.', exact: true })
    .waitFor();
  assert.equal((await rpc('snapshot')).sessions.length, 0);
  const start = async (target, title) => {
    const session = await rpc('session.open', { projectId: target.id, kind: 'agent', title });
    sessionIds.push(session.id);
    const identity = await waitFor(
      async () => {
        const value = await rpc('engine.identity', { id: session.id });
        return value.sessionId ? value : null;
      },
      `${title} engine ready`,
      100000,
    );
    return { ...session, coreId: identity.sessionId };
  };
  const first = await start(project, 'Fleet Alpha One');
  await page.locator('.tree-session').filter({ hasText: 'Fleet Alpha One' }).click();
  await page
    .getByRole('textbox', { name: 'Message WrongStack', exact: true })
    .fill('Report the native fleet fixture result.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page
    .getByRole('heading', { name: 'Native result', exact: true })
    .waitFor({ timeout: 60000 });
  const second = await start(project, 'Fleet Alpha Two');
  const foreign = await start(otherProject, 'Fleet Beta One');
  await openProject(project);
  await panel().getByRole('button', { name: 'Runtime list', exact: true }).click();
  await panel().locator(`[data-live-session="${first.coreId}"]`).waitFor({ timeout: 30000 });
  await panel().locator(`[data-live-session="${second.coreId}"]`).waitFor();
  assert.equal((await panel().innerText()).includes(foreign.coreId), false);
  const cards = panel().locator('.live-fleet-list article');
  assert.equal(await cards.count(), 2, 'Private project-service carrier is excluded');
  await cards
    .filter({ hasText: first.coreId })
    .getByRole('button')
    .filter({ hasText: 'leader' })
    .click();
  await panel()
    .getByRole('complementary', { name: 'Live fleet detail', exact: true })
    .getByText('Agent ID', { exact: true })
    .waitFor();
  await panel().getByRole('button', { name: 'Execution map', exact: true }).click();
  await waitFor(
    async () => (await panel().locator('.react-flow__node').count()) >= 3,
    'Real session membership graph',
  );
  await panel().locator('.react-flow__node').filter({ hasText: 'Fleet Alpha One' }).waitFor();
  await panel().getByRole('button', { name: 'Read recent session activity', exact: true }).click();
  const activity = panel().getByRole('region', {
    name: 'Recent fleet session activity',
    exact: true,
  });
  await activity.getByText('Report the native fleet fixture result.', { exact: true }).waitFor();
  await activity.getByRole('heading', { name: 'Native result', exact: true }).waitFor();
  await activity.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifactDir, 'native-live-fleet-activity.png'),
    fullPage: true,
  });
  await panel().getByRole('heading', { name: 'Live fleet', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifactDir, 'native-live-fleet-map.png'), fullPage: true });
  await panel().getByRole('button', { name: 'Send session instruction', exact: true }).click();
  let review = page.getByRole('dialog', { name: 'Review session instruction', exact: true });
  await review.getByLabel('Fleet instruction priority', { exact: true }).selectOption('normal');
  await review
    .getByLabel('Fleet instruction subject', { exact: true })
    .fill('Native reviewed fleet subject');
  await review
    .getByLabel('Fleet request text', { exact: true })
    .fill('Native fleet reviewed note.');
  await review.getByRole('button', { name: 'Keep reviewing fleet', exact: true }).click();
  let thread = await http(project, `/api/sessions/${encodeURIComponent(first.coreId)}/mailbox`);
  assert.equal(
    thread.thread.some((row) => row.body === 'Native fleet reviewed note.'),
    false,
  );
  await panel().getByRole('button', { name: 'Send session instruction', exact: true }).click();
  assert.equal(
    await review.getByLabel('Fleet request text', { exact: true }).inputValue(),
    'Native fleet reviewed note.',
  );
  await review.getByRole('button', { name: 'Confirm session request', exact: true }).click();
  await review.waitFor({ state: 'detached' });
  await panel()
    .getByRole('status')
    .filter({ hasText: 'Request delivered to session mailbox' })
    .waitFor();
  thread = await http(project, `/api/sessions/${encodeURIComponent(first.coreId)}/mailbox`);
  assert.ok(
    thread.thread.some(
      (row) =>
        row.body === 'Native fleet reviewed note.' &&
        row.priority === 'normal' &&
        row.subject === 'Native reviewed fleet subject',
    ),
  );
  assert.equal(
    thread.thread.filter(
      (row) => row.body === 'Native fleet reviewed note.' && row.from === 'human@desktop',
    ).length,
    1,
  );
  assert.equal(
    (await http(project, `/api/sessions/${encodeURIComponent(second.coreId)}/mailbox`)).thread.some(
      (row) => row.body === 'Native fleet reviewed note.',
    ),
    false,
  );
  await panel().getByRole('button', { name: 'Request session interruption', exact: true }).click();
  review = page.getByRole('dialog', { name: 'Review session interruption', exact: true });
  await review
    .getByLabel('Fleet request text', { exact: true })
    .fill('Native reviewed cooperative interrupt');
  await review.getByRole('button', { name: 'Confirm session request', exact: true }).click();
  await review.waitFor({ state: 'detached' });
  thread = await http(project, `/api/sessions/${encodeURIComponent(first.coreId)}/mailbox`);
  assert.ok(
    thread.thread.some(
      (row) => row.subject === 'interrupt' && row.body === 'Native reviewed cooperative interrupt',
    ),
  );
  // One message to every live runtime of this project reaches each of them and no other project.
  await panel().getByRole('button', { name: 'Message all runtimes…', exact: true }).click();
  await panel()
    .getByLabel('Message to every live runtime in this project', { exact: true })
    .fill('Native fleet broadcast.');
  await panel().getByRole('button', { name: 'Send to all', exact: true }).click();
  await panel()
    .getByRole('status')
    .filter({ hasText: /^Delivered to \d+ session mailbox/ })
    .waitFor();
  for (const session of [first, second])
    assert.ok(
      (
        await http(project, `/api/sessions/${encodeURIComponent(session.coreId)}/mailbox`)
      ).thread.some((row) => row.body === 'Native fleet broadcast.' && row.type === 'steer'),
      `Broadcast reached ${session.coreId}`,
    );
  assert.equal(
    // The mailbox route resolves any registered session, so this project's engine reads it.
    (
      await http(project, `/api/sessions/${encodeURIComponent(foreign.coreId)}/mailbox`)
    ).thread.some((row) => row.body === 'Native fleet broadcast.'),
    false,
    'The broadcast stayed inside the project',
  );
  await page.setViewportSize({ width: 800, height: 640 });
  await panel().getByRole('heading', { name: 'Live fleet', exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-live-fleet-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  const dark = page.getByRole('button', { name: 'Switch to dark mode', exact: true });
  if (await dark.count()) await dark.click();
  await panel().getByRole('heading', { name: 'Live fleet', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifactDir, 'native-live-fleet-dark.png'), fullPage: true });
  await openProject(otherProject);
  await panel().getByRole('button', { name: 'Runtime list', exact: true }).click();
  await panel().locator(`[data-live-session="${foreign.coreId}"]`).waitFor();
  assert.equal((await panel().innerText()).includes(first.coreId), false);
  assert.equal((await rpc('snapshot')).sessions.length, 3);
  console.log(
    'PASS: actual project-scoped live runtime/agent list and membership graph, private carrier exclusion, two-project isolation, reviewed mailbox note/interruption receipts, retained unsent request, compact and theme layouts; no worker or conversation created by browsing',
  );
}
