import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer, transformWithOxc } from 'vite';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const beforeIndex = process.argv.indexOf('--before-dir');
const before = beforeIndex >= 0 ? path.resolve(process.argv[beforeIndex + 1]) : null;
const artifacts = path.resolve(app, '../../.temp_files/desktop-service-ack/browser-' + Date.now());
await mkdir(artifacts, { recursive: true });
const report = '.design/inspect/fixture/runs/12345678-1234-4123-8123-123456789abc/inspect.md';
const bytes = '# Original measured report\nSurface: app · viewports 375px · 0 FAIL · 0 WARN\n';
await writeFile(path.join(artifacts, 'report.md'), bytes);
const helperHash = createHash('sha256')
  .update(await readFile(fileURLToPath(import.meta.url)))
  .digest('hex');
const fixture = `
import {createRoot} from 'react-dom/client';import {useSyncExternalStore} from 'react';
import {EngineWorkspace} from '/src/EngineWorkspace.tsx';import {emptyEngineState,reduceEngine} from '/src/engine-state.ts';
import {surfaceI18n} from '/src/surface-i18n.ts';import {applyAppearance,defaultAppearance} from '/src/appearance.ts';
await surfaceI18n.changeLanguage('en');applyAppearance({...defaultAppearance,mode:'dark'},false);
window.chooseLanguage=language=>surfaceI18n.changeLanguage(language);window.chooseMode=mode=>applyAppearance({...defaultAppearance,mode},false);
let state=reduceEngine(emptyEngineState,{type:'session.start',payload:{sessionId:'fixture',eventEpoch:'one',provider:'fixture',model:'fixture',projectRoot:'D:/fixture',cwd:'D:/fixture',needsSetup:false}});
state=reduceEngine(state,{type:'tool.executed',payload:{id:'review',name:'design_reference',input:{action:'inspect',file:'fixture.html'},ok:true,output:JSON.stringify({action:'inspect',path:${JSON.stringify(report)},fails:0,warns:0,output:${JSON.stringify(bytes)}})}});
const tree={tree:[{name:'inspect.md',path:${JSON.stringify(report)},type:'file'}]}, mode=new URLSearchParams(location.search).get('listing');
const pending=[];window.releaseTree=()=>{window.bridge.released=true;pending.splice(0).forEach(resolve=>resolve(tree))};
window.bridge={calls:[],released:false,subscribe:()=>()=>{},snapshot:()=>state,send:async()=>{},command:async(type,payload)=>{
  window.bridge.calls.push({type,payload});
  if(type==='files.tree'){if(mode==='held'&&!window.bridge.released)return new Promise(resolve=>pending.push(resolve));if(mode==='failed')throw Error('Explorer listing unavailable');return tree}
  if(type==='files.read'){if(payload.filePath!==${JSON.stringify(report)})throw Error('Wrong report path');return {filePath:payload.filePath,content:await fetch('/__report').then(r=>r.text())}}
  return {files:[]};
}};
const noop=()=>{},save=async()=>true;
createRoot(document.getElementById('root')).render(<div className="app-shell"><div className="workspace-shell workspace-focused"><main className="main-content"><section className="session-workbench"><div className="session-workspace focused-session">
<EngineWorkspace id="artifact-navigation" sessionTitle="Artifact navigation" projectId="project" projectRoot="D:/fixture" scopeKey="D:/fixture" sessionStatus="running" mode="btw" draft="Keep this draft" draftConflict={false} onModeChange={noop} validateDraft={save} onDraftChange={save} references={[]} attachments={[]} inputDrafts={{}} onInputDraftChange={noop} onError={error=>{throw error}} onAttachmentsChange={save} onReferencesChange={save} onSettings={noop} onOpen={noop}/>
</div></section></main></div></div>);
`;
const modules = new Map([
  ['\0artifact-navigation.tsx', fixture],
  [
    '\0artifact-engine.tsx',
    `import {useSyncExternalStore} from 'react';function useFixture(){const b=window.bridge;return {state:useSyncExternalStore(b.subscribe,b.snapshot),send:b.send,command:b.command}}export const useEngine=useFixture,useProjectEngine=useFixture,useProfileEngine=useFixture;`,
  ],
  [
    '\0artifact-platform.tsx',
    `export * from '/src/platform.ts';export const native=false;export const request=async method=>method.endsWith('.open')||method.endsWith('.status')?{status:'running',error:null}:method==='file-drafts.list'?{drafts:[]}:{revision:0,value:null};export const fileDraftStorage=()=>({get:async()=>({revision:0,value:null}),save:async()=>1});`,
  ],
]);
const styles = [
  'styles',
  'chat',
  'workspace',
  'brand-tokens',
  'appearance',
  'workbench',
  'files',
  'git-history',
  'shell',
  'controls',
  'session-activity',
  'design-flow',
]
  .map((name) => `<link rel="stylesheet" href="/src/${name}.css">`)
  .join('');
