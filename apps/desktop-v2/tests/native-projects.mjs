import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openProjectView } from './native-project-navigation.mjs';

export async function exerciseNativeProjects({
  page,
  rpc,
  waitFor,
  artifactDir,
  project,
  otherProject,
}) {
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await waitFor(
    async () => (await rpc('project.status', { projectId: project.id })).status === 'running',
    'Project Alpha runtime startup',
    100000,
  );
  // The header row names the project; the overview itself shows its destinations.
  await page.locator('.project-overview').waitFor();
  await openProjectView(page, project, 'Memory');
  // Project memory is the WebUI's shared SAGE surface: a library with Active, Review, Deleted
  // and Health views beside the record detail, where records are read, edited and mapped.
  const sage = page.locator('[data-workbench-view="memory"]');
  await sage.getByRole('heading', { level: 1, name: 'SAGE', exact: true }).waitFor();
  const library = sage.getByRole('region', { name: 'Memory library', exact: true });
  const libraryView = (name) =>
    library
      .getByRole('tablist', { name: 'Memory view', exact: true })
      .getByRole('tab', { name: new RegExp(`^${name}`) });
  const memoryList = library.getByRole('region', { name: 'Memories', exact: true });
  const memoryCard = (text) => memoryList.locator('.ws-memory-card').filter({ hasText: text });
  const memoryDetail = sage.getByRole('region', { name: 'Memory detail', exact: true });
  const statusFilter = library.getByLabel('Filter by status', { exact: true });
  const staleDecision = 'A SAGE decision awaiting revalidation.';
  assert.equal(await statusFilter.inputValue(), 'all');
  await memoryCard(staleDecision).waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-sage-library.png'), fullPage: true });
  await memoryCard(staleDecision).click();
  await memoryDetail.getByText(staleDecision, { exact: true }).first().waitFor();
  assert.equal(
    await memoryDetail.getByLabel('Memory content', { exact: true }).count(),
    0,
    'Reading SAGE does not open an editor',
  );
  await statusFilter.selectOption('active');
  await waitFor(
    async () => !(await memoryCard(staleDecision).count()),
    'Active filter excludes stale SAGE records',
  );
  await statusFilter.selectOption('all');
  await memoryCard(staleDecision).waitFor();
  const createMemory = async ({ text, kind, tags, anchor }) => {
    await sage.getByRole('button', { name: 'New memory', exact: true }).click();
    await memoryDetail.getByLabel('Memory content', { exact: true }).fill(text);
    if (kind) await memoryDetail.getByLabel('Kind', { exact: true }).selectOption(kind);
    await memoryDetail.getByLabel('Tags', { exact: true }).fill(tags);
    if (anchor) {
      await memoryDetail.getByRole('button', { name: 'Add anchor', exact: true }).click();
      await memoryDetail.getByLabel('Anchor 1 value', { exact: true }).fill(anchor);
    }
    await memoryDetail.getByRole('button', { name: 'Create memory', exact: true }).click();
    await memoryCard(text).waitFor();
  };
  await createMemory({
    text: 'Keep provider credentials in the encrypted vault.',
    tags: 'security, architecture',
  });
  const planning = 'Every project owns its memory and planning boards.';
  await createMemory({
    text: planning,
    kind: 'decision',
    tags: 'architecture, project-scope',
    anchor: 'packages/alpha/src/index.ts',
  });
  // A saved record opens with its relationship map: the memory and the file it is anchored to.
  const relationships = memoryDetail.getByRole('region', {
    name: 'Memory relationship graph',
    exact: true,
  });
  // The map sits below the record and only draws what is in view.
  await relationships.scrollIntoViewIfNeeded();
  await waitFor(
    async () => (await relationships.locator('.react-flow__edge').count()) >= 1,
    'SAGE relationship edge to the anchored file',
  );
  const viewport = relationships.locator('.react-flow__viewport');
  const before = await viewport.getAttribute('style');
  await relationships.locator('.react-flow__controls-zoomin').click();
  await waitFor(async () => (await viewport.getAttribute('style')) !== before, 'React Flow zoom');
  await relationships.locator('.react-flow__controls-fitview').click();
  await page.screenshot({ path: join(artifactDir, 'native-project-memory.png'), fullPage: true });
  await memoryCard(planning).click();
  await memoryDetail.getByRole('button', { name: 'Delete', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: 'Delete this memory?', exact: true });
  assert.equal(
    await deletion
      .getByRole('checkbox', { name: /^Also block from context injection/ })
      .isChecked(),
    false,
    'Blocking a memory from context is a separate, explicit choice',
  );
  await deletion.getByRole('button', { name: 'Delete memory', exact: true }).click();
  await deletion.waitFor({ state: 'hidden' });
  await libraryView('Deleted').click();
  await memoryCard(planning).click();
  await memoryDetail.getByRole('button', { name: 'Recover', exact: true }).click();
  await sage.getByRole('status').filter({ hasText: 'Recovered' }).waitFor();
  await libraryView('Active').click();
  await memoryCard(planning).waitFor();
  await page.locator('.project-item').filter({ hasText: otherProject.name }).click();
  await waitFor(
    async () => (await rpc('project.status', { projectId: otherProject.id })).status === 'running',
    'Project Beta runtime startup',
    100000,
  );
  console.log('PASS: project memory create/map/explicit deletion/recovery');
  await page
    .getByRole('navigation', { name: `${otherProject.name} workspace` })
    .getByRole('button', { name: 'Memory', exact: true })
    .click();
  await sage.getByRole('heading', { name: 'Build your memory graph', exact: true }).waitFor();
  assert.equal(
    await memoryCard('Keep provider credentials in the encrypted vault.').count(),
    0,
    'Project Beta never shows Project Alpha memory',
  );

  // Project Kanban is the WebUI's shared board; the desktop's card tools sit in the task
  // inspector's Breakdown tab.
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await openProjectView(page, project, 'Kanban');
  const kanban = page.locator('.kanban-surface');
  const boardItem = (title) =>
    kanban.getByRole('button').filter({ has: page.getByText(title, { exact: true }) });
  const boardHeading = (title) =>
    kanban.getByRole('heading', { level: 1, name: title, exact: true });
  const cardButton = (title) =>
    kanban.getByRole('button', { name: `Select task: ${title}`, exact: true });
  const createBoard = async (title) => {
    await kanban.getByLabel('New board title', { exact: true }).fill(title);
    await kanban.getByLabel('New board title', { exact: true }).press('Enter');
    await boardHeading(title).waitFor();
  };
  const addTask = async (title) => {
    await kanban.getByLabel('New task title', { exact: true }).fill(title);
    await kanban.getByLabel('New task title', { exact: true }).press('Enter');
    await cardButton(title).waitFor();
  };
  const inspector = kanban.getByRole('complementary', { name: 'Task inspector', exact: true });
  const tab = (name) => inspector.getByRole('tab', { name: new RegExp(`^${name}\\b`) });
  const closeInspector = async () => {
    await inspector.getByRole('button', { name: 'Close', exact: true }).first().click();
    await inspector.waitFor({ state: 'detached' });
  };
  const saveContract = () =>
    inspector.getByRole('button', { name: 'Save task contract', exact: true }).click();
  await createBoard('Desktop roadmap');
  await addTask('Build project memory map');
  await cardButton('Build project memory map').press('Enter');
  await inspector
    .getByLabel('Description / working context')
    .fill('Show real memories and topic connections independently of conversations.');
  await inspector.getByLabel(/^Priority/).selectOption('high');
  await inspector
    .getByLabel('Labels (comma separated)', { exact: true })
    .fill('desktop, knowledge');
  await saveContract();
  await kanban
    .locator('.ws-task-card')
    .filter({ hasText: 'Show real memories and topic connections' })
    .waitFor();
  await closeInspector();
  const target = kanban.locator('.ws-kanban-column').nth(1);
  await cardButton('Build project memory map').dragTo(target.locator('ul'));
  await target
    .getByRole('button', { name: 'Select task: Build project memory map', exact: true })
    .waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-project-kanban.png'), fullPage: true });
  await cardButton('Build project memory map').press('Enter');
  const titleInput = inspector.getByLabel('Title', { exact: true });
  await waitFor(
    async () => (await titleInput.inputValue()) === 'Build project memory map',
    'Task editor hydrated',
  );
  await titleInput.fill('Build a shared project memory map');
  assert.equal(await titleInput.inputValue(), 'Build a shared project memory map');
  await saveContract();
  const shared = 'Build a shared project memory map';
  await cardButton(shared).waitFor();
  // The cost ceiling lives with execution; the contract save carries it with the other fields.
  await tab('Execution').click();
  await inspector.getByRole('button', { name: 'Advanced', exact: true }).click();
  await inspector.getByLabel('Cost ceiling USD', { exact: true }).fill('15');
  await tab('Definition').click();
  await inspector.getByLabel('Due date (ISO or YYYY-MM-DD)', { exact: true }).fill('2026-12-20');
  await inspector.getByLabel(/^Type/).selectOption('feature');
  await inspector.getByLabel('Estimated hours', { exact: true }).fill('3.5');
  await saveContract();
  // An inspector reads the stored card when it opens; reopen until the save is stored.
  await waitFor(async () => {
    await closeInspector();
    await cardButton(shared).press('Enter');
    return (await inspector.getByLabel('Estimated hours', { exact: true }).inputValue()) === '3.5';
  }, 'Task contract persisted');
  assert.match(
    await inspector.getByLabel('Due date (ISO or YYYY-MM-DD)', { exact: true }).inputValue(),
    /^2026-12-20/,
  );
  assert.equal(await inspector.getByLabel(/^Type/).inputValue(), 'feature');
  await tab('Execution').click();
  await inspector.getByRole('button', { name: 'Advanced', exact: true }).click();
  assert.equal(await inspector.getByLabel('Cost ceiling USD', { exact: true }).inputValue(), '15');
  await tab('Evidence').click();
  await inspector
    .getByLabel('New check', { exact: true })
    .fill('SAGE records remain project scoped.');
  await inspector.getByLabel('New check', { exact: true }).press('Enter');
  const checkStatus = inspector.getByLabel('Check status', { exact: true });
  await checkStatus.selectOption('passed');
  await waitFor(
    async () => (await checkStatus.inputValue()) === 'passed',
    'Completion check persisted',
  );
  await inspector.getByRole('button', { name: 'Run verification', exact: true }).click();
  await inspector.getByRole('button', { name: 'Re-run verification', exact: true }).waitFor();
  await inspector.getByText('Passed', { exact: true }).first().waitFor();
  await tab('History').click();
  await inspector
    .getByLabel('Activity note', { exact: true })
    .fill('Review both project stores before closing.');
  await inspector
    .getByRole('button', { name: 'Record task decision or outcome', exact: true })
    .click();
  await inspector.getByText('Review both project stores before closing.').first().waitFor();
  await tab('Execution').click();
  await inspector.getByLabel(/^Role/).selectOption('reviewer');
  await inspector.getByRole('button', { name: 'Assign required skills…', exact: true }).click();
  const skillOptions = inspector
    .getByLabel('Filter options', { exact: true })
    .locator('xpath=ancestor::div[2]')
    .getByRole('button');
  await skillOptions.first().click();
  await inspector.getByRole('button', { name: 'Assign required skills…', exact: true }).click();
  await inspector.getByLabel('Agent name (optional)', { exact: true }).fill('desktop-reviewer');
  await inspector.getByRole('button', { name: 'Assign', exact: true }).click();
  const runStatus = inspector
    .getByText('Live run', { exact: true })
    .locator('xpath=following-sibling::span[1]');
  await waitFor(
    async () => (await runStatus.textContent())?.trim() === 'assigned',
    'Assignment acknowledgement',
  );
  await page.screenshot({
    path: join(artifactDir, 'native-kanban-task-details.png'),
    fullPage: true,
  });
  await closeInspector();
  assert.match(await boardItem('Desktop roadmap').innerText(), /1 task\b/);
  await createBoard('Release checklist');
  await addTask('Split a bounded change');
  await cardButton('Split a bounded change').press('Enter');
  await tab('Breakdown').click();
  await inspector.locator('details.kanban-task-merge').first().waitFor();
  await inspector.getByRole('button', { name: 'Expand task details', exact: true }).click();
  await page.screenshot({ path: join(artifactDir, 'native-kanban-breakdown.png'), fullPage: true });
  await inspector.getByRole('button', { name: 'Collapse task details', exact: true }).click();
  await closeInspector();
  await boardItem('Desktop roadmap').click();
  await cardButton(shared).waitFor();
  // Board actions: duplicate the board and read its history, move the card from the copy to
  // another board, and delete both with the two-step delete. The original board is not touched.
  const copy = 'Desktop roadmap Copy';
  await kanban.getByRole('button', { name: 'Duplicate board', exact: true }).click();
  await boardHeading(copy).waitFor();
  await kanban.getByRole('button', { name: 'Board history', exact: true }).click();
  await kanban.getByRole('heading', { name: 'Board history', exact: true }).waitFor();
  await kanban
    .getByText(/duplicated$/)
    .first()
    .waitFor();
  await kanban.getByRole('button', { name: 'Board history', exact: true }).click();
  const moveTarget = 'Roadmap move target';
  await createBoard(moveTarget);
  await boardItem(copy).click();
  await boardHeading(copy).waitFor();
  await cardButton(shared).press('Enter');
  await tab('Breakdown').click();
  const transfer = inspector.getByRole('region', {
    name: 'Copy or move to another board',
    exact: true,
  });
  await transfer.getByLabel('Another board').selectOption({ label: moveTarget });
  await transfer.getByRole('button', { name: 'Move card', exact: true }).click();
  // The move reports its result, unless the card already left this board and closed the inspector.
  await page.waitForFunction(() => {
    const open = document.querySelector('aside[aria-label="Task inspector"]');
    return (
      !open ||
      [...open.querySelectorAll('[role="status"]')].some((node) =>
        node.textContent?.includes('Moved to'),
      )
    );
  });
  if (await inspector.count()) await closeInspector();
  // The sidebar's board list is read again from the engine.
  await kanban.getByRole('button', { name: 'Refresh', exact: true }).click();
  await waitFor(
    async () =>
      /1 task\b/.test(await boardItem(moveTarget).innerText()) &&
      /0 tasks/.test(await boardItem(copy).innerText()),
    'Card moved between boards',
  );
  for (const title of [copy, moveTarget]) {
    await boardItem(title).click();
    await boardHeading(title).waitFor();
    await kanban.getByRole('button', { name: 'Delete board', exact: true }).click();
    assert.equal(await boardItem(title).count(), 1, 'Deleting needs a second, confirming click');
    await kanban.getByRole('button', { name: 'Confirm?', exact: true }).click();
    await boardItem(title).waitFor({ state: 'detached' });
  }
  await boardItem('Desktop roadmap').click();
  assert.match(await boardItem('Desktop roadmap').innerText(), /1 task\b/);
  await cardButton(shared).waitFor();
  await page.screenshot({
    path: join(artifactDir, 'native-kanban-board-list.png'),
    fullPage: true,
  });
  await openProjectView(page, project, 'Code Atlas');
  console.log(
    'PASS: project Kanban board list/switch/create/edit/drag, contract readback, check status, verification, activity, assignment, duplicate/history/move/delete',
  );
  await page.getByRole('button', { name: 'Index project', exact: true }).click();
  await waitFor(
    async () => {
      const result = await rpc('project.http', {
        projectId: project.id,
        method: 'GET',
        resource: '/api/codemap/status',
      });
      if (result.data.status === 'error') throw new Error(result.data.error);
      return result.data.status === 'ready';
    },
    'Real project code indexing',
    120000,
  );
  // The shared Code Atlas: code tree, dependency canvas and relation inspector.
  const atlas = page.locator('.atlas-surface');
  const atlasTree = atlas.locator('.ws-code-sidebar');
  await waitFor(
    async () => (await atlas.locator('.ws-code-canvas .react-flow__node').count()) >= 2,
    'Code Atlas package nodes',
  );
  await atlasTree.getByRole('button', { name: 'Expand @fixture/alpha', exact: true }).click();
  await atlasTree.getByRole('button', { name: 'Expand index.ts', exact: true }).click();
  // A symbol picked in the tree opens its file's symbol map with the symbol selected.
  await atlasTree
    .getByRole('button')
    .filter({ hasText: /^feature/ })
    .click();
  await atlas
    .locator('.ws-code-canvas')
    .getByRole('button', { name: /^symbol\b.*\bfeature\b/ })
    .waitFor();
  await atlas
    .locator('.ws-code-inspector')
    .getByTitle('feature', { exact: true })
    .first()
    .waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-project-atlas.png'), fullPage: true });
  console.log('PASS: project Code Atlas indexing/tree drilldown/symbol inspector');
  assert.equal(
    (await rpc('snapshot')).sessions.length,
    0,
    'Memory, Kanban, and Code Atlas never create or select a desktop session',
  );
  await assert.rejects(
    rpc('project.send', {
      projectId: project.id,
      message: { type: 'user_message', payload: { content: 'Not a conversation' } },
    }),
    /agent session/,
  );
  await assert.rejects(
    rpc('project.send', {
      projectId: project.id,
      message: { type: 'prefs.update', payload: { maxIterations: 1 } },
    }),
    /WrongStack settings/,
  );
  await assert.rejects(
    rpc('project.http', {
      projectId: project.id,
      method: 'GET',
      resource: 'https://example.com/api/state',
    }),
    /relative|resource|path/i,
  );
  await page.locator('.project-home-button').click();
  await page
    .locator('.project-tools-menu.overview button')
    .filter({ hasText: 'Automations' })
    .click();
  await page.getByLabel('Automation name', { exact: true }).fill('Native project check');
  await page.getByLabel('Automation image', { exact: true }).fill('wrongstack:latest');
  await page
    .getByLabel('Automation instructions', { exact: true })
    .fill('Review this isolated fixture project and report its status.');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('heading', { name: 'Launch preview', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save automation', exact: true }).click();
  await page.getByText('The engine saved this automation.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Enable', exact: true }).click();
  await page.getByRole('button', { name: 'Disable', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Queue run', exact: true }).click();
  await page.getByText('The engine queued this run.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click();
  await waitFor(
    async () => !(await page.getByRole('button', { name: 'Cancel run', exact: true }).count()),
    'Project automation cancellation',
  );
  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await page.getByRole('button', { name: 'Enable', exact: true }).waitFor();
  await page.screenshot({
    path: join(artifactDir, 'native-project-automations.png'),
    fullPage: true,
  });
  assert.equal(
    (await rpc('snapshot')).sessions.length,
    0,
    'Automations do not create conversation sessions',
  );
  console.log('PASS: project automation preview/save/enable/queue/cancel/disable without sessions');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'WrongStack settings', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: 'WrongStack settings sections' })
    .getByRole('button', { name: 'Execution & permissions', exact: true })
    .click();
  await waitFor(
    async () => Boolean(await page.getByLabel('Iteration budget', { exact: true }).inputValue()),
    'Profile settings loaded',
  );
  await page.getByLabel('Iteration budget', { exact: true }).fill('73');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'saved to your active profile' }).waitFor();
  await page
    .getByRole('navigation', { name: 'WrongStack settings sections' })
    .getByRole('button', { name: 'Connected tools', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  await page.getByLabel('Connection name', { exact: true }).fill('desktop-fixture-tools');
  await page.getByLabel('Connection type', { exact: true }).selectOption('local');
  await page.getByLabel('MCP executable', { exact: true }).fill('fixture-mcp-not-launched.exe');
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await page.locator('.integration-card').filter({ hasText: 'desktop-fixture-tools' }).waitFor();
  await page.getByRole('button', { name: 'Remove desktop-fixture-tools', exact: true }).click();
  await page.getByRole('button', { name: 'Remove connection', exact: true }).click();
  await waitFor(
    async () =>
      !(await page
        .locator('.integration-card')
        .filter({ hasText: 'desktop-fixture-tools' })
        .count()),
    'MCP connection removal readback',
  );
  await page
    .getByRole('navigation', { name: 'WrongStack settings sections' })
    .getByRole('button', { name: 'Execution & permissions', exact: true })
    .click();
  await page.screenshot({
    path: join(artifactDir, 'native-wrongstack-settings.png'),
    fullPage: true,
  });
  // The window may already follow a dark system theme; the dark capture needs dark either way.
  const dark = page.getByRole('button', { name: 'Switch to dark mode', exact: true });
  if (await dark.count()) await dark.click();
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).waitFor();
  await page.screenshot({
    path: join(artifactDir, 'native-wrongstack-settings-dark.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'Compact settings fit the window',
  );
  await page.screenshot({
    path: join(artifactDir, 'native-wrongstack-settings-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  for (const name of ['Memory', 'Kanban', 'Code Atlas']) {
    await openProjectView(page, project, name);
    // The shared surfaces: SAGE memory cards, Kanban columns, Code Atlas map nodes.
    await waitFor(
      async () =>
        name === 'Memory'
          ? (await page.locator('[data-workbench-view="memory"] .ws-memory-card').count()) > 0
          : name === 'Kanban'
            ? (await page.locator('.kanban-surface .ws-kanban-column').count()) > 0
            : (await page.locator('.atlas-surface .ws-code-canvas .react-flow__node').count()) >= 2,
      `Loaded ${name} before visual capture`,
    );
    await page.locator('.project-page-content').evaluate((element) => {
      element.scrollTop = 0;
    });
    const slug = name.toLowerCase().replaceAll(' ', '-');
    await page.screenshot({
      path: join(artifactDir, `native-project-${slug}-dark.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 800, height: 640 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `Compact ${name} fits the window`,
    );
    await page.screenshot({
      path: join(artifactDir, `native-project-${slug}-compact.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1480, height: 960 });
  }
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  assert.equal(
    (await rpc('snapshot')).sessions.length,
    0,
    'WrongStack profile settings work without any project session',
  );
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Mission control', exact: true })
    .click();
  console.log(
    'PASS: session-free project memory map, Kanban create/edit/drag, indexed Code Atlas drill-down, and separate profile settings/MCP',
  );
}
