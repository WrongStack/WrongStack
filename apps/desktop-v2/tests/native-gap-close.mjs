import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The 2026-11-05 round that closed the desktop's last WebUI and TUI gaps, through the real
 * controls and the project engine: the TUI's commands the engine runs (`command.list` /
 * `command.run`) from the composer, the analytics page, the side-by-side diff editor, the fonts
 * and text size, the status bar chips, provider quota on the main rail and the sidebar's session
 * actions. None of it may reach the model.
 */
export async function exerciseNativeGapClose({
  page,
  rpc,
  project,
  waitFor,
  artifactDir,
  sessionIds,
  providerFixture,
}) {
  const shot = (name) => page.screenshot({ path: join(artifactDir, name), fullPage: true });
  const modelCalls = () => providerFixture.calls.filter((call) => call.stream === true).length;

  const session = await rpc('session.open', {
    projectId: project.id,
    kind: 'agent',
    title: 'Native engine commands',
  });
  sessionIds.push(session.id);
  await page.locator('.tree-session').filter({ hasText: 'Native engine commands' }).click();
  const composer = page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  await composer.waitFor({ timeout: 100000 });
  const before = modelCalls();
  const notice = (text) => page.locator('.composer-notice').filter({ hasText: text });

  // The engine's catalog arrives after the connection; until then the composer refuses the name.
  // A trailing space keeps the completion list closed, so Enter sends rather than completes.
  await waitFor(async () => {
    await composer.fill('/sandbox ');
    await composer.press('Enter');
    return (await notice('Exec sandbox').count()) > 0;
  }, 'The engine runs /sandbox from the composer');
  assert.equal(await composer.inputValue(), '', 'A finished command clears the draft');

  await composer.fill('/delegate list');
  await composer.press('Enter');
  await notice('Available Agent Roles').waitFor();

  // A command that deletes data says so first and keeps the draft.
  await composer.fill('/prune 3650');
  await composer.press('Enter');
  await page.locator('.composer-error').filter({ hasText: 'Send it again' }).waitFor();
  assert.equal(await composer.inputValue(), '/prune 3650');
  await composer.fill('');

  await composer.fill('/tuneup ');
  await composer.press('Enter');
  await notice('Tune-up').waitFor({ timeout: 60000 });
  await shot('native-engine-commands.png');
  assert.equal(modelCalls(), before, 'Engine commands never become model prompts');
  console.log('PASS: the engine runs the TUI commands from the composer and asks before deleting');

  // The analytics page, opened by its command.
  await composer.fill('/analytics ');
  await composer.press('Enter');
  await page.getByRole('heading', { name: 'Analytics Dashboard', exact: true }).waitFor();
  await shot('native-analytics.png');
  console.log('PASS: /analytics opens the shared analytics dashboard');

  // The side-by-side diff editor writes the working tree.
  const tool = (name) =>
    page
      .getByRole('navigation', { name: `${project.name} workspace` })
      .getByRole('button', { name, exact: true });
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await tool('Changes').click();
  await page.getByRole('button', { name: /^review-fixture\.ts / }).click();
  await page.locator('.diff-line-add').filter({ hasText: 'reviewed = 2' }).waitFor();
  await page.getByRole('button', { name: 'Edit side by side', exact: true }).click();
  const modified = page.locator('.monaco-diff-editor .editor.modified .view-lines');
  await modified.waitFor({ timeout: 60000 });
  await modified.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('export const editedSideBySide = true;\n');
  await page.getByRole('button', { name: 'Apply to file', exact: true }).click();
  await waitFor(
    async () =>
      (await readFile(join(project.root, 'review-fixture.ts'), 'utf8')).includes(
        'editedSideBySide',
      ),
    'The side-by-side edit reaches the file',
  );
  // Applying reloads the changes, so the diff now shows the edit as an added line.
  await page.locator('.diff-line-add').filter({ hasText: 'editedSideBySide' }).waitFor();
  await shot('native-diff-edit.png');
  console.log('PASS: the side-by-side diff editor applies its edit to the file');

  // Fonts, text size and the status bar, from Appearance.
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Appearance', exact: true })
    .click();
  const appearance = page.getByRole('region', { name: 'Appearance settings' });
  const saved = async () => JSON.parse((await rpc('snapshot')).appearance ?? '{}');
  const rootValue = (name) =>
    page.evaluate(
      (property) => getComputedStyle(document.documentElement).getPropertyValue(property),
      name,
    );

  await appearance.getByLabel('Interface font', { exact: true }).selectOption('system');
  await waitFor(
    async () => (await rootValue('--user-font-ui')).includes('Segoe UI'),
    'The interface font follows the choice',
  );
  await appearance.getByLabel('Interface font', { exact: true }).selectOption('default');
  await waitFor(async () => !(await rootValue('--user-font-ui')).trim(), 'Default interface font');

  const baseRatio = await page.evaluate(() => window.devicePixelRatio);
  const sizes = appearance.getByRole('group', { name: 'Text size', exact: true });
  await sizes.getByRole('button', { name: '125%', exact: true }).click();
  await waitFor(async () => (await saved()).textSize === 125, 'Text size is saved');
  await waitFor(
    async () =>
      Math.abs((await page.evaluate(() => window.devicePixelRatio)) / baseRatio - 1.25) < 0.02,
    'The window zooms to 125 %',
  );
  await shot('native-text-size-125.png');
  // A larger text size reflows the settings; nothing runs past the window's right edge.
  const overflow = await page.evaluate(() => {
    const view = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll('.appearance-settings *')]
      .map((element) => element.getBoundingClientRect().right)
      .filter((right) => right > view + 1);
    return { view, scroll: document.documentElement.scrollWidth, wide: wide.length };
  });
  console.log(`text size 125%: ${JSON.stringify(overflow)}`);
  assert.equal(overflow.wide, 0, 'Appearance controls stay inside the window at 125 %');
  await sizes.getByRole('button', { name: '100%', exact: true }).click();
  await waitFor(
    async () => Math.abs((await page.evaluate(() => window.devicePixelRatio)) - baseRatio) < 0.01,
    'The window zooms back to 100 %',
  );

  const chips = appearance.getByRole('group', { name: 'Status bar', exact: true });
  await chips.getByRole('button', { name: 'Estimated cost', exact: true }).click();
  await waitFor(
    () => page.evaluate(() => document.documentElement.dataset.statusHidden === 'cost'),
    'The cost chip is hidden',
  );
  assert.deepEqual((await saved()).statusHidden, ['cost']);
  await chips.getByRole('button', { name: 'Estimated cost', exact: true }).click();
  await waitFor(
    () => page.evaluate(() => document.documentElement.dataset.statusHidden === undefined),
    'Every chip shows again',
  );
  console.log('PASS: fonts, window text size and status bar chips apply and persist');

  // Plan quota sits on the main rail: it opens the plan quota page directly, also when
  // settings are already open on another section.
  const rail = page.getByRole('navigation', { name: 'Main navigation' });
  const quota = rail.getByRole('button', { name: 'Plan quota', exact: true });
  await rail.getByRole('button', { name: 'WrongStack settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'WrongStack settings sections' }).waitFor();
  assert.equal(await quota.evaluate((button) => button.classList.contains('active')), false);
  await quota.click();
  await page.getByRole('heading', { name: 'Plan Quota', exact: true }).waitFor({ timeout: 60000 });
  await waitFor(
    () => quota.evaluate((button) => button.classList.contains('active')),
    'The rail marks the quota shortcut',
  );
  await shot('native-rail-quota.png');
  console.log('PASS: the main rail opens provider quota directly');

  // A session keeps running after its tab closes; its sidebar row stops it, keeps the stopped
  // session listed, and removes it after asking.
  const title = 'Native sidebar terminal';
  const terminal = await rpc('session.open', { projectId: project.id, kind: 'terminal', title });
  const listed = async () => (await rpc('snapshot')).sessions.find((s) => s.id === terminal.id);
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  const row = page.locator('.tree-session-row').filter({ hasText: title });
  await row.waitFor();
  await row.hover();
  await row.getByRole('button', { name: `Stop ${title}`, exact: true }).click();
  await waitFor(
    async () => (await listed())?.status === 'stopped',
    'The sidebar stops the session',
  );
  await row.locator('.status-dot.stopped').waitFor();
  await row.hover();
  await row.getByRole('button', { name: `Remove ${title}`, exact: true }).click();
  await page
    .getByRole('dialog', { name: `Remove ${title}?`, exact: true })
    .getByRole('button', { name: 'Remove', exact: true })
    .click();
  await row.waitFor({ state: 'detached' });
  assert.equal(await listed(), undefined, 'The removed session is gone from the workspace');
  await shot('native-sidebar-sessions.png');
  console.log(
    'PASS: the sidebar stops a running session, keeps it listed and removes it after asking',
  );
  assert.equal(modelCalls(), before, 'Nothing in this round reached the model');
}