const server = await createServer({
  root: app,
  configFile: path.join(app, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/src-tauri/**', '**/dist*/**'] } },
  plugins: [
    {
      name: 'known-artifact-navigation',
      enforce: 'pre',
      resolveId(id, importer) {
        if (id === 'virtual:artifact-navigation') return '\0artifact-navigation.tsx';
        if (!importer?.replaceAll('\\', '/').includes('/desktop-v2/src/')) return;
        if (id === './useEngine') return '\0artifact-engine.tsx';
        if (id === './platform' || id === './platform.ts') return '\0artifact-platform.tsx';
      },
      async load(id) {
        const code = modules.get(id);
        if (code)
          return (await transformWithOxc(code, 'fixture.tsx', { jsx: { runtime: 'automatic' } }))
            .code;
        if (before && id.replaceAll('\\', '/').includes('/desktop-v2/src/')) {
          const name = id.replaceAll('\\', '/').split('?')[0].split('/').at(-1);
          if (
            ['EngineWorkspace.tsx', 'ProjectSessionTools.tsx', 'FileWorkspace.tsx'].includes(name)
          )
            return readFile(path.join(before, name), 'utf8');
        }
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url, 'http://fixture');
          if (url.pathname === '/__report') {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end(await readFile(path.join(artifacts, 'report.md'), 'utf8'));
            return;
          }
          if (url.pathname !== '/__artifact-navigation') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(
            await server.transformIndexHtml(
              req.url,
              `<!doctype html><html lang="en"><head>${styles}</head><body><div id="root"></div><script type="module" src="/@id/virtual:artifact-navigation"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const browser = await chromium.launch({ headless: true }),
  receipt = [];
try {
  for (const sample of [
    { language: 'en', theme: 'dark', width: 1280, height: 840, listing: 'ready' },
    ...['held', 'failed'].flatMap((listing) => [
      { language: 'en', theme: 'dark', width: 1280, height: 840, listing },
      { language: 'tr', theme: 'light', width: 800, height: 600, listing },
    ]),
  ]) {
    const page = await browser.newPage({
        viewport: { width: sample.width, height: sample.height },
      }),
      errors = [];
    page.setDefaultTimeout(12000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/__artifact-navigation?listing=${sample.listing}`,
    );
    await page.locator('.session-workspace').waitFor();
    await page.evaluate(async ({ language, theme }) => {
      await window.chooseLanguage(language);
      window.chooseMode(theme);
      await document.fonts.ready;
    }, sample);
    await page
      .getByRole('navigation', {
        name: sample.language === 'tr' ? 'Ajan çalışma alanı görünümleri' : 'Agent workspace views',
      })
      .getByRole('button', { name: sample.language === 'tr' ? 'Araçlar' : 'Tools', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', {
        name: sample.language === 'tr' ? /Çalışma etkinliği/ : /Run activity/,
      })
      .click();
    await page
      .locator('.design-review-card')
      .getByRole('button', {
        name: sample.language === 'tr' ? 'Raporu aç' : 'Open report',
        exact: true,
      })
      .click();
    await page.locator('.file-workspace').waitFor();
    await page
      .waitForFunction(() => window.bridge.calls.some((call) => call.type === 'files.read'), null, {
        timeout: 1500,
      })
      .catch(() => {});
    const calls = await page.evaluate(() => window.bridge.calls);
    assert.equal(
      calls.filter((call) => call.type === 'files.read').length,
      1,
      'Known report navigation must send files.read independently of the explorer listing',
    );
    await page.waitForFunction(() =>
      document
        .querySelector('.native-file-content')
        ?.textContent.includes('Original measured report'),
    );
    assert.match(await page.locator('.native-file-content').textContent(), /0 FAIL/);
    assert.equal(calls.find((call) => call.type === 'files.read').payload.filePath, report);
    assert.deepEqual(errors, []);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    if (sample.listing === 'held') {
      assert.equal(await page.evaluate(() => window.bridge.released), false);
      assert.equal(await page.locator('.file-navigation .spin').count(), 1);
    }
    await page.screenshot({
      path: path.join(artifacts, `${sample.language}-${sample.listing}.png`),
    });
    if (sample.listing === 'held') {
      await page.evaluate(() => window.releaseTree());
      await page.locator('.file-navigation .spin').waitFor({ state: 'detached' });
      assert.equal(
        await page.evaluate(
          () => window.bridge.calls.filter((call) => call.type === 'files.read').length,
        ),
        1,
      );
    }
    receipt.push({ ...sample, helperHash, report, calls, errors });
    console.log('PASS', sample.language, sample.listing, `${sample.width}x${sample.height}`);
    await page.close();
  }
} finally {
  await writeFile(path.join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await browser.close();
  await server.close();
  console.log('ARTIFACTS', artifacts);
}
