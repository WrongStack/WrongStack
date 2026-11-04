import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * SAGE applicability ("Valid when" plus up to four source checks) authored in the shared SAGE
 * record editor. The desktop host offers no source-review lens, so current-file evidence is read
 * through the engine's own review request (`memory.sage.get` with `reviewValidity`).
 */
export async function exerciseNativeSageValidity({
  page,
  rpc,
  project,
  otherProject,
  projectRoot,
  waitFor,
  artifactDir,
}) {
  const count = (await rpc('snapshot')).sessions.length;
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
      'Native SAGE validity ' + type,
      45000,
    );
    if (result.error) throw Error(result.error);
    return result;
  };
  /** The engine's current-file evidence for one memory revision, check status by index. */
  const review = async (id, expectedRevision) =>
    (
      await call('memory.sage.get', { id, reviewValidity: true, expectedRevision })
    ).validityReview.checks.map((check) => check.status);
  await writeFile(
    join(projectRoot, 'sage-validity-fixture.ts'),
    'export const boundary = "boundary-v1";\r\n',
  );
  await writeFile(join(projectRoot, 'sage-validity-large.txt'), 'x'.repeat(65537));
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await page
    .getByRole('navigation', { name: `${project.name} workspace` })
    .getByRole('button', { name: 'Memory', exact: true })
    .click();
  const sage = page.locator('[data-workbench-view="memory"]');
  await sage.getByRole('heading', { level: 1, name: 'SAGE', exact: true }).waitFor();
  const library = sage.getByRole('region', { name: 'Memory library', exact: true });
  const list = library.getByRole('region', { name: 'Memories', exact: true });
  const card = (text) => list.locator('.ws-memory-card').filter({ hasText: text });
  const detail = sage.getByRole('region', { name: 'Memory detail', exact: true });
  const validity = detail.getByRole('region', { name: 'Valid when', exact: true });
  const paths = detail.getByLabel('Relative project file path', { exact: true });
  const literals = detail.getByLabel('Exact text expected in the file', { exact: true });
  const addSourceCheck = detail.getByRole('button', { name: 'Add source check', exact: true });
  const addCheck = async (index, path, text) => {
    await addSourceCheck.click();
    await paths.nth(index - 1).fill(path);
    await literals.nth(index - 1).fill(text);
  };
  const saved = (notice) => sage.getByRole('status').filter({ hasText: notice }).waitFor();

  const title = 'Native conditional SAGE boundary.';
  await sage.getByRole('button', { name: 'New memory', exact: true }).click();
  await detail.getByLabel('Memory content', { exact: true }).fill(title);
  await detail
    .getByLabel('Valid when', { exact: true })
    .fill('Applies while the boundary-v1 source is present.');
  await addCheck(1, '../outside.ts', 'boundary-v1');
  await detail.getByRole('button', { name: 'Create memory', exact: true }).click();
  // The engine refuses a path that leaves the project; the editor keeps the draft and says why.
  await detail.getByRole('alert').filter({ hasText: 'relative project path' }).waitFor();
  assert.equal(
    (await call('memory.sage.listPage', { query: title, limit: 20 })).memories.some(
      (memory) => memory.text === title,
    ),
    false,
  );
  await paths.nth(0).fill('sage-validity-fixture.ts');
  await addCheck(2, 'sage-validity-missing.txt', 'unreadable');
  await addCheck(3, 'sage-validity-large.txt', 'x');
  await addCheck(4, 'sage-validity-fixture.ts', 'not-in-the-file');
  assert.equal(await addSourceCheck.isDisabled(), true);
  await page.screenshot({
    path: join(artifactDir, 'native-sage-validity-authoring.png'),
    fullPage: true,
  });
  await detail.getByRole('button', { name: 'Create memory', exact: true }).click();
  await saved('Memory captured.');
  const records = await call('memory.sage.listPage', { query: title, limit: 20 });
  const id = records.memories.find((memory) => memory.text === title).id;
  const original = (await call('memory.sage.get', { id })).memory;
  assert.equal(original.validity.checks.length, 4);
  assert.equal(original.validity.checks[0].text, 'boundary-v1');
  assert.equal(
    (await call('memory.sage.get', { id })).validityReview,
    undefined,
    'Normal reads do not inspect source files',
  );
  // The record shows its conditions and that no source observation exists for this revision.
  await validity.getByText('No source observation for this memory revision.').waitFor();
  assert.equal(await validity.getByText('Not checked', { exact: true }).count(), 4);
  assert.deepEqual(await review(id, original.revision), [
    'satisfied',
    'unknown',
    'unknown',
    'not_satisfied',
  ]);
  assert.equal((await call('memory.sage.get', { id })).memory.revision, original.revision);
  assert.equal((await call('memory.sage.get', { id })).memory.status, original.status);
  await validity.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifactDir, 'native-sage-source-evidence.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 640 });
  await validity.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-sage-source-evidence-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await writeFile(
    join(projectRoot, 'sage-validity-fixture.ts'),
    'export const boundary = "boundary-v2";\n',
  );
  assert.equal((await review(id, original.revision))[0], 'not_satisfied');
  await rpc('project.open', { projectId: otherProject.id });
  await waitFor(
    async () => (await rpc('project.status', { projectId: otherProject.id })).status === 'running',
    'Second project SAGE runtime',
    100000,
  );
  await assert.rejects(
    call(
      'memory.sage.get',
      { id, reviewValidity: true, expectedRevision: original.revision },
      otherProject,
    ),
    /not found/,
  );
  const newerTitle = title + ' Updated externally.';
  const newer = (
    await call('memory.sage.update', { id, expectedRevision: original.revision, text: newerTitle })
  ).memory;
  await assert.rejects(review(id, original.revision), /memory changed/);

  // An abandoned edit changes nothing in the store.
  await sage.getByRole('button', { name: 'Refresh memories', exact: true }).click();
  await card(newerTitle).click();
  await detail.getByRole('button', { name: 'Edit', exact: true }).click();
  await literals.nth(0).fill('unsaved change');
  await detail.getByRole('button', { name: 'Remove check', exact: true }).nth(3).click();
  await detail.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Discard Unsaved Changes?', exact: true })
    .getByRole('button', { name: 'Discard', exact: true })
    .click();
  assert.equal((await call('memory.sage.get', { id })).memory.revision, newer.revision);
  assert.equal((await call('memory.sage.get', { id })).memory.validity.checks.length, 4);

  // Removing every check and the statement removes the applicability condition.
  await detail.getByRole('button', { name: 'Edit', exact: true }).click();
  for (let index = 4; index >= 1; index--)
    await detail.getByRole('button', { name: 'Remove check', exact: true }).first().click();
  await detail.getByLabel('Valid when', { exact: true }).fill('');
  await detail.getByRole('button', { name: 'Save changes', exact: true }).click();
  await saved('Memory updated.');
  assert.equal((await call('memory.sage.get', { id })).memory.validity, undefined);
  await validity.waitFor({ state: 'detached' });

  await detail.getByRole('button', { name: 'Edit', exact: true }).click();
  await detail
    .getByLabel('Valid when', { exact: true })
    .fill('Applies while boundary-v2 is present.');
  await addCheck(1, 'sage-validity-fixture.ts', 'boundary-v2');
  await detail.getByRole('button', { name: 'Save changes', exact: true }).click();
  await saved('Memory updated.');
  const current = (await call('memory.sage.get', { id })).memory;
  assert.deepEqual(await review(id, current.revision), ['satisfied']);

  // After a reload the record shows its conditions, never an old observation as current.
  await page.reload();
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await page
    .getByRole('navigation', { name: `${project.name} workspace` })
    .getByRole('button', { name: 'Memory', exact: true })
    .click();
  await card(newerTitle).click();
  await validity.getByText('Applies while boundary-v2 is present.', { exact: true }).waitFor();
  await validity.getByText('No source observation for this memory revision.').waitFor();
  assert.deepEqual(await review(id, current.revision), ['satisfied']);
  await sage
    .getByRole('tablist', { name: 'SAGE memory lenses', exact: true })
    .getByRole('tab', { name: /^Vector memory/ })
    .click();
  await sage
    .getByText('Disabled — the webui-server host does not have a vector memory store wired.', {
      exact: true,
    })
    .waitFor();
  assert.equal((await rpc('snapshot')).sessions.length, count);
  console.log(
    'PASS: native SAGE applicability create/edit/remove/cancel, engine current-file evidence, missing/unknown states, stale revision refusal, project isolation and reload without vector memory or conversations',
  );
}
