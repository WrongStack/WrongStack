import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  await page.getByRole('heading', { name: 'SAGE Memory', exact: true }).waitFor();
  const title = 'Native conditional SAGE boundary.';
  await page.getByRole('button', { name: 'New memory', exact: true }).first().click();
  await page.getByLabel('Memory text', { exact: true }).fill(title);
  await page.getByText('Retention, evidence & audience', { exact: true }).click();
  await page
    .getByLabel('Memory applicability', { exact: true })
    .fill('Applies while the boundary-v1 source is present.');
  const addCheck = async (index, path, text) => {
    await page.getByRole('button', { name: 'Add source check', exact: true }).click();
    await page.getByLabel(`Validity check ${index} project path`, { exact: true }).fill(path);
    await page.getByLabel(`Validity check ${index} required text`, { exact: true }).fill(text);
  };
  await addCheck(1, '../outside.ts', 'boundary-v1');
  await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'project-relative path' }).waitFor();
  assert.equal(
    (await call('memory.sage.listPage', { query: title, limit: 20 })).memories.some(
      (memory) => memory.text === title,
    ),
    false,
  );
  await page
    .getByLabel('Validity check 1 project path', { exact: true })
    .fill('sage-validity-fixture.ts');
  await addCheck(2, 'sage-validity-missing.txt', 'unreadable');
  await addCheck(3, 'sage-validity-large.txt', 'x');
  await addCheck(4, 'sage-validity-fixture.ts', 'not-in-the-file');
  assert.equal(
    await page.getByRole('button', { name: 'Add source check', exact: true }).isDisabled(),
    true,
  );
  await page.screenshot({
    path: join(artifactDir, 'native-sage-validity-authoring.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Saved to project memory.' }).waitFor();
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
  const evidence = page.getByRole('region', { name: 'SAGE source evidence review', exact: true });
  await evidence.getByRole('button', { name: 'Check current sources', exact: true }).click();
  await evidence
    .getByRole('article', { name: 'Source check 1', exact: true })
    .getByText('Literal found', { exact: true })
    .waitFor();
  await evidence
    .getByRole('article', { name: 'Source check 4', exact: true })
    .getByText('Literal missing', { exact: true })
    .waitFor();
  assert.equal(await evidence.getByText('Unknown', { exact: true }).count(), 2);
  assert.equal((await call('memory.sage.get', { id })).memory.revision, original.revision);
  assert.equal((await call('memory.sage.get', { id })).memory.status, original.status);
  await evidence.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifactDir, 'native-sage-source-evidence.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 640 });
  await evidence
    .getByRole('article', { name: 'Source check 1', exact: true })
    .scrollIntoViewIfNeeded();
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
  await evidence.getByRole('button', { name: 'Check current sources', exact: true }).click();
  await evidence
    .getByRole('article', { name: 'Source check 1', exact: true })
    .getByText('Literal missing', { exact: true })
    .waitFor();
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
  await evidence.getByRole('button', { name: 'Check current sources', exact: true }).click();
  await evidence.getByRole('alert').filter({ hasText: 'memory changed' }).waitFor();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh memories', exact: true }).click();
  await page
    .locator('.memory-library')
    .getByRole('button', { name: newerTitle, exact: true })
    .click();
  await page.getByRole('button', { name: 'Edit memory', exact: true }).click();
  await page.getByText('Retention, evidence & audience', { exact: true }).click();
  await page.getByLabel('Validity check 1 required text', { exact: true }).fill('unsaved change');
  await page.getByRole('button', { name: 'Remove source check 4', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  assert.equal((await call('memory.sage.get', { id })).memory.revision, newer.revision);
  assert.equal((await call('memory.sage.get', { id })).memory.validity.checks.length, 4);
  await page.getByRole('button', { name: 'Edit memory', exact: true }).click();
  await page.getByText('Retention, evidence & audience', { exact: true }).click();
  for (let index = 4; index >= 1; index--)
    await page.getByRole('button', { name: `Remove source check ${index}`, exact: true }).click();
  await page.getByLabel('Memory applicability', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Saved to project memory.' }).waitFor();
  assert.equal((await call('memory.sage.get', { id })).memory.validity, undefined);
  assert.equal(await evidence.count(), 0);
  await page.getByRole('button', { name: 'Edit memory', exact: true }).click();
  await page.getByText('Retention, evidence & audience', { exact: true }).click();
  await page
    .getByLabel('Memory applicability', { exact: true })
    .fill('Applies while boundary-v2 is present.');
  await addCheck(1, 'sage-validity-fixture.ts', 'boundary-v2');
  await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Saved to project memory.' }).waitFor();
  await evidence.getByRole('button', { name: 'Check current sources', exact: true }).click();
  await evidence.getByText('Literal found', { exact: true }).waitFor();
  await page.reload();
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await page
    .getByRole('navigation', { name: `${project.name} workspace` })
    .getByRole('button', { name: 'Memory', exact: true })
    .click();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page
    .locator('.memory-library')
    .getByRole('button', { name: newerTitle, exact: true })
    .click();
  assert.equal(
    await evidence.getByRole('article').count(),
    0,
    'An old source snapshot is not replayed as current evidence',
  );
  await evidence.getByRole('button', { name: 'Check current sources', exact: true }).click();
  await evidence.getByText('Literal found', { exact: true }).waitFor();
  await page
    .getByRole('navigation', { name: 'Project memory systems' })
    .getByRole('button')
    .filter({ hasText: 'Vector Memory' })
    .click();
  await page
    .getByRole('heading', { name: 'Vector Memory is not enabled for this project.', exact: true })
    .waitFor();
  assert.equal((await rpc('snapshot')).sessions.length, count);
  console.log(
    'PASS: native SAGE applicability create/edit/remove/cancel, canonical current-file evidence, missing/unknown states, stale revision refusal, project isolation and reload without vector memory or conversations',
  );
}
