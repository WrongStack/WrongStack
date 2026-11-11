import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.resolve(app, '../../.temp_files/desktop-render-recovery');
const server = await createServer({
  root: app,
  configFile: path.join(app, 'vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
    watch: { ignored: ['**/src-tauri/**', '**/dist*/**'] },
  },
});
const receipt = { result: 'RUNNING', cases: [] };
let browser;
try {
  await mkdir(artifacts, { recursive: true });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const url = server.resolvedUrls.local[0];
  for (const [locale, mode, width, height] of [
    ['en', 'dark', 1480, 960],
    ['tr', 'light', 800, 600],
  ]) {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.addInitScript(
      ({ locale, mode }) => {
        localStorage.setItem('wrongstack.desktop.language', locale);
        localStorage.setItem('wrongstack.desktop.appearance', JSON.stringify({ mode }));
      },
      { locale, mode },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    const settings = () =>
      page.getByRole('button', {
        name: locale === 'tr' ? 'WrongStack ayarları' : 'WrongStack settings',
        exact: true,
      });
    const reload = () =>
      page.getByRole('button', {
        name: locale === 'tr' ? 'Pencereyi yeniden yükle' : 'Reload window',
        exact: true,
      });
    for (const fault of ['module', 'render']) {
      const module = '**/src/WrongStackSettings.tsx*';
      await page.route(module, (route) =>
        fault === 'module'
          ? route.abort('failed')
          : route.fulfill({
              contentType: 'text/javascript',
              body: 'export function WrongStackSettings(){throw new Error("test-owned view fault")}',
            }),
      );
      await page.goto(url);
      await page.locator('.app-shell').waitFor();
      await settings().click();
      await page.locator('main [role="alert"]').waitFor();
      assert.equal(await page.locator('.app-shell').count(), 1);
      assert.equal(await page.locator('.sidebar').count(), 1);
      await reload().waitFor();
      assert.equal(await reload().count(), 1);
      await page.screenshot({ path: path.join(artifacts, `${locale}-${fault}.png`) });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      // Another workspace resets the failed boundary without a document reload.
      await page
        .getByRole('button', { name: locale === 'tr' ? 'Projeler' : 'Projects', exact: true })
        .click();
      await page.locator('.projects-grid').waitFor();
      assert.equal(await page.locator('main [role="alert"]').count(), 0);
      await settings().click();
      await page.locator('main [role="alert"]').waitFor();
      // Retry uses a real reload, because React.lazy retains a rejected import in this realm.
      await page.unroute(module);
      await Promise.all([page.waitForEvent('load'), reload().click()]);
      await page.locator('.app-shell').waitFor();
      assert.equal(await page.locator('main [role="alert"]').count(), 0);
      receipt.cases.push({ locale, mode, width, height, fault, result: 'PASS' });
    }
    // Errors above the workspace are handled by the boundary in the real main entry point.
    await page.route('**/src/App.tsx*', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: 'export function App(){throw new Error("test-owned shell fault")}',
      }),
    );
    await page.reload();
    await page.getByRole('alert').waitFor();
    await reload().waitFor();
    assert.equal(await reload().count(), 1);
    assert.equal(await page.locator('#root').evaluate((root) => root.childElementCount > 0), true);
    await page.screenshot({ path: path.join(artifacts, `${locale}-root.png`) });
    await page.unroute('**/src/App.tsx*');
    await Promise.all([page.waitForEvent('load'), reload().click()]);
    await page.locator('.app-shell').waitFor();
    assert.deepEqual(errors, []);
    receipt.cases.push({ locale, mode, width, height, fault: 'root', result: 'PASS' });
    await context.close();
  }
  receipt.result = 'PASS';
  console.log(
    'PASS: module/render/root recovery, working navigation and reload, EN/TR at 1480/800px',
  );
} catch (error) {
  receipt.result = 'FAIL';
  receipt.error = String(error);
  throw error;
} finally {
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify(receipt, null, 2));
  await browser?.close();
  await server.close();
}
