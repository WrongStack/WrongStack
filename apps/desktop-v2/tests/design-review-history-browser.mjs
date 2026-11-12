import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer, transformWithOxc } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harnessSha256 = createHash('sha256')
  .update(await readFile(fileURLToPath(import.meta.url)))
  .digest('hex');
const beforeAt = process.argv.indexOf('--before-dir');
const beforeDir = beforeAt >= 0 ? path.resolve(process.argv[beforeAt + 1]) : null;
const artifacts = path.resolve(
  root,
  '../../.temp_files/desktop-review-history/browser-' + Date.now(),
);
await mkdir(artifacts, { recursive: true });
const base = '.design/inspect/history-target';
const first = `${base}/runs/12345678-1234-4123-8123-123456789abc/inspect.md`;
const second = `${base}/runs/87654321-4321-4321-8321-cba987654321/inspect.md`;
const latest = `${base}/inspect.md`;
const original =
  '# Inspect — history-target.html\nSurface: app · viewports 375px · 0 FAIL · 0 WARN\nOriginal recorded review.\n';
const newer =
  '# Inspect — history-target.html\nSurface: app · viewports 375px · 3 FAIL · 1 WARN\nNewer recorded review.\n';
const documents = new Map([
  [first, original],
  [second, newer],
  [latest, newer],
]);
// Virtual modules do not provide a reliable CSS injection boundary in this fixture.
// Load the same production styles explicitly, before rendering the card samples.
const stylesheets = [
  'styles',
  'chat',
  'workspace',
  'brand-tokens',
  'appearance',
  'workbench',
  'shell',
  'controls',
  'session-activity',
  'design-flow',
]
  .map((name) => `<link rel="stylesheet" href="/src/${name}.css">`)
  .join('');
