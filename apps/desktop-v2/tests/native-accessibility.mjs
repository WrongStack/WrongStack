import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openProjectView } from './native-project-navigation.mjs';

/** WCAG 2.2 A/AA rules axe checks on every screen of the pass. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * An automated accessibility pass over the native window: axe audits the settled page of each
 * main screen, in light and dark appearance. It reports every violation with its screen, rule,
 * impact and first nodes, and fails on critical ones. It does not replace a screen-reader or
 * keyboard-only walkthrough.
 */
export async function exerciseNativeAccessibility({ page, project, artifactDir }) {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const found = [];
  const audit = async (screen) => {
    // A fading overlay measures as low contrast; check the settled page.
    await page.waitForFunction(() =>
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .every((animation) => animation.playState !== 'running'),
    );
    const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    for (const violation of result.violations)
      found.push({
        screen,
        id: violation.id,
        impact: violation.impact ?? 'unknown',
        help: violation.help,
        count: violation.nodes.length,
        nodes: violation.nodes.slice(0, 4).map((node) => node.target.join(' ')),
      });
    await page.screenshot({ path: join(artifactDir, `a11y-${screen}.png`), fullPage: true });
  };
  const main = page.getByRole('navigation', { name: 'Main navigation' });
  const screens = async (mode) => {
    await main.getByRole('button', { name: 'Mission control', exact: true }).click();
    await audit(`${mode}-mission-control`);
    await page.locator('.project-item').filter({ hasText: project.name }).click();
    for (const view of ['Files', 'Changes', 'Memory', 'Kanban', 'Code Atlas']) {
      await openProjectView(page, project, view);
      await page.waitForLoadState('networkidle').catch(() => {});
      await audit(`${mode}-${view.toLowerCase().replace(/\s+/g, '-')}`);
    }
    await main.getByRole('button', { name: 'WrongStack settings', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'WrongStack settings sections' })
      .getByRole('button', { name: 'Providers & models', exact: true })
      .click();
    await page.getByRole('heading', { name: 'Default model', exact: true }).waitFor();
    await audit(`${mode}-settings-providers`);
  };
  const mode = () => page.evaluate(() => document.documentElement.dataset['mode']);
  if ((await mode()) === 'dark')
    await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  await screens('light');
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  assert.equal(await mode(), 'dark');
  await screens('dark');
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();

  const byImpact = {};
  for (const item of found) byImpact[item.impact] = (byImpact[item.impact] ?? 0) + 1;
  await writeFile(
    join(artifactDir, 'native-accessibility.json'),
    JSON.stringify({ tags: TAGS, byImpact, violations: found }, null, 2),
  );
  console.log(`Accessibility: ${found.length} violations by impact ${JSON.stringify(byImpact)}`);
  for (const item of found)
    console.log(`  ${item.impact} ${item.screen} ${item.id} ×${item.count}: ${item.help}`);
  assert.deepEqual(
    found.filter((item) => item.impact === 'critical'),
    [],
    'No critical WCAG 2.2 A/AA violation on the main native screens',
  );
  console.log('PASS: main native screens have no critical WCAG 2.2 A/AA violation');
}
