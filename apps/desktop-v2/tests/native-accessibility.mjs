import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { measureLabelFit } from './native-long-labels.mjs';

/** WCAG 2.2 A/AA rules axe checks on every screen of the pass. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * An automated accessibility pass over the native window: axe audits the settled page of each
 * main screen, in light and dark appearance. It reports every violation with its screen, rule,
 * impact and first nodes, and fails on critical or serious ones. It does not replace a screen-reader or
 * keyboard-only walkthrough. The same screens are then shown in German, whose labels are among
 * the longest of the shipped languages, and every label must fit (`native-long-labels.mjs`).
 */
export async function exerciseNativeAccessibility({ page, project, artifactDir, rpc }) {
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
    const result = await new AxeBuilder({ page })
      .withTags(TAGS)
      .disableRules(['target-size'])
      .analyze();
    // Target size is checked outside the Code Atlas canvas: its cards scale with the canvas zoom,
    // and every card action is also offered at full size in the code tree and the inspector
    // (the "equivalent" exception of WCAG 2.5.8).
    const sized = await new AxeBuilder({ page })
      .withRules(['target-size'])
      .exclude('.react-flow__node')
      .analyze();
    for (const violation of [...result.violations, ...sized.violations])
      found.push({
        screen,
        id: violation.id,
        impact: violation.impact ?? 'unknown',
        help: violation.help,
        count: violation.nodes.length,
        nodes: violation.nodes.slice(0, 4).map((node) => node.target.join(' ')),
        // The first node's own explanation: contrast ratios and colours, missing names.
        detail: violation.nodes[0]?.failureSummary ?? '',
        text: violation.nodes.slice(0, 4).map((node) => node.html.slice(0, 160)),
      });
    await page.screenshot({ path: join(artifactDir, `a11y-${screen}.png`), fullPage: true });
  };
  // Navigation by the desktop catalog's own labels, so the same walk works in every language.
  const catalogs = {};
  const label = (lng, key, values = {}) => {
    catalogs[lng] ??= JSON.parse(
      readFileSync(new URL(`../src/locales/${lng}/desktop.json`, import.meta.url), 'utf8'),
    );
    const text = key.split('.').reduce((node, part) => node?.[part], catalogs[lng]);
    assert.equal(typeof text, 'string', `${lng} catalog has ${key}`);
    return text.replace(/\{\{(\w+)\}\}/g, (_, name) => values[name]);
  };
  const VIEWS = ['files', 'changes', 'memory', 'kanban', 'atlas'];
  const PINNED = new Set(['files', 'changes', 'memory', 'kanban']);
  const screens = async (mode, check = audit, lng = 'en') => {
    const L = (key, values) => label(lng, key, values);
    const main = page.getByRole('navigation', { name: L('rail.navigation'), exact: true });
    await main.getByRole('button', { name: L('rail.missionControl'), exact: true }).click();
    await check(`${mode}-mission-control`);
    await page.locator('.project-item').filter({ hasText: project.name }).click();
    const views = page.getByRole('navigation', {
      name: L('explorer.workspace', { name: project.name }),
      exact: true,
    });
    for (const view of VIEWS) {
      if (!PINNED.has(view)) {
        const launcher = views.getByRole('button', { name: L('rail.projectTools'), exact: true });
        if ((await launcher.getAttribute('aria-expanded')) !== 'true') await launcher.click();
      }
      await views.getByRole('button', { name: L(`pages.${view}`), exact: true }).click();
      await page.waitForLoadState('networkidle').catch(() => {});
      await check(`${mode}-${view === 'atlas' ? 'code-atlas' : view}`);
    }
    await main.getByRole('button', { name: L('rail.settings'), exact: true }).click();
    await page
      .getByRole('navigation', { name: L('settings.sections'), exact: true })
      .getByRole('button', { name: L('settings.section.providers'), exact: true })
      .click();
    await page
      .getByRole('heading', { name: L('providerSettings.defaultModel'), exact: true })
      .waitFor();
    await check(`${mode}-settings-providers`);
  };
  const mode = () => page.evaluate(() => document.documentElement.dataset['mode']);
  if ((await mode()) === 'dark')
    await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  await screens('light');
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  assert.equal(await mode(), 'dark');
  await screens('dark');
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();

  // Long labels: the profile's display language is set to German (what the Appearance setting
  // sends) and the window reloads into it, as it does on its next start.
  const setLanguage = async (uiLocale) => {
    await rpc('profile.send', {
      message: { type: 'prefs.update', payload: { uiLocale, requestId: crypto.randomUUID() } },
    });
    await page.reload();
    await page
      .getByRole('navigation', { name: label(uiLocale, 'rail.navigation'), exact: true })
      .waitFor({ timeout: 60000 });
  };
  const unfit = [];
  try {
    await setLanguage('de');
    await screens(
      'de',
      async (screen) => {
        for (const item of await measureLabelFit(page)) unfit.push({ screen, ...item });
        await page.screenshot({ path: join(artifactDir, `labels-${screen}.png`), fullPage: true });
      },
      'de',
    );
  } finally {
    await setLanguage('en').catch(() => {});
  }

  const byImpact = {};
  for (const item of found) byImpact[item.impact] = (byImpact[item.impact] ?? 0) + 1;
  await writeFile(
    join(artifactDir, 'native-accessibility.json'),
    JSON.stringify({ tags: TAGS, byImpact, violations: found, longLabels: unfit }, null, 2),
  );
  console.log(`Accessibility: ${found.length} violations by impact ${JSON.stringify(byImpact)}`);
  for (const item of found)
    console.log(`  ${item.impact} ${item.screen} ${item.id} ×${item.count}: ${item.help}`);
  console.log(`Long labels (German): ${unfit.length} findings`);
  for (const item of unfit)
    console.log(`  ${item.kind} ${item.screen} ${item.element} ${item.width}px: ${item.text}`);
  assert.deepEqual(
    found.filter((item) => item.impact === 'critical' || item.impact === 'serious'),
    [],
    'No critical or serious WCAG 2.2 A/AA violation on the main native screens',
  );
  console.log('PASS: main native screens have no critical or serious WCAG 2.2 A/AA violation');
  assert.deepEqual(unfit, [], 'Every German label on the main native screens fits');
  console.log('PASS: every German label on the main native screens fits');
}
