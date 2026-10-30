import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function exerciseNativeProjects({
  page,
  rpc,
  waitFor,
  artifactDir,
  project,
  otherProject,
}) {
  const projectTool = (name) =>
    page
      .getByRole('navigation', { name: `${project.name} workspace` })
      .getByRole('button', { name, exact: true });
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await waitFor(
    async () => (await rpc('project.status', { projectId: project.id })).status === 'running',
    'Project Alpha runtime startup',
    100000,
  );
  await page.getByRole('heading', { name: project.name + '.', exact: true }).waitFor();
  await projectTool('Memory').click();
  await page.getByRole('heading', { name: 'SAGE Memory.', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Memory status', { exact: true }).inputValue(), 'all');
  assert.equal(
    await page.getByRole('region', { name: 'SAGE relationship graph', exact: true }).count(),
    1,
    'SAGE opens its stored relationship map',
  );
  assert.equal(
    await page.locator('.memory-library').count(),
    0,
    'Full record library is not loaded on entry',
  );
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  assert.equal(await page.getByRole('heading', { name: 'Vector Memory.', exact: true }).count(), 0);
  await page
    .locator('.memory-library')
    .getByRole('button', { name: 'A SAGE decision awaiting revalidation.', exact: true })
    .waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-sage-library.png'), fullPage: true });
  await page
    .locator('.memory-library')
    .getByRole('button', { name: 'A SAGE decision awaiting revalidation.', exact: true })
    .click();
  await page.getByRole('region', { name: 'SAGE record detail', exact: true }).waitFor();
  assert.equal(
    await page.getByLabel('Memory text', { exact: true }).count(),
    0,
    'Reading SAGE does not open an editor',
  );
  await page.getByLabel('Memory status', { exact: true }).selectOption('active');
  await waitFor(
    async () =>
      !(await page
        .locator('.memory-library')
        .getByRole('button', { name: 'A SAGE decision awaiting revalidation.', exact: true })
        .count()),
    'Active filter excludes stale SAGE records',
  );
  await page.getByLabel('Memory status', { exact: true }).selectOption('all');
  await page
    .locator('.memory-library')
    .getByRole('button', { name: 'A SAGE decision awaiting revalidation.', exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'New memory', exact: true }).first().click();
  await page
    .getByLabel('Memory text', { exact: true })
    .fill('Keep provider credentials in the encrypted vault.');
  await page.getByLabel('Memory tags', { exact: true }).fill('security, architecture');
  await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await page
    .getByRole('button', { name: 'Keep provider credentials in the encrypted vault.', exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'New memory', exact: true }).click();
  await page
    .getByLabel('Memory text', { exact: true })
    .fill('Every project owns its memory and planning boards.');
  await page.getByLabel('Memory kind', { exact: true }).selectOption('decision');
  await page.getByLabel('Memory tags', { exact: true }).fill('architecture, project-scope');
  await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await page
    .getByRole('button', {
      name: 'Every project owns its memory and planning boards.',
      exact: true,
    })
    .waitFor();
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await page.getByRole('button', { name: 'Clear memory selection', exact: true }).click();
  await waitFor(
    async () => (await page.locator('.react-flow__edge').count()) >= 1,
    'Persisted SAGE relationship edges',
  );
  await page.locator('.react-flow__edge-text').filter({ hasText: 'about file' }).first().waitFor();
  const before = await page.locator('.react-flow__viewport').getAttribute('style');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await waitFor(
    async () => (await page.locator('.react-flow__viewport').getAttribute('style')) !== before,
    'React Flow zoom',
  );
  await page.getByRole('button', { name: 'Fit map', exact: true }).click();
  await page.screenshot({ path: join(artifactDir, 'native-project-memory.png'), fullPage: true });
  const memoryCard = page.getByRole('button', {
    name: 'Every project owns its memory and planning boards.',
    exact: true,
  });
  await memoryCard.focus();
  await memoryCard.press('Enter');
  await page.getByRole('button', { name: 'Delete memory', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: 'Delete project memory' });
  assert.equal(
    await deletion.getByRole('button', { name: 'Delete memory', exact: true }).isEnabled(),
    false,
    'Project deletion requires explicit human authorization',
  );
  await deletion
    .getByRole('checkbox', { name: 'I explicitly authorize deleting this memory', exact: true })
    .check();
  await deletion.getByRole('button', { name: 'Delete memory', exact: true }).click();
  await deletion.waitFor({ state: 'hidden' });
  await page.getByLabel('Memory status', { exact: true }).selectOption('deleted');
  await page
    .getByRole('button', {
      name: 'Every project owns its memory and planning boards.',
      exact: true,
    })
    .click();
  await page.getByRole('button', { name: 'Restore memory', exact: true }).click();
  await page.getByLabel('Memory status', { exact: true }).selectOption('active');
  await page
    .getByRole('button', {
      name: 'Every project owns its memory and planning boards.',
      exact: true,
    })
    .waitFor();
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
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('heading', { name: 'No SAGE records in this view.', exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole('button', {
        name: 'Keep provider credentials in the encrypted vault.',
        exact: true,
      })
      .count(),
    0,
    'Project Beta never shows Project Alpha memory',
  );
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await projectTool('Kanban').click();
  await page.getByRole('button', { name: 'Create your first board', exact: true }).click();
  await page.getByLabel('Board name', { exact: true }).fill('Desktop roadmap');
  await page
    .getByLabel('Board description', { exact: true })
    .fill('Project-owned work that survives every conversation.');
  await page.getByRole('button', { name: 'Create board', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Project boards', exact: true })
    .getByRole('button', { name: 'Desktop roadmap', exact: true })
    .waitFor();
  await page
    .locator('.studio-toolbar')
    .getByRole('button', { name: 'Add task', exact: true })
    .click();
  await page.getByLabel('Task title', { exact: true }).fill('Build project memory map');
  await page
    .getByLabel('Task description', { exact: true })
    .fill('Show real memories and topic connections independently of conversations.');
  await page.getByLabel('Task priority', { exact: true }).selectOption('high');
  await page.getByLabel('Task labels', { exact: true }).fill('desktop, knowledge');
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  const card = page.getByRole('button', { name: 'Build project memory map', exact: true });
  await card.waitFor();
  const target = page.locator('.kanban-column').nth(1);
  await card.dragTo(target);
  const transition = page.getByRole('dialog', { name: 'Move managed task' });
  if (await transition.count()) {
    await transition
      .getByLabel('Task transition reason', { exact: true })
      .fill('Ready to implement the project map.');
    await transition.getByRole('button', { name: 'Move task', exact: true }).click();
  }
  await target.getByRole('button', { name: 'Build project memory map', exact: true }).waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-project-kanban.png'), fullPage: true });
  await target.getByRole('button', { name: 'Build project memory map', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('Build a shared project memory map');
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  await page
    .getByRole('button', { name: 'Build a shared project memory map', exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const taskList = page.getByRole('region', { name: 'Board task list', exact: true });
  await taskList
    .getByRole('button', { name: 'Build a shared project memory map', exact: true })
    .click();
  await page.getByLabel('Task due date', { exact: true }).fill('2026-12-20');
  await page.getByLabel('Task type', { exact: true }).selectOption('feature');
  await page.getByLabel('Task estimated hours', { exact: true }).fill('3.5');
  await page.getByLabel('Task cost ceiling', { exact: true }).fill('15');
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  // The inspector closes once the save is acknowledged. Reopening before that reads the old
  // inspector (the board ignores task clicks while busy) and it closes under the next step.
  await page.getByLabel('Task cost ceiling', { exact: true }).waitFor({ state: 'detached' });
  await taskList
    .getByRole('button', { name: 'Build a shared project memory map', exact: true })
    .click();
  assert.equal(await page.getByLabel('Task estimated hours', { exact: true }).inputValue(), '3.5');
  assert.equal(await page.getByLabel('Task due date', { exact: true }).inputValue(), '2026-12-20');
  const taskSections = () =>
    page.getByRole('navigation', { name: 'Task detail sections', exact: true });
  await taskSections().getByRole('button', { name: 'Evidence', exact: true }).click();
  await page
    .getByLabel('New acceptance check', { exact: true })
    .fill('SAGE records remain project scoped.');
  await page.getByRole('button', { name: 'Add check', exact: true }).click();
  await page
    .getByLabel('Check status: SAGE records remain project scoped.', { exact: true })
    .selectOption('passed');
  await waitFor(
    async () =>
      (await page
        .getByLabel('Check status: SAGE records remain project scoped.', { exact: true })
        .inputValue()) === 'passed',
    'Acceptance check persisted',
  );
  await page.getByRole('button', { name: 'Run verification', exact: true }).click();
  await waitFor(
    async () => (await page.locator('.task-verdict > strong').textContent())?.trim() === 'passed',
    'Persisted verification report',
  );
  await taskSections().getByRole('button', { name: 'History', exact: true }).click();
  await page
    .getByLabel('New task note', { exact: true })
    .fill('Review both project stores before closing.');
  await page.getByRole('button', { name: 'Add note', exact: true }).click();
  await page
    .locator('.task-note')
    .filter({ hasText: 'Review both project stores before closing.' })
    .waitFor();
  await waitFor(
    async () => (await page.locator('.task-timeline li').count()) > 0,
    'Canonical task activity',
  );
  await taskSections().getByRole('button', { name: 'Execution', exact: true }).click();
  await page.getByLabel('Task agent ID', { exact: true }).fill('desktop-reviewer');
  await page.getByLabel('Task agent role', { exact: true }).selectOption('reviewer');
  await page
    .getByRole('group', { name: /Agentic skills/ })
    .getByRole('checkbox')
    .first()
    .check();
  await page.getByRole('button', { name: 'Save assignment', exact: true }).click();
  await page.locator('.task-facts dd').getByText('assigned', { exact: true }).waitFor();
  await waitFor(
    async () =>
      await page.getByRole('button', { name: 'Save assignment', exact: true }).isEnabled(),
    'Assignment acknowledgement',
  );
  await page.screenshot({
    path: join(artifactDir, 'native-kanban-task-details.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Close task details', exact: true }).click();
  const boardList = page.getByRole('navigation', { name: 'Project boards', exact: true });
  assert.match(
    await boardList.getByRole('button', { name: 'Desktop roadmap', exact: true }).innerText(),
    /1 tasks/,
  );
  await boardList.getByRole('button', { name: 'New board', exact: true }).click();
  await page.getByLabel('Board name', { exact: true }).fill('Release checklist');
  await page.getByRole('button', { name: 'Create board', exact: true }).click();
  await boardList.getByRole('button', { name: 'Release checklist', exact: true }).waitFor();
  await page
    .locator('.studio-toolbar')
    .getByRole('button', { name: 'Add task', exact: true })
    .click();
  await page.getByLabel('Task title', { exact: true }).fill('Split a bounded change');
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  await taskList.getByRole('button', { name: 'Split a bounded change', exact: true }).click();
  await taskSections().getByRole('button', { name: 'Breakdown', exact: true }).click();
  await page
    .getByLabel('Child task titles', { exact: true })
    .fill('Implement the boundary\nVerify the boundary');
  await page.getByRole('button', { name: 'Split into child tasks', exact: true }).click();
  const breakdown = page.getByRole('region', { name: 'Task breakdown', exact: true });
  await breakdown.getByRole('button', { name: 'Implement the boundary', exact: false }).waitFor();
  await breakdown.getByRole('button', { name: 'Verify the boundary', exact: false }).waitFor();
  await page.getByRole('button', { name: 'Expand task details', exact: true }).click();
  await page.screenshot({ path: join(artifactDir, 'native-kanban-breakdown.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close task details', exact: true }).click();
  await boardList.getByRole('button', { name: 'Desktop roadmap', exact: true }).click();
  await taskList
    .getByRole('button', { name: 'Build a shared project memory map', exact: true })
    .waitFor();
  // Board actions: duplicate with and without cards, read the history, move a card between the
  // copies and delete both copies by typing their titles. The original board is not touched.
  const boardAction = async (name) => {
    const menu = page.locator('details.kanban-board-actions');
    if (!(await menu.evaluate((element) => element.open))) await menu.locator('summary').click();
    await menu.getByRole('button', { name, exact: true }).click();
  };
  const duplicate = async (title, withCards) => {
    await boardAction('Duplicate board…');
    const form = page.getByRole('dialog', { name: 'Duplicate board', exact: true });
    await form.getByLabel('New board title', { exact: true }).fill(title);
    const cards = form.getByRole('checkbox', { name: /Copy its \d+ cards/ });
    if ((await cards.isChecked()) !== withCards) await cards.click();
    await form.getByRole('button', { name: 'Duplicate board', exact: true }).click();
    await form.waitFor({ state: 'detached' });
    await page.locator('.board-current-title').filter({ hasText: title }).waitFor();
  };
  await duplicate('Roadmap copy A', true);
  await boardAction('Board history');
  const historyDialog = page.getByRole('dialog', { name: 'Board history', exact: true });
  await historyDialog
    .getByRole('list', { name: 'Board history entries', exact: true })
    .getByText('Copied from Desktop roadmap', { exact: false })
    .waitFor();
  await page.keyboard.press('Escape');
  await historyDialog.waitFor({ state: 'detached' });
  await boardList.getByRole('button', { name: 'Desktop roadmap', exact: true }).click();
  await duplicate('Roadmap copy B', false);
  assert.match(
    await boardList.getByRole('button', { name: 'Roadmap copy B', exact: true }).innerText(),
    /0 tasks/,
  );
  await boardList.getByRole('button', { name: 'Roadmap copy A', exact: true }).click();
  await taskList
    .getByRole('button', { name: 'Build a shared project memory map', exact: true })
    .click();
  const transfer = page.getByRole('region', { name: 'Copy or move to another board', exact: true });
  await transfer.getByLabel('Another board').selectOption({ label: 'Roadmap copy B' });
  await transfer.getByRole('button', { name: 'Move card', exact: true }).click();
  await waitFor(
    async () =>
      /1 tasks/.test(
        await boardList.getByRole('button', { name: 'Roadmap copy B', exact: true }).innerText(),
      ) &&
      /0 tasks/.test(
        await boardList.getByRole('button', { name: 'Roadmap copy A', exact: true }).innerText(),
      ),
    'Card moved between board copies',
  );
  for (const title of ['Roadmap copy A', 'Roadmap copy B']) {
    await boardList.getByRole('button', { name: title, exact: true }).click();
    await page.locator('.board-current-title').filter({ hasText: title }).waitFor();
    await boardAction('Delete board…');
    const confirm = page.getByRole('dialog', { name: 'Delete board', exact: true });
    const remove = confirm.getByRole('button', { name: 'Delete board permanently', exact: true });
    assert.equal(await remove.isDisabled(), true, 'Deleting needs the typed title');
    await confirm.getByLabel('Type the board title to confirm', { exact: true }).fill(title);
    await remove.click();
    await confirm.waitFor({ state: 'detached' });
    await boardList
      .getByRole('button', { name: title, exact: true })
      .waitFor({ state: 'detached' });
  }
  await boardList.getByRole('button', { name: 'Desktop roadmap', exact: true }).click();
  assert.match(
    await boardList.getByRole('button', { name: 'Desktop roadmap', exact: true }).innerText(),
    /1 tasks/,
  );
  await taskList
    .getByRole('button', { name: 'Build a shared project memory map', exact: true })
    .waitFor();
  await page.screenshot({
    path: join(artifactDir, 'native-kanban-board-list.png'),
    fullPage: true,
  });
  await projectTool('Code Atlas').click();
  console.log(
    'PASS: project Kanban board list/switch/create/edit/drag, task list, contract readback, check status, notes and activity',
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
  await waitFor(
    async () => (await page.locator('.graph-node').count()) >= 2,
    'Code Atlas package nodes',
  );
  await page.locator('.graph-node').first().click();
  await page.getByRole('button', { name: 'Explore files', exact: true }).click();
  await waitFor(
    async () => (await page.locator('.graph-node').count()) >= 1,
    'Code Atlas file drill-down',
  );
  await page.locator('.graph-node').filter({ hasText: 'index.ts' }).first().click();
  await page.getByRole('button', { name: 'Explore symbols', exact: true }).click();
  // The previous file graph remains visible while the symbol request is in flight.
  // Wait for the fixture symbol rather than clicking the stale file again.
  await page.locator('.graph-node').getByText('feature', { exact: true }).waitFor();
  await page.locator('.graph-node', { hasText: 'feature' }).click();
  await page.getByRole('button', { name: 'Read source', exact: true }).click();
  await page.locator('.atlas-source pre').filter({ hasText: 'export' }).waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-project-atlas.png'), fullPage: true });
  console.log('PASS: project Code Atlas indexing/drilldown/source');
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
  await page.locator('.project-secondary-links button').filter({ hasText: 'Automations' }).click();
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
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
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
    await projectTool(name).click();
    await page
      .getByRole('heading', { name: `${name === 'Memory' ? 'SAGE Memory' : name}.`, exact: true })
      .waitFor();
    await waitFor(
      async () =>
        name === 'Memory'
          ? (await page.locator('.react-flow__node').count()) > 0
          : name === 'Kanban'
            ? (await page.locator('.kanban-column').count()) > 0
            : (await page.locator('.graph-node').count()) >= 2,
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
    'PASS: session-free project memory map, Kanban create/edit/drag, indexed Code Atlas drill-down/source, and separate profile settings/MCP',
  );
}
