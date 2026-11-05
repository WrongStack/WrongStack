import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exerciseNativeKitParameters } from './native-kit-parameters.mjs';
import { openProjectView, revealProjectTools } from './native-project-navigation.mjs';

export async function exerciseNativeProjectKit({
  page,
  rpc,
  project,
  otherProject,
  root,
  waitFor,
  artifactDir,
  sessionIds,
}) {
  const draftRpc = (method, params) =>
    page.evaluate(
      ({ method, params }) => window.__TAURI_INTERNALS__.invoke('host_request', { method, params }),
      { method, params },
    );
  const directory = join(root, '.wrongstack/project-kit/native-kit');
  await mkdir(directory, { recursive: true });
  const manifest = {
    formatVersion: 1,
    name: 'native-kit',
    description: 'A native capability with typed parameters.',
    entry: 'main.mjs',
    guide: '# Native guide\n\nReview the values before running. This guide belongs to the project.',
    effects: 'read',
    timeoutMs: 5000,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['names'],
      properties: {
        names: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', minLength: 2 } },
        sort: { type: 'boolean', default: false },
        options: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 10, default: 3 } },
        },
      },
    },
    outputSchema: { type: 'array', items: { type: 'string' } },
    tests: [
      {
        name: 'Keeps supplied names',
        input: { names: ['first', 'second'] },
        expected: ['first', 'second'],
      },
    ],
  };
  const source =
    "throw Error('Reading a Project Kit must never import its source');\nexport default ({names}) => names;\n";
  await writeFile(join(directory, 'kit.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'main.mjs'), source);
  await mkdir(join(root, '.wrongstack/project-kit/broken-kit'), { recursive: true });
  await writeFile(join(root, '.wrongstack/project-kit/broken-kit/kit.json'), '{}');
  const open = async (owner) => {
    await page.locator('.project-item').filter({ hasText: owner.name }).click();
    await revealProjectTools(page, owner);
    await openProjectView(page, owner, 'Project Kit');
    await page.getByRole('region', { name: 'Project Kit workspace' }).waitFor();
  };
  const http = async (resource) => {
    const result = await rpc('project.http', { projectId: project.id, resource, method: 'GET' });
    assert.equal(result.ok, true);
    return result.data;
  };
  const before = (await rpc('snapshot')).sessions.length;
  await open(project);
  const workspace = page.getByRole('region', { name: 'Project Kit workspace' });
  await workspace.getByRole('button', { name: /native-kit/ }).click();
  await workspace.getByRole('heading', { name: 'Native guide' }).waitFor();
  await workspace.getByText('Verification required', { exact: true }).waitFor();
  assert.equal((await rpc('snapshot')).sessions.length, before, 'Kit reads need no conversations');
  assert.equal(
    await workspace.getByRole('button', { name: 'Prepare run request', exact: true }).isDisabled(),
    true,
  );
  await workspace
    .getByRole('button', { name: 'Prepare verification request', exact: true })
    .click();
  await workspace.getByRole('heading', { name: 'Ready for review in chat' }).waitFor();
  const inspected = (await http('/api/project-kit?name=native-kit')).kit;
  assert.deepEqual(inspected.history, [], 'Read and prepare never execute or create history');
  // Recorded verification metadata is a display/gating fixture, not an executed verification.
  const runId = `${Date.now()}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
  const runDir = join(root, '.wrongstack/project-kit-runs/native-kit', runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, 'record.json'),
    JSON.stringify({
      runId,
      name: 'native-kit',
      revision: inspected.revision,
      action: 'verify',
      status: 'passed',
      agentId: 'native-fixture',
      startedAt: new Date().toISOString(),
      durationMs: 22,
      exitCode: 0,
      resultReceived: true,
      cases: [{ name: 'Keeps supplied names', passed: true }],
    }),
  );
  await workspace.getByRole('button', { name: 'Refresh kits', exact: true }).click();
  await workspace.getByRole('button', { name: /native-kit/ }).click();
  await workspace.getByText('Revision verified', { exact: true }).waitFor();
  await workspace.getByRole('button', { name: 'Add Names item', exact: true }).click();
  await workspace.getByRole('textbox', { name: 'Names 1', exact: true }).fill('native');
  await workspace.getByRole('checkbox', { name: 'Sort', exact: true }).check();
  await workspace.getByRole('checkbox', { name: 'Include options', exact: true }).check();
  await workspace.getByRole('spinbutton', { name: 'Options › Limit', exact: true }).fill('11');
  assert.equal(
    await workspace.getByRole('button', { name: 'Prepare run request', exact: true }).isDisabled(),
    true,
  );
  await workspace.getByRole('spinbutton', { name: 'Options › Limit', exact: true }).fill('4');
  await workspace.getByRole('button', { name: 'Prepare run request', exact: true }).click();
  await workspace.getByRole('heading', { name: 'Ready for review in chat' }).waitFor();
  for (const summary of [
    'Output contract',
    'Test cases (1)',
    'Run and verification history (1)',
    'Kit source files (2)',
  ])
    await workspace.getByText(summary, { exact: true }).click();
  await workspace.getByText('Keeps supplied names', { exact: true }).first().waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-project-kit.png'), fullPage: true });
  await workspace
    .getByRole('heading', { name: 'Project Kit', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifactDir, 'native-project-kit-overview.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-project-kit-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  // A disk edit must refuse a stale prepared revision.
  await writeFile(join(directory, 'main.mjs'), `${source}// changed revision\n`);
  await workspace.getByRole('button', { name: 'Prepare run request', exact: true }).click();
  await workspace.getByRole('alert').filter({ hasText: 'kit changed on disk' }).waitFor();
  await writeFile(join(directory, 'main.mjs'), source);
  await workspace.getByRole('button', { name: 'Prepare run request', exact: true }).click();
  await workspace.getByRole('heading', { name: 'Ready for review in chat' }).waitFor();
  await open(otherProject);
  await page.getByRole('heading', { name: 'A home for reusable project work' }).waitFor();
  assert.equal(await page.getByRole('button', { name: /native-kit/ }).count(), 0);
  // A previously unopened conversation has a saved text plus media/references/mode to preserve.
  const target = await rpc('session.open', {
    projectId: project.id,
    kind: 'agent',
    title: 'Kit draft target',
  });
  sessionIds.push(target.id);
  await waitFor(
    async () => (await rpc('engine.identity', { id: target.id })).sessionId,
    'Kit target engine ready',
    100000,
  );
  {
    await draftRpc('draft.save', {
      id: target.id,
      text: 'Keep the original draft.',
      expectedRevision: 0,
    });
    await draftRpc('draft.save', {
      id: target.id,
      part: 'mode',
      text: 'queue',
      expectedRevision: 0,
    });
    await draftRpc('draft.save', {
      id: target.id,
      part: 'references',
      text: '[{"path":"README.md"}]',
      expectedRevision: 0,
    });
    await open(project);
    await workspace.getByRole('button', { name: /native-kit/ }).click();
    await workspace
      .getByRole('button', { name: 'Prepare verification request', exact: true })
      .click();
    await workspace
      .getByRole('combobox', { name: 'Project Kit target conversation', exact: true })
      .selectOption(target.id);
    await workspace.getByRole('button', { name: 'Add to conversation draft', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Message WrongStack', exact: true })
      .waitFor({ timeout: 100000 });
    const draft = await waitFor(async () => {
      const data = await draftRpc('draft.get', { id: target.id });
      return data.text.includes('project_kit_run') ? data : null;
    }, 'Revision pinned saved kit draft');
    assert.ok(draft.text.startsWith('Keep the original draft.\n\n'));
    assert.ok(draft.text.includes(inspected.revision));
    assert.equal(draft.mode, 'queue');
    assert.deepEqual(draft.references, [{ path: 'README.md' }]);
    assert.equal(
      (await http('/api/project-kit?name=native-kit')).kit.history.length,
      1,
      'Draft handoff does not run kit code',
    );
    assert.equal(await readFile(join(directory, 'main.mjs'), 'utf8'), source);
    await exerciseNativeKitParameters({ page, project, open, directory, artifactDir });
    console.log(
      'PASS: native project kits read without module import/session, typed/nested parameters, contracts/tests/history/source list, recorded verification gating, revision drift refusal, project isolation, safe unopened conversation draft handoff',
    );
  }
}
