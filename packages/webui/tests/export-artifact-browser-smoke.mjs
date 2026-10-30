import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, '../../.temp_files/webui-polish-20261029/round-7/artifacts');
const virtualId = 'virtual:export-artifact-review';
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {downloadChatAsHtml,downloadChatAsMarkdown} from '/src/components/CommandPalette/export-utils.ts';
import {useChatStore,useSessionStore} from '/src/stores/index.ts';
const long = new URLSearchParams(location.search).has('long');
useSessionStore.setState({projectName:'Export fixture',session:{id:'export',startedAt:0,title:long?'Workspace_evidence_'.repeat(18):'Workspace review',provider:long?'provider_'.repeat(30):'provider',model:'model'}});
useChatStore.setState({messages:[{id:'tool',role:'tool',timestamp:0,content:'',toolName:long?'mcp__workspace__'.repeat(20):'read',toolInput:{path:'src/app.ts'},toolResult:'\u0060\u0060\u0060ts\\nconst value = 1;\\n\u0060\u0060\u0060\\n\\n## output heading\\n\u0060\u0060\u0060\u0060\\n</details>'}]});
createRoot(document.getElementById('root')).render(<><button onClick={downloadChatAsHtml}>HTML export</button><button onClick={downloadChatAsMarkdown}>Markdown export</button></>);
`;
const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'export-artifact-review',
      resolveId: (id) => (id === virtualId ? '\0export-artifact-review.tsx' : undefined),
      load: (id) =>
        id === '\0export-artifact-review.tsx'
          ? new Bun.Transpiler({
              loader: 'tsx',
              tsconfig: { compilerOptions: { jsx: 'react' } },
            }).transformSync(source)
          : undefined,
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url?.split('?')[0] !== '/__export_review') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<html><body><div id="root"></div><script type="module" src="/@id/virtual:export-artifact-review"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
let browser;
const failures = [];
const errors = [];
let passed = 0;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  for (const theme of ['light', 'dark'])
    for (const width of [1440, 390, 320])
      for (const long of [false, true]) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          isMobile: width < 500,
          colorScheme: theme,
          acceptDownloads: true,
        });
        const page = await context.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/__export_review${long ? '?long=1' : ''}`,
        );
        for (const format of ['HTML', 'Markdown']) {
          const pending = page.waitForEvent('download');
          await page.getByRole('button', { name: `${format} export` }).click();
          const download = await pending;
          const file = path.join(
            output,
            `${theme}-${width}-${long ? 'long' : 'control'}.${format === 'HTML' ? 'html' : 'md'}`,
          );
          await download.saveAs(file);
          assert.equal(await download.failure(), null);
          if (format === 'Markdown') {
            const markdown = await Bun.file(file).text();
            const fence = String.fromCharCode(96).repeat(5);
            assert.equal(
              markdown.split('\n').filter((line) => line === fence).length,
              2,
              'EXPECTED safe outer fences in actual downloaded Markdown',
            );
            assert(markdown.includes('const value = 1;'));
            passed++;
          }
          if (format === 'HTML') {
            const artifact = await context.newPage();
            artifact.on('pageerror', (e) => errors.push(e.message));
            await artifact.goto(pathToFileURL(file).href);
            const check = (name, run) => {
              try {
                run();
                passed++;
              } catch (e) {
                failures.push(`${theme}/${width}/${long}/${name}: ${e.message}`);
              }
            };
            const dimensions = await artifact.evaluate(() => ({
              viewport: innerWidth,
              content: document.documentElement.scrollWidth,
            }));
            check('viewport', () =>
              assert.equal(
                dimensions.viewport,
                width,
                'EXPECTED export to use the device viewport',
              ),
            );
            check('width', () =>
              assert(
                dimensions.content <= width + 1,
                `EXPECTED artifact to fit; ACTUAL ${JSON.stringify(dimensions)}`,
              ),
            );
            await artifact
              .locator('details')
              .last()
              .evaluate((el) => (el.open = true));
            await expect(artifact.locator('.tool details').last().locator('pre')).toContainText(
              '## output heading',
            );
            passed++;
            await artifact.screenshot({
              path: path.join(output, `${theme}-${width}-${long ? 'long' : 'control'}.png`),
              animations: 'disabled',
            });
            await artifact.close();
          }
        }
        await context.close();
      }
  assert.deepEqual(errors, [], 'Unexpected browser errors');
  console.log('ARTIFACT CHECKS:', passed, 'passed');
  if (failures.length) console.error(failures.join('\n'));
  assert.deepEqual(failures, [], 'PROBLEM CONFIRMED: exported HTML layout defects');
  console.log('PROBLEM NOT REPRODUCED; FIX VERIFIED');
} finally {
  await browser?.close();
  await server.close();
}