const events = [first, second, latest].map((report, index) => ({
  type: 'tool.executed',
  at: Date.parse('2026-11-12T12:00:00Z') + index * 1000,
  payload: {
    id: 'review-' + index,
    name: 'design_reference',
    input: { action: 'inspect', file: 'history-target.html' },
    ok: true,
    output: JSON.stringify({
      action: 'inspect',
      path: report,
      fails: index === 1 ? 3 : 0,
      warns: index === 1 ? 1 : 0,
      output: index === 1 ? newer : original,
    }),
  },
}));
const fixture = `
import {createRoot} from 'react-dom/client';import {useState} from 'react';
import {SessionActivity} from '/src/SessionActivity.tsx';
import {surfaceI18n} from '/src/surface-i18n.ts';
import {applyAppearance,defaultAppearance} from '/src/appearance.ts';
import '/src/styles.css';import '/src/appearance.css';import '/src/shell.css';import '/src/workbench.css';
await surfaceI18n.changeLanguage('en');applyAppearance({...defaultAppearance,mode:'dark'},false);
window.chooseLanguage=language=>surfaceI18n.changeLanguage(language);
window.chooseMode=mode=>applyAppearance({...defaultAppearance,mode},false);
function App(){const [file,setFile]=useState(null);return <main style={{width:'calc(100vw - 264px)',marginLeft:264,padding:20,boxSizing:'border-box'}}>
  <SessionActivity events={${JSON.stringify(events)}} onOpenFile={async path=>{const text=await fetch('/__report?path='+encodeURIComponent(path)).then(r=>r.text());setFile({path,text});}}/>
  {file&&<section aria-label="Opened report"><code data-opened-path={file.path}>{file.path}</code><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{file.text}</pre></section>}
</main>}
createRoot(document.getElementById('root')).render(<App/>);
`;
const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/src-tauri/**', '**/dist*/**'] } },
  plugins: [
    {
      name: 'design-review-history-proof',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'virtual:design-review-history') return '\0design-review-history.tsx';
      },
      async load(id) {
        if (id === '\0design-review-history.tsx')
          return (await transformWithOxc(fixture, 'fixture.tsx', { jsx: { runtime: 'automatic' } }))
            .code;
        if (beforeDir) {
          const file = id.replaceAll('\\', '/').split('?')[0].split('/').at(-1);
          if (
            ['DesignReviewCard.tsx', 'design-review-result.ts'].includes(file) &&
            id.replaceAll('\\', '/').includes('/desktop-v2/src/')
          )
            return await readFile(path.join(beforeDir, file), 'utf8');
        }
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url, 'http://fixture');
          if (url.pathname === '/__report') {
            const value = documents.get(url.searchParams.get('path'));
            res
              .writeHead(value === undefined ? 404 : 200, {
                'Content-Type': 'text/plain; charset=utf-8',
              })
              .end(value ?? 'Missing fixture');
            return;
          }
          if (url.pathname !== '/__design-review-history') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(
            await server.transformIndexHtml(
              req.url,
              `<!doctype html><html lang="en"><head>${stylesheets}</head><body><div id="root"></div><script type="module" src="/@id/virtual:design-review-history"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const browser = await chromium.launch({ headless: true });
const receipt = [];
try {
  for (const sample of [
    {
      width: 1280,
      height: 840,
      language: 'en',
      mode: 'dark',
      open: 'Open report',
      latest: 'Open latest report',
    },
    {
      width: 800,
      height: 600,
      language: 'tr',
      mode: 'light',
      open: 'Raporu aç',
      latest: 'Son raporu aç',
    },
  ]) {
    const page = await browser.newPage({
      viewport: { width: sample.width, height: sample.height },
    });
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__design-review-history`);
    await page.locator('.design-review-card').nth(2).waitFor();
    await page.evaluate(async ({ language, mode }) => {
      await window.chooseLanguage(language);
      window.chooseMode(mode);
      await document.fonts.ready;
    }, sample);
    const style = await page
      .locator('.design-review-card')
      .first()
      .evaluate((card) => ({
        color: getComputedStyle(card).color,
        bodyFontSize: getComputedStyle(document.body).fontSize,
        borderStyle: getComputedStyle(card).borderTopStyle,
        stylesheets: document.styleSheets.length,
      }));
    assert.equal(style.bodyFontSize, '14px', 'The production body styles are loaded');
    assert.notEqual(style.color, 'rgb(0, 0, 0)', 'The card inherits the production text palette');
    assert.ok(style.stylesheets >= 10, 'Production card/shell stylesheets are loaded');
    const cards = page.locator('.design-review-card');
    assert.equal(
      await cards.nth(2).getByRole('button', { name: sample.latest, exact: true }).count(),
      1,
      'A legacy result must identify its shared latest report',
    );
    assert.equal(
      await cards.nth(0).getByRole('button', { name: sample.open, exact: true }).count(),
      1,
      'A retained result must open its own snapshot',
    );
    for (const [index, report, bytes, label] of [
      [0, first, original, sample.open],
      [1, second, newer, sample.open],
      [2, latest, newer, sample.latest],
    ]) {
      await cards.nth(index).getByRole('button', { name: label, exact: true }).click();
      await page.locator(`[data-opened-path="${report}"]`).waitFor();
      assert.equal(
        await page
          .getByRole('region', { name: 'Opened report', exact: true })
          .locator('pre')
          .textContent(),
        bytes,
      );
    }
    await cards.nth(2).scrollIntoViewIfNeeded();
    const bounds = await cards.nth(2).boundingBox();
    assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= sample.width + 1);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: path.join(artifacts, `reviews-${sample.language}-${sample.width}.png`),
    });
    assert.deepEqual(errors, []);
    receipt.push({ ...sample, paths: [first, second, latest], style, errors, harnessSha256 });
    console.log(
      `PASS ${sample.language} ${sample.width}x${sample.height}: separate snapshot actions and honest legacy latest action`,
    );
    await page.close();
  }
} finally {
  await writeFile(path.join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await browser.close();
  await server.close();
  console.log('ARTIFACTS ' + artifacts);
}
