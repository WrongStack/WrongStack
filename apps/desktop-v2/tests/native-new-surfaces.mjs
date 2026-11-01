import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openProjectView, revealProjectTools } from './native-project-navigation.mjs';

/**
 * The engine actions brought into the desktop on 2026-11-01, each through its real control and
 * the project engine: plan templates, card metrics/chain/contract map/merge, the project
 * side-effect summary, SAGE injection history and fallback chain suggestions.
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
  // Dictation follows what the platform reports; the test never opens the microphone.
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
  await templates.getByRole('status').filter({ hasText: 'Applied template' }).waitFor();
  await shot('native-plan-templates.png');
  await templates.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await page.locator('.session-todos summary').filter({ hasText: 'Plan' }).first().waitFor();
  console.log('PASS: plan templates preview and add a template to the conversation plan');

  // Kanban: a board with two cards; metrics, chain, contract map and merge on them.
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await revealProjectTools(page, project);
  await openProjectView(page, project, 'Kanban');
  await page
    .locator('.studio-heading')
    .getByRole('button', { name: 'New board', exact: true })
    .click();
  await page.getByLabel('Board name', { exact: true }).fill('Native surfaces board');
  await page.getByRole('button', { name: 'Create board', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Project boards', exact: true })
    .getByRole('button', { name: 'Native surfaces board', exact: true })
    .waitFor();
  for (const title of ['Native card one', 'Native card two']) {
    // The board reloads after a save; a click during that reload can be lost, so retry it.
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.getByRole('button', { name: 'Add task to To Do', exact: true }).click();
      if (await page.getByLabel('Task title', { exact: true }).isVisible()) break;
      await page.waitForTimeout(1000);
    }
    await page.getByLabel('Task title', { exact: true }).fill(title);
    await page.getByLabel('Task description', { exact: true }).fill(`${title} description.`);
    await page.getByRole('button', { name: 'Save task', exact: true }).click();
    await page.getByRole('button', { name: title, exact: true }).waitFor();
    // The editor closes after a save; opening the next one before that is lost.
    await page.getByLabel('Task title', { exact: true }).waitFor({ state: 'hidden' });
  }
  await page.getByRole('button', { name: 'Native card one', exact: true }).click();
  const metrics = page.locator('details.kanban-task-merge').filter({ hasText: 'Goal metrics' });
  await metrics.locator('summary').click();
  await metrics.getByLabel('New metric name', { exact: true }).fill('p95 latency');
  await metrics.getByLabel('New metric target', { exact: true }).fill('200');
  await metrics.getByRole('button', { name: 'Add metric', exact: true }).click();
  await metrics.getByRole('status').filter({ hasText: 'Added p95 latency.' }).waitFor();
  const chain = page.locator('details.kanban-task-merge').filter({ hasText: /Chain (with|·)/ });
  await chain.locator('summary').click();
  await chain.getByRole('checkbox', { name: /Native card two/ }).check();
  await chain.getByRole('button', { name: 'Save chain', exact: true }).click();
  await chain.getByRole('status').filter({ hasText: 'Chained 2 cards.' }).waitFor();
  await shot('native-card-metrics-chain.png');
  console.log('PASS: a card records a goal metric and chains another card behind it');

  await page.getByLabel('Board actions', { exact: true }).click();
  await page.getByRole('button', { name: 'Contract map…', exact: true }).click();
  const map = page.getByRole('dialog', { name: 'Contract map', exact: true });
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

  await page.getByRole('button', { name: 'Native card one', exact: true }).click();
  const merge = page.locator('details.kanban-task-merge').filter({ hasText: 'Merge with other' });
  await merge.locator('summary').click();
  await merge.getByRole('checkbox', { name: 'Native card two', exact: true }).check();
  await merge.getByLabel('Title of the merged card', { exact: true }).fill('Native merged card');
  await merge.getByRole('button', { name: 'Merge 2 cards', exact: true }).click();
  await page.getByRole('button', { name: 'Native merged card', exact: true }).waitFor();
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

  // SAGE injection history from the store's audit window.
  await openProjectView(page, project, 'Memory');
  const injections = page.locator('details.sage-injection-history');
  await injections.locator('summary').click();
  await injections.getByRole('button', { name: 'Read injection history', exact: true }).click();
  await injections
    .getByRole('status')
    .filter({ hasText: /injections into requests|No injections/ })
    .waitFor({ timeout: 60000 });
  await shot('native-sage-injections.png');
  console.log('PASS: SAGE injection history reads the audit window');

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
