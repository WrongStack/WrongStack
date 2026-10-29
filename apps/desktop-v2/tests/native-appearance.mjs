import assert from 'node:assert/strict';
import { join } from 'node:path';
import { brandNeutrals, brandPalettes } from '../src/brand-palettes.ts';

export async function exerciseNativeAppearance({ page, rpc, waitFor, artifactDir }) {
  const settings = () =>
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Appearance', exact: true });
  await settings().click();
  assert.equal(
    await page
      .locator('.brand-mark img')
      .evaluate(
        (img) => img.naturalWidth > 0 && img.getAttribute('src') === '/wrongstack-mark.svg',
      ),
    true,
    'Canonical brand mark loaded',
  );
  const appearance = page.getByRole('region', { name: 'Appearance settings' });
  await appearance.getByRole('button', { name: 'Dark', exact: true }).click();
  await waitFor(
    () => page.evaluate(() => document.documentElement.dataset.mode === 'dark'),
    'Dark appearance',
  );
  await page.screenshot({ path: join(artifactDir, 'native-appearance-dark.png'), fullPage: true });
  await appearance.getByRole('button', { name: 'Light', exact: true }).click();
  await appearance.getByRole('button', { name: 'Blue Navy', exact: true }).click();
  await waitFor(async () => {
    const saved = JSON.parse((await rpc('snapshot')).appearance ?? '{}');
    return saved.mode === 'light' && saved.accent === 'blue-navy';
  }, 'Native appearance persistence');
  await page.screenshot({ path: join(artifactDir, 'native-appearance-light.png'), fullPage: true });
  for (const mode of ['Dark', 'Light']) {
    await appearance.getByRole('button', { name: mode, exact: true }).click();
    const colors = new Set();
    for (const palette of brandPalettes) {
      const { name, id } = palette;
      await appearance.getByRole('button', { name, exact: true }).click();
      await waitFor(
        () =>
          page.evaluate(
            ({ mode, accent }) =>
              document.documentElement.dataset.mode === mode &&
              document.documentElement.dataset.accent === accent,
            { mode: mode.toLowerCase(), accent: id },
          ),
        `${mode} ${name} palette`,
      );
      const contrast = await page.evaluate(
        ({ primary, secondary, background }) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d');
          const rgba = (color) => {
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).join(',');
          };
          const luminance = (color) => {
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
              const v = value / 255;
              return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
          };
          const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          const button = getComputedStyle(document.querySelector('.primary'));
          const body = getComputedStyle(document.body);
          return {
            accent: button.backgroundColor,
            exactPrimary: rgba(button.backgroundColor) === rgba('hsl(' + primary + ')'),
            exactSecondary:
              rgba(
                getComputedStyle(document.documentElement)
                  .getPropertyValue('--brand-secondary')
                  .trim(),
              ) === rgba('hsl(' + secondary + ')'),
            exactBackground: rgba(body.backgroundColor) === rgba('hsl(' + background + ')'),
            button: ratio(luminance(button.color), luminance(button.backgroundColor)),
            body: ratio(luminance(body.color), luminance(body.backgroundColor)),
          };
        },
        {
          primary: palette[mode.toLowerCase()].primary,
          secondary:
            palette[mode.toLowerCase()][id === 'coral-mint' ? 'accent-foreground' : 'brand-orange'],
          background: brandNeutrals[mode.toLowerCase()].background,
        },
      );
      assert.equal(contrast.exactPrimary, true, mode + ' ' + name + ': canonical primary');
      assert.equal(contrast.exactSecondary, true, mode + ' ' + name + ': canonical paired accent');
      assert.equal(
        contrast.exactBackground,
        true,
        mode + ' ' + name + ': canonical neutral surface',
      );
      colors.add(contrast.accent);
      assert.ok(
        contrast.button >= 4.5,
        `${mode} ${name}: primary text contrast ${contrast.button}`,
      );
      assert.ok(contrast.body >= 4.5, `${mode} ${name}: body contrast ${contrast.body}`);
    }
    assert.equal(colors.size, 13, `${mode}: thirteen distinct accent palettes`);
  }
  await appearance.getByRole('button', { name: 'Blue Navy', exact: true }).click();
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-appearance-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  // High contrast is stored and applied; System follows the OS preference.
  const contrastGroup = appearance.getByRole('group', { name: 'Contrast', exact: true });
  await contrastGroup.getByRole('button', { name: 'High', exact: true }).click();
  await waitFor(
    () => page.evaluate(() => document.documentElement.dataset.contrast === 'more'),
    'High contrast applied',
  );
  await waitFor(
    async () => JSON.parse((await rpc('snapshot')).appearance ?? '{}').contrast === 'more',
    'High contrast stored',
  );
  await contrastGroup.getByRole('button', { name: 'System', exact: true }).click();
  await page.emulateMedia({ contrast: 'more' });
  await waitFor(
    () => page.evaluate(() => document.documentElement.dataset.contrast === 'more'),
    'System high contrast',
  );
  await page.emulateMedia({ contrast: 'no-preference' });
  await waitFor(
    () => page.evaluate(() => document.documentElement.dataset.contrast === 'standard'),
    'System standard contrast',
  );
  await page.emulateMedia({ colorScheme: 'dark' });
  await appearance
    .getByRole('group', { name: 'Color mode', exact: true })
    .getByRole('button', { name: 'System', exact: true })
    .click();
  await waitFor(
    () => page.evaluate(() => document.documentElement.dataset.mode === 'dark'),
    'System dark mode',
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await waitFor(
    () => page.evaluate(() => document.documentElement.dataset.mode === 'light'),
    'System light mode',
  );
  await appearance.getByRole('button', { name: 'Light', exact: true }).click();
  await page.locator('.tree-session').filter({ hasText: 'Concurrent terminal' }).click();
  const terminalBackground = () =>
    page
      .locator('.terminal-surface')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
  const canonicalBackground = (mode) =>
    page.evaluate((triple) => {
      const el = document.createElement('div');
      el.style.backgroundColor = 'hsl(' + triple + ')';
      document.body.append(el);
      const color = getComputedStyle(el).backgroundColor;
      el.remove();
      return color;
    }, brandNeutrals[mode].background);
  assert.equal(await terminalBackground(), await canonicalBackground('light'));
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  const darkBackground = await canonicalBackground('dark');
  await waitFor(
    async () => (await terminalBackground()) === darkBackground,
    'Live terminal theme update',
  );
  assert.ok(
    await page.locator('.xterm-screen').count(),
    'Terminal remains mounted across theme changes',
  );
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  await page.locator('.session-tab-label').filter({ hasText: 'WrongStack engine proof' }).click();
  assert.equal(
    await page.locator('.page-heading').count(),
    0,
    'Focused work has one context header',
  );
  assert.equal(
    await page.locator('.workspace-tabs > button').count(),
    5,
    'Primary navigation stays compact',
  );
  console.log(
    'PASS: canonical logo, all 13 paired palettes in light/dark, contrast, native persistence, compact appearance and live terminal theme',
  );
}
