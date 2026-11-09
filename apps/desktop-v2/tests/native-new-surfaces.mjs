import assert from 'node:assert/strict';
import { join } from 'node:path';
import { exerciseNativeLiveDictation } from './native-dictation-live.mjs';
import { openProjectView, revealProjectTools } from './native-project-navigation.mjs';

/**
 * The engine actions brought into the desktop on 2026-11-01, each through its real control and
 * the project engine: plan templates, card metrics/chain/contract map/merge, the project
 * side-effect summary and fallback chain suggestions. (SAGE injection history left with the
 * desktop's own SAGE pages; the shared SAGE surface has no such view.)
 */
export async function exerciseNativeNewSurfaces({ page, rpc, project, artifactDir, sessionIds }) {
  const shot = (name) => page.screenshot({ path: join(artifactDir, name), fullPage: true });

  // Plan templates: preview one and add it to the conversation's plan.
  const session = await rpc('session.open', {
    projectId: project.id,
    kind: 'agent',
    title: 'Native plan templates',
  });
  sessionIds.push(session.id);
  await page.locator('.tree-session').filter({ hasText: 'Native plan templates' }).click();
  await page.getByRole('textbox', { name: 'Message WrongStack', exact: true }).waitFor({
    timeout: 100000,
  });
  // Automated runs check availability; the opt-in manual scenario also accepts real speech.
  const speech = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('speech_status'));
  console.log(`Dictation status: ${JSON.stringify(speech)}`);
  const dictate = page.getByRole('button', { name: 'Dictate', exact: true });
  const unsupported = !speech.available && /Windows only|desktop app/.test(speech.reason ?? '');
  if (!unsupported) await dictate.waitFor();
  if (speech.available)
    await page.waitForFunction(
      () => document.querySelector('button[aria-label="Dictate"]')?.disabled === false,
      undefined,
      { timeout: 30000 },
    );
  else if (unsupported) assert.equal(await dictate.count(), 0);
  else {
    assert.equal(await dictate.isDisabled(), true);
    assert.equal(await dictate.getAttribute('title'), speech.reason, 'Disabled dictation says why');
  }
  console.log(
    `PASS: the dictation button matches the platform (${speech.available ? `available, ${speech.language}` : speech.reason})`,
  );
  if (process.env.WRONGSTACK_DESKTOP_MICROPHONE_ACCEPTANCE === '1') {
    await exerciseNativeLiveDictation({ page, artifactDir, speech });
  }
  await page
    .getByRole('navigation', { name: 'Agent workspace views' })
    .getByRole('button', { name: 'Tools', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Session tools', exact: true })
    .getByRole('button')
    .filter({ hasText: 'Plan templates' })
    .click();
  const templates = page.getByRole('region', { name: 'Plan templates', exact: true });
  await templates.getByRole('list', { name: /^Steps of / }).waitFor();
  await templates.getByRole('button', { name: 'Add to plan', exact: true }).click();
  await templates.getByRole('status').filter({ hasText: 'to the plan.' }).waitFor();
  await shot('native-plan-templates.png');
  await templates.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await page.locator('.session-todos summary').filter({ hasText: 'Plan' }).first().waitFor();
  console.log('PASS: plan templates preview and add a template to the conversation plan');

  // Kanban: a board with two cards; metrics, chain, contract map and merge on them.
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await revealProjectTools(page, project);
  await openProjectView(page, project, 'Kanban');
  // The board is the WebUI's shared Kanban; the desktop's card tools (metrics, chain, merge,
  // transfer) sit in the task inspector's Breakdown tab, its board tools above the columns.
  const kanban = page.locator('.kanban-surface');
  const boardTitle = 'Native surfaces board';
  await kanban.getByLabel('New board title', { exact: true }).fill(boardTitle);
  await kanban.getByLabel('New board title', { exact: true }).press('Enter');
  await kanban.getByRole('heading', { level: 1, name: boardTitle, exact: true }).waitFor();
  const cardButton = (title) =>
    kanban.getByRole('button', { name: `Select task: ${title}`, exact: true });
  for (const title of ['Native card one', 'Native card two']) {
    await kanban.getByLabel('New task title', { exact: true }).fill(title);
    await kanban.getByLabel('New task title', { exact: true }).press('Enter');
    await cardButton(title).waitFor();
  }
  const inspector = kanban.getByRole('complementary', { name: 'Task inspector', exact: true });
  const openCardTools = async (title) => {
    await cardButton(title).press('Enter');
    await inspector.getByRole('tab', { name: /^Breakdown\b/ }).click();
  };
  const closeInspector = async () => {
    await inspector.getByRole('button', { name: 'Close', exact: true }).first().click();
    await inspector.waitFor({ state: 'detached' });
  };
  await openCardTools('Native card one');
  const metrics = inspector
    .locator('details.kanban-task-merge')
    .filter({ hasText: 'Goal metrics' });
  await metrics.locator('summary').click();
  await metrics.getByLabel('New metric name', { exact: true }).fill('p95 latency');
  await metrics.getByLabel('New metric target', { exact: true }).fill('200');
  await metrics.getByRole('button', { name: 'Add metric', exact: true }).click();
  await metrics.getByRole('status').filter({ hasText: 'Added p95 latency.' }).waitFor();
  const chain = inspector
    .locator('details.kanban-task-merge')
    .filter({ hasText: /Chain (with|·)/ });
  await chain.locator('summary').click();
  await chain.getByRole('checkbox', { name: /Native card two/ }).check();
  await chain.getByRole('button', { name: 'Save chain', exact: true }).click();
  await chain.getByRole('status').filter({ hasText: 'Chained 2 cards.' }).waitFor();
  await shot('native-card-metrics-chain.png');
  await closeInspector();
  console.log('PASS: a card records a goal metric and chains another card behind it');

  await kanban
    .getByRole('toolbar', { name: 'Board tools', exact: true })
    .getByRole('button', { name: 'Edit contracts…', exact: true })
    .click();
  const map = page.getByRole('dialog', { name: 'Edit contracts', exact: true });
  await map.getByRole('combobox', { name: /^Board enforcement/ }).waitFor();
  await map.getByLabel('Contract', { exact: true }).fill('Keep the test suite green');
  await map.getByRole('button', { name: 'Add contract', exact: true }).click();
  await map.locator('.kanban-contract-task').getByText('Keep the test suite green').waitFor();
  await map.getByLabel('Card to check', { exact: true }).selectOption({ label: 'Native card one' });
  await map.getByRole('button', { name: 'Check contracts', exact: true }).click();
  await map.getByRole('status').filter({ hasText: 'Native card one:' }).waitFor();
  await shot('native-contract-map.png');
  await page.keyboard.press('Escape');
  await map.waitFor({ state: 'detached' });
  console.log('PASS: the contract map adds a card contract and checks the card against it');

  await openCardTools('Native card one');
  const merge = inspector
    .locator('details.kanban-task-merge')
    .filter({ hasText: 'Merge with other' });
  await merge.locator('summary').click();
  await merge.getByRole('checkbox', { name: 'Native card two', exact: true }).check();
  await merge.getByLabel('Title of the merged card', { exact: true }).fill('Native merged card');
  await merge.getByRole('button', { name: 'Merge 2 cards', exact: true }).click();
  // The merge runs through the desktop's own engine command and reports its result, unless the
  // merged source card already left the board and took the inspector with it. Reading the board
  // again from the sidebar then shows the engine's result whether or not a broadcast arrived.
  await page.waitForFunction(() => {
    const open = document.querySelector('aside[aria-label="Task inspector"]');
    return (
      !open ||
      [...open.querySelectorAll('[role="status"]')].some((node) =>
        node.textContent?.includes('Merged 2 cards'),
      )
    );
  });
  await kanban.getByRole('button').filter({ hasText: boardTitle }).click();
  await cardButton('Native merged card').waitFor();
  console.log('PASS: two cards merge into one new card on the board');

  // Project-wide side effects from the session journals.
  await openProjectView(page, project, 'Session history');
  const history = page.getByRole('region', { name: 'Project session history' });
  const effects = history.locator('details.project-usage-summary').filter({
    hasText: 'Recorded side effects',
  });
  await effects.locator('summary').click();
  await effects.getByRole('button', { name: 'Summarize side effects', exact: true }).click();
  await effects.getByRole('status').filter({ hasText: 'conversations' }).waitFor({
    timeout: 120000,
  });
  console.log('PASS: the project side-effect summary reads the recorded conversations');

  // Fallback chain suggestions from the profile's reachable models.
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'WrongStack settings', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: 'WrongStack settings sections' })
    .getByRole('button', { name: 'Fallbacks & agent defaults', exact: true })
    .click();
  const suggestions = page.getByRole('region', { name: 'Suggested fallback chains' });
  await suggestions.getByRole('button', { name: 'Suggest chains', exact: true }).click();
  await page.waitForFunction(
    () => {
      const region = document.querySelector('.fallback-suggestions');
      return !!region?.querySelector('article, [role="status"]');
    },
    undefined,
    { timeout: 60000 },
  );
  const answered =
    (await suggestions.locator('article').count()) > 0 ||
    (await suggestions.getByRole('status').count()) > 0;
  assert.ok(answered, 'The engine answered fallback.suggest');
  await shot('native-fallback-suggestions.png');
  console.log('PASS: fallback settings show chains the engine suggests from reachable models');
}
