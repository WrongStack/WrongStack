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
      assert(
        box.width >= 14 && box.width <= 24 && box.height >= 14,
        'Native checkbox retains a usable size',
      );
    }
    await page.screenshot({ path: path.join(directory, name + '.png'), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: four appearance controls; live toggle; desktop and compact Turkish layouts without overflow',
  );
} finally {
  await browser?.close();
  await server.close();
}
