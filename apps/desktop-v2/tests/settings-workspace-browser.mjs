import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  configFile: join(root, 'vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
    watch: { ignored: ['**/src-tauri/**', '**/dist*/**'] },
  },
});
// Use the real Desktop entry and settings components with an isolated profile transport.
const profile = `
  import {emptyEngineState} from '/src/engine-state.ts';
  let saved = { logLevel: 'info', auditLevel: 'standard', debugStream: false, maxIterations: 30 };
  window.settingsFixture = { writes: 0, failLoad: true, reject: true, release: null };
  const state = {...emptyEngineState, connected: true, needsSetup: false};
  const send = async () => {};
  const command = async (type, payload) => {
    const fixture = window.settingsFixture;
    if (type === 'prefs.get') {
      if (fixture.failLoad) throw new Error('Test profile is temporarily unavailable');
      return {...saved};
    }
    if (type === 'prefs.update') {
      fixture.writes++;
      if (fixture.reject) {
        await new Promise(resolve => { fixture.release = resolve; });
        throw new Error('Test profile rejected the update');
      }
      saved = {...saved, ...payload};
    }
    return {};
  };
  export const useProfileEngine = () => ({state, send, command});
  export const useEngine = useProfileEngine;
  export const useProjectEngine = useProfileEngine;
`;

let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  for (const [width, height, mode] of [
    [1440, 900, 'dark'],
    [800, 550, 'light'],
    [390, 700, 'dark'],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    await page.addInitScript((mode) => {
      localStorage.setItem('wrongstack.desktop.language', 'en');
      localStorage.setItem('wrongstack.desktop.appearance', JSON.stringify({ mode }));
    }, mode);
    for (const [module, body] of [
      ['**/src/RuntimeGate.tsx*', 'export const RuntimeGate = ({children}) => children'],
      ['**/src/useEngine.ts*', profile],
    ]) {
      await page.route(module, (route) => route.fulfill({ contentType: 'text/javascript', body }));
    }
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByRole('button', { name: 'WrongStack settings', exact: true }).click();
    const settings = page.locator('.wrongstack-settings');
    const nav = settings.getByRole('navigation');
    const picker = nav.getByRole('combobox', { name: 'Settings section' });
    const search = nav.getByRole('textbox', { name: 'Search WrongStack settings' });
    const go = async (id, name) => {
      if (width > 1000) await nav.getByRole('button', { name, exact: true }).click();
      else await picker.selectOption(id);
      await expect(settings.locator('.settings-detail')).toHaveAccessibleName(name);
    };
    await settings.getByRole('alert').filter({ hasText: 'temporarily unavailable' }).waitFor();
    await page.evaluate(() => {
      window.settingsFixture.failLoad = false;
    });
    await settings.getByRole('button', { name: 'Try again' }).click();
    await go('logging', 'Logs & diagnostics');
    if (width > 1000)
      await expect(settings.getByRole('region', { name: 'Logs & diagnostics' })).toBeFocused();
    await search.fill('  missing-settings-fixture  ');
    await expect(nav.getByRole('status')).toContainText('No settings found');
    if (width <= 1000) await expect(picker).toHaveValue('logging');
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();

    const level = settings.getByLabel('Log detail', { exact: true });
    await expect(level).toHaveValue('info');
    await level.selectOption('warn');
    const debug = settings.getByRole('switch', { name: 'Stream diagnostics' });
    await debug.focus();
    await debug.press('Space');
    await expect(debug).toHaveAttribute('aria-checked', 'true');
    await expect(debug).toHaveAccessibleDescription(/provider streaming diagnostics/);
    const save = settings.getByRole('button', { name: 'Save settings' });
    await save.click();
    await expect(settings.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await expect(debug).toBeDisabled();
    assert.equal(await page.evaluate(() => window.settingsFixture.writes), 1);
    await page.evaluate(() => window.settingsFixture.release());
    await expect(settings.getByRole('alert')).toContainText('Test profile rejected the update');
    await expect(level).toHaveValue('warn');
    await expect(debug).toHaveAttribute('aria-checked', 'true');
    await page.evaluate(() => {
      window.settingsFixture.reject = false;
    });
    await save.click();
    await expect(
      settings.getByRole('status').filter({ hasText: 'saved to your active profile' }),
    ).toBeVisible();
    await go('context', 'Context & reasoning');
    await go('logging', 'Logs & diagnostics');
    await expect(level).toHaveValue('warn');
    await level.selectOption('error');
    await settings.getByRole('button', { name: /Discard/ }).click();
    await expect(level).toHaveValue('warn');
    const sections = await nav
      .locator('select option')
      .evaluateAll((items) => items.map((item) => [item.value, item.textContent]));
    for (const [id, name] of sections) {
      await go(id, name);
      const overflow = await settings.evaluate((el) => el.scrollWidth - el.clientWidth);
      assert.ok(overflow <= 2, `${width}px / ${id}: settings overflow by ${overflow}px`);
    }
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    const appearance = page.locator('.appearance-settings');
    const theme = appearance.getByRole('button', {
      name: mode === 'dark' ? 'Light' : 'Dark',
      exact: true,
    });
    await theme.press('Enter');
    await expect(theme).toHaveAttribute('aria-pressed', 'true');
    assert.ok(
      await appearance.evaluate((el) => el.scrollWidth - el.clientWidth <= 2),
      'Appearance reflows without overflow',
    );
    assert.deepEqual(errors, [], `${width}px browser errors`);
    console.log(
      `Settings: ${sections.length} sections, save recovery and keyboard controls at ${width}×${height} (${mode})`,
    );
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
