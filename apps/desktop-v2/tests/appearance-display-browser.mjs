import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer, transformWithOxc } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = 'virtual:appearance-display-proof',
  resolved = '\0appearance-display-proof.tsx';
const source = `
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {ConversationAppearanceSettings} from '/src/ConversationAppearanceSettings.tsx';
import {defaultAppearance, applyAppearance} from '/src/appearance.ts';
import {surfaceI18n} from '/src/surface-i18n.ts';
import '/src/styles.css'; import '/src/appearance.css'; import '/src/controls.css';
applyAppearance(defaultAppearance,false);
window.setDisplayLanguage=locale=>surfaceI18n.changeLanguage(locale);
function Fixture(){
  const [appearance,setAppearance]=useState(defaultAppearance);
  return <main style={{padding:30,maxWidth:1100,margin:'0 auto'}} className="appearance-settings">
    <ConversationAppearanceSettings appearance={appearance} changeAppearance={patch=>setAppearance(value=>({...value,...patch}))}/>
  </main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
    watch: { ignored: ['**/src-tauri/**', '**/dist-native/**', '**/dist/**'] },
  },
  plugins: [
    {
      name: 'appearance-display-proof',
      resolveId(value) {
        if (value === id) return resolved;
      },
      async load(value) {
        if (value === resolved)
          return (await transformWithOxc(source, 'fixture.tsx', { jsx: { runtime: 'automatic' } }))
            .code;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== '/__display') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<html><body><div id="root"></div><script type="module" src="/@id/virtual:appearance-display-proof"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(server.resolvedUrls.local[0] + '__display');

  const controls = page.locator('.conversation-appearance');
  await controls.waitFor();
  assert.equal(await controls.getByRole('checkbox').count(), 4);
  await controls.getByRole('checkbox').first().uncheck();
  assert.equal(await controls.getByRole('checkbox').first().isChecked(), false);
  const directory = path.resolve(root, '../../.temp_files/desktop-parity-acceptance/display-ui');
  await import('node:fs/promises').then((fs) => fs.mkdir(directory, { recursive: true }));
  for (const [width, language, name] of [
    [1480, 'en', 'desktop'],
    [800, 'tr', 'compact-tr'],
  ]) {
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate((locale) => window.setDisplayLanguage(locale), language);
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    for (const input of await controls.getByRole('checkbox').all()) {
      const box = await input.boundingBox();
      assert.deepEqual([box.width, box.height], [38, 22], 'The checkbox renders as a switch');
    }
    await page.screenshot({ path: path.join(directory, name + '.png'), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: four appearance controls; live toggle; desktop and compact Turkish layouts without overflow',
  );

  const shell = await browser.newPage({ viewport: { width: 800, height: 600 } });
  shell.setDefaultTimeout(15000);
  shell.on('pageerror', (error) => errors.push(String(error)));
  await shell.goto(server.resolvedUrls.local[0], { waitUntil: 'commit' });
  await shell.getByRole('button', { name: 'Appearance', exact: true }).click();
  const appearance = shell.getByRole('region', { name: 'Appearance settings' });
  // Effective CSS viewport of the 800×600 window under its native zoom steps.
  for (const zoom of [1, 1.25, 1.5, 1.75, 2]) {
    await shell.setViewportSize({ width: Math.round(800 / zoom), height: Math.round(600 / zoom) });
    const size = appearance.getByRole('button', { name: '200%', exact: true });
    await size.scrollIntoViewIfNeeded();
    assert.equal(
      await shell.evaluate(() => document.documentElement.scrollWidth),
      Math.round(800 / zoom),
    );
  }
  const explorer = shell.getByRole('button', { name: 'Projects and sessions', exact: true });
  const search = shell.getByRole('button', { name: /Find anything/ });
  assert.equal(await search.isVisible(), false);
  await explorer.press('Enter');
  await search.waitFor();
  assert.equal(await search.evaluate((button) => document.activeElement === button), true);
  await shell.keyboard.press('Escape');
  assert.equal(await explorer.getAttribute('aria-expanded'), 'false');
  assert.equal(await explorer.evaluate((button) => document.activeElement === button), true);
  await explorer.click();
  await shell.mouse.click(389, 30);
  assert.equal(await explorer.getAttribute('aria-expanded'), 'false');
  await shell.setViewportSize({ width: 800, height: 600 });
  assert.equal(await explorer.isVisible(), false);
  await search.waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'PASS: 100–200% minimum-window layouts and compact explorer keyboard/pointer controls',
  );
} finally {
  await browser?.close();
  await server.close();
}
