import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer, transformWithOxc } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.resolve(
  root,
  '../../.temp_files/desktop-design-interruption/browser-' + Date.now(),
);
await mkdir(artifacts, { recursive: true });
const fixture = `
import {createRoot} from 'react-dom/client'; import {useState} from 'react';
import {EngineWorkspace} from '/src/EngineWorkspace.tsx';
import {emptyEngineState,reduceEngine} from '/src/engine-state.ts';
import '/src/styles.css'; import '/src/chat.css'; import '/src/workspace.css';
import '/src/workbench.css'; import '/src/appearance.css'; import '/src/shell.css';
const listeners = new Set();
let state = reduceEngine(emptyEngineState,{type:'session.start',payload:{sessionId:'fixture',eventEpoch:'engine-a',provider:'local',model:'fixture'}});
const input = {action:'extract',url:'https://example.test'};
for(const event of [
  {type:'tool.started',payload:{id:'complete',name:'design_reference',input}},
  {type:'tool.executed',payload:{id:'complete',name:'design_reference',ok:true,output:'Full 10-section DESIGN.md specification: .design/references/complete/DESIGN.md.'}},
]) state = reduceEngine(state,event);
window.bridge = {subscribe:notify=>{listeners.add(notify);return()=>listeners.delete(notify)},snapshot:()=>state,send:async()=>{},command:async()=>({})};
window.feed = (type,payload) => {state=reduceEngine(state,{type,payload});listeners.forEach(notify=>notify());};
const noop=()=>{},save=async()=>true;
function App(){
  const [sessionStatus,setSessionStatus]=useState('running'); window.setSessionStatus=setSessionStatus;
  return <div className="app-shell"><div className="workspace-shell workspace-focused"><main className="main-content"><section className="session-workbench"><div className="session-workspace focused-session">
    <EngineWorkspace id="design-fixture" sessionTitle="Design interruption" projectId="project" projectRoot="D:/fixture" scopeKey="D:/fixture" sessionStatus={sessionStatus}
      mode="btw" draft="Keep my design draft" draftConflict={false} onModeChange={noop} validateDraft={save} onDraftChange={save}
      references={[]} attachments={[]} inputDrafts={{}} onInputDraftChange={noop} onError={error=>{throw error}}
      onAttachmentsChange={save} onReferencesChange={save} onSettings={noop} onOpen={noop}/>
  </div></section></main></div></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
const modules = new Map([
  ['\0design-interruption.tsx', fixture],
  [
    '\0design-interruption-engine.tsx',
    `import {useSyncExternalStore} from 'react';function useFixture(){const b=window.bridge;return {state:useSyncExternalStore(b.subscribe,b.snapshot),send:b.send,command:b.command}} export const useEngine=useFixture,useProjectEngine=useFixture,useProfileEngine=useFixture;`,
  ],
  [
    '\0design-interruption-files.tsx',
    'export function ProjectSessionTools({initialPath}){return <h2>Opened {initialPath}</h2>}',
  ],
]);
const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/src-tauri/**', '**/dist*/**'] } },
  plugins: [
    {
      name: 'design-interruption-proof',
      enforce: 'pre',
      resolveId(id, importer) {
        if (id === 'virtual:design-interruption') return '\0design-interruption.tsx';
        if (!importer?.includes('/desktop-v2/src/')) return;
        if (id === './useEngine') return '\0design-interruption-engine.tsx';
        if (id === './ProjectSessionTools') return '\0design-interruption-files.tsx';
      },
      async load(id) {
        const code = modules.get(id);
        if (code)
          return (await transformWithOxc(code, 'fixture.tsx', { jsx: { runtime: 'automatic' } }))
            .code;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== '/__design-interruption') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<html lang="en"><body><div id="root"></div><script type="module" src="/@id/virtual:design-interruption"></script></body></html>',
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
  for (const viewport of [
    { width: 1280, height: 840 },
    { width: 800, height: 600 },
  ]) {
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__design-interruption`);
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Run activity/ })
      .click();
    const cards = page.locator(
      '.session-activity:not(.session-activity-compact) .design-extraction-card',
    );
    await cards.nth(0).getByRole('button', { name: 'Open DESIGN.md', exact: true }).waitFor();
    await page.evaluate(() => {
      window.feed('tool.started', {
        id: 'cut',
        name: 'design_reference',
        input: { action: 'extract' },
      });
      window.feed('tool.progress', {
        id: 'cut',
        name: 'design_reference',
        event: {
          text: '[3/4] Synthesizing',
          path: '.design/references/partial/DESIGN.md',
          operation: 'write',
        },
      });
      window.feed('session.start', {
        sessionId: 'fixture',
        eventEpoch: 'engine-a',
        provider: 'local',
        model: 'fixture',
      });
    });
    await cards.nth(1).locator('[data-state="running"]').waitFor();
    assert.equal(
      await cards.nth(1).getByRole('button', { name: 'Open DESIGN.md', exact: true }).count(),
      0,
    );
    await page.evaluate(() => window.setSessionStatus('interrupted'));
    await page.getByText('Engine stopped', { exact: true }).waitFor();
    assert.equal(
      await cards.nth(1).locator('[data-state="running"]').count(),
      0,
      'A stopped engine has no live extraction progress',
    );
    await cards.nth(1).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, `stopped-${viewport.width}.png`) });
    await page.evaluate(() => {
      window.feed('session.start', {
        sessionId: 'fixture',
        eventEpoch: 'engine-b',
        provider: 'local',
        model: 'fixture',
      });
      window.setSessionStatus('running');
      window.feed('tool.started', {
        id: 'cut',
        name: 'design_reference',
        input: { action: 'extract' },
      });
      window.feed('tool.progress', {
        id: 'cut',
        name: 'design_reference',
        event: { text: '[1/4] Measuring' },
      });
    });
    await cards.nth(2).locator('[data-state="running"]').waitFor();
    assert.equal(await cards.count(), 3);
    assert.equal(await cards.nth(1).locator('[data-state="running"]').count(), 0);
    assert.equal(
      await cards.nth(1).getByRole('button', { name: 'Open DESIGN.md', exact: true }).count(),
      0,
    );
    assert.equal(
      await cards.nth(0).getByRole('button', { name: 'Open DESIGN.md', exact: true }).count(),
      1,
    );
    await cards.nth(2).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, `next-running-${viewport.width}.png`) });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await cards.nth(0).getByRole('button', { name: 'Open DESIGN.md', exact: true }).click();
    await page
      .getByRole('heading', { name: 'Opened .design/references/complete/DESIGN.md', exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
    receipt.push({
      viewport,
      completedArtifact: true,
      interruptedRunning: false,
      freshExtractionRunning: true,
      errors,
    });
    console.log(
      `PASS ${viewport.width}x${viewport.height}: interrupted progress stays settled, reused ids stay separate, completed artifact opens`,
    );
    await page.close();
  }
} finally {
  await writeFile(path.join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await browser.close();
  await server.close();
  console.log('ARTIFACTS ' + artifacts);
}
