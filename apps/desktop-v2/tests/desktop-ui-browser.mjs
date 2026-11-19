import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from '@playwright/test';
import { createServer, transformWithOxc } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(root, '../../.temp_files/desktop-ui-browser');
const cacheDir = join(artifacts, `vite-${process.pid}`);
// Production App and controller. Only native transport, storage and runtime data are fixtures.
const source = `
import {createRoot} from 'react-dom/client';
import {App} from '/src/App.tsx';
import {defaultAppearance} from '/src/appearance.ts';
import '/src/styles.css'; import '/src/chat.css'; import '/src/workspace.css';
import '/src/brand-tokens.css'; import '/src/appearance.css'; import '/src/workbench.css';
import '/src/project.css'; import '/src/files.css'; import '/src/knowledge.css';
import '/src/atlas.css'; import '/src/chronicle.css'; import '/src/git-history.css';
import '/src/skills.css'; import '/src/shell.css'; import '/src/controls.css';
const now=Date.now();
const projects=[{id:'p1',name:'WrongStack UI',root:'D:/fixture/ui',createdAt:now},{id:'p2',name:'Unicode 検証 '+ 'long-project-'.repeat(5),root:'D:/fixture/unicode',createdAt:now}];
const titles=['Review the session workspace','Verify keyboard navigation','Investigate a failed build','Unicode 検証 '+ 'long-session-'.repeat(6)];
const sessions=titles.map((title,i)=>({id:'s'+i,projectId:i===3?'p2':'p1',title,kind:'agent',workdir:projects[i===3?1:0].root,status:i===2?'error':i===1?'interrupted':'running',createdAt:now-600000,updatedAt:now-60000*i,exitCode:null,error:i===2?'Fixture: build exited with a diagnostic':null}));
let appearance={...defaultAppearance,mode:location.pathname.endsWith('/light')?'light':'dark'};
const initialLayout=location.pathname.includes('/session')?JSON.stringify({project:'p1',selected:'s0',section:'fleet',openSessionIds:['s0']}):null;
const queues=new Map(),offsets=new Map();
window.uiCalls=[]; window.uiUnexpected=[];
const orphan={pid:912,identity:'123',image:'C:/Desktop/hosts/fixture/wrongstack-engine.exe'};
window.cleanup={rows:[orphan],scans:0,failScan:false,stops:[],fail:false};
const enqueue=(id,event)=>{const queue=queues.get(id)||[];queue.push(event);queues.set(id,queue);};
window.uiInvoke=async(command,args={})=>{
 if(command==='host_info')return {appVersion:'1.7.9',stale:false};
 if(command==='update_check')return null;
 if(command==='speech_status')return {available:false,reason:'Fixture: dictation unavailable'};
 if(command==='scan_orphan_engines'){
  window.cleanup.scans++;
  if(window.cleanup.failScan)throw Error('Scan failed');
  if(window.cleanup.holdScan)await new Promise(resolve=>{window.finishScan=resolve;});
  return window.cleanup.rows;
 }
 if(command==='stop_orphan_engine'){
  window.cleanup.stops.push(args.target);
  if(window.cleanup.fail)throw Error('Process is no longer a confirmed orphan');
  window.cleanup.rows=[];
  return null;
 }
 if(command!=='host_request')throw Error('Unexpected native command '+command);
 const {method,params}=args;window.uiCalls.push({method,params});
 if(method==='snapshot')return {projects,sessions,hostPid:1,layout:initialLayout,appearance:JSON.stringify(appearance)};
 if(method==='settings.save'){if(params.key==='appearance')appearance=JSON.parse(params.value);return null;}
 if(method==='draft.get')return {text:'',references:[],attachments:[],mode:'btw',revisions:{text:0,references:0,attachments:0,mode:0}};
 if(method==='draft.object'||method==='form-draft.get')return {value:null,revision:0};
 if(method==='draft.save'||method==='form-draft.save')return {revision:(params.expectedRevision||0)+1};
 if(method==='engine.http'||method==='project.http')return {status:200,body:{}};
 if(method==='engine.status'||method==='project.status')return {running:true,offset:0};
 if(method==='engine.start'||method==='project.start')return null;
 if(method==='engine.events'){
  const id=params.id;let events=queues.get(id)||[];queues.set(id,[]);
  if(params.offset===0)events=[{type:'session.start',payload:{sessionId:id,provider:'fixture',model:'Fixture model',reset:true,protocolCapabilities:['session.user-ack'],replayMessages:[{role:'user',content:'Review the workspace layout and keep the important controls easy to reach.'},{role:'assistant',content:'The session layout is ready for review.\\n\\n- Keep the leader conversation primary.\\n- Inspect delegated work without changing the input destination.\\n- Verify the plan and keyboard navigation.'}],agentSessions:Array.from({length:5},(_,i)=>({subagentId:'worker'+i,agentName:i===0?'Accessibility review':i===1?'Unicode 検証 '+ 'long-name-'.repeat(10):'Layout review '+i,status:i%2?'running':'completed',task:'Check responsive layout and keyboard access',transcript:[{id:'entry'+i,kind:'text',content:'Verified the session boundary and reviewed the layout.',iteration:1}]}))}},{type:'prefs.updated',payload:{autonomy:'off',enhanceEnabled:false,uiLocale:'en'}},...events];
  const offset=(offsets.get(id)||0)+events.length;offsets.set(id,offset);return {offset,events,hasMore:false};
 }
 if(method==='engine.send'){
  const {type,payload}=params.message;const requestId=payload.requestId;
  if(type==='todos.get')enqueue(params.id,{type:'todos.updated',payload:{requestId,todos:[{id:'layout',content:'Verify the session layout',status:'in_progress'},{id:'keyboard',content:'Check keyboard navigation',status:'pending'}]}});
  else if(type==='prefs.get')enqueue(params.id,{type:'prefs.updated',payload:{requestId,autonomy:'off',enhanceEnabled:false}});
  else if(requestId)enqueue(params.id,{type:'key.operation_result',payload:{requestId,success:true}});
  return null;
 }
 if(method==='project.events')return {offset:1,events:[],hasMore:false};
 window.uiUnexpected.push(method);throw Error('Unexpected host method '+method);
};
createRoot(document.getElementById('root')).render(<App/>);`;
const server = await createServer({
  root,
  cacheDir,
  configFile: join(root, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null },
  plugins: [
    {
      name: 'desktop-ui-fixture',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'virtual:desktop-ui') return '\0desktop-ui.tsx';
        if (id === '@tauri-apps/api/core') return '\0desktop-ui-native.ts';
        if (id === '@tauri-apps/api/webview') return '\0desktop-ui-webview.ts';
      },
      async load(id) {
        if (id === '\0desktop-ui-native.ts')
          return 'export const isTauri=()=>true; export const invoke=(...args)=>window.uiInvoke(...args); export class Channel {}';
        if (id === '\0desktop-ui-webview.ts')
          return 'export const getCurrentWebview=()=>({setZoom:async()=>{}});';
        if (id === '\0desktop-ui.tsx')
          return (await transformWithOxc(source, 'fixture.tsx', { jsx: { runtime: 'automatic' } }))
            .code;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!/^\/__desktop-ui(?:\/session)?(?:\/light)?$/.test(req.url?.split('?')[0] ?? ''))
            return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><title>Desktop UI fixture</title></head><body><div id="root"></div><script type="module" src="/@id/virtual:desktop-ui"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
let browser;
let page;
try {
  await mkdir(artifacts, { recursive: true });
  await server.listen();
  const url = server.resolvedUrls.local[0] + '__desktop-ui';
  if (process.argv.includes('--serve')) {
    console.log(`Desktop UI fixture: ${url}`);
    await writeFile(join(artifacts, 'url.txt'), url);
    await new Promise((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } else {
    browser = await chromium.launch({ headless: true });
    for (const mode of ['dark', 'light']) {
      for (const [width, height] of [
        [1440, 900],
        [900, 650],
        [390, 800],
        [1280, 480],
      ]) {
        const context = await browser.newContext({
          viewport: { width, height },
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        page.setDefaultTimeout(20000);
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.locator('.session-card').first().waitFor();
        if (mode === 'light')
          await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
        await page.screenshot({ path: join(artifacts, `${mode}-${width}-${height}-fleet.png`) });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          'Fleet has no page overflow',
        );
        assert.deepEqual(
          (await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()).violations,
          [],
          'Fleet contrast',
        );
        const search = page.getByRole('textbox', { name: 'Search sessions', exact: true });
        await search.fill('no-such-fixture-session');
        assert.equal(await page.locator('.session-card').count(), 0);
        await search.fill('');
        assert.equal(await page.locator('.session-card').count(), 4);
        await page.locator('.card-pin').first().click();
        assert.equal(await page.locator('.card-pin').first().getAttribute('aria-pressed'), 'true');
        await page.locator('.session-card-main').first().click();
        await page.getByRole('textbox', { name: 'Message WrongStack', exact: true }).waitFor();
        await page
          .locator('.native-chat-messages')
          .getByText('The session layout is ready for review.', { exact: false })
          .waitFor();
        await page.screenshot({ path: join(artifacts, `${mode}-${width}-${height}-session.png`) });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          'Session has no page overflow',
        );
        for (const selector of [
          '.session-tab-label',
          '.session-stop',
          '.session-view-slot',
          '.composer-send',
          '.composer-options > summary',
        ]) {
          const box = await page.locator(selector).first().boundingBox();
          assert.ok(
            box &&
              box.width >= 24 &&
              box.height >= 24 &&
              box.x >= 0 &&
              box.y >= 0 &&
              box.x + box.width <= width + 1 &&
              box.y + box.height <= height + 1,
            `${selector} stays reachable at ${width}x${height}: ${JSON.stringify(box)}`,
          );
        }
        const options = page.locator('.composer-options > summary');
        await options.focus();
        await page.keyboard.press('Enter');
        const menu = page.locator('.composer-options[open] > div');
        await menu.waitFor();
        const menuBox = await menu.boundingBox();
        assert.ok(
          menuBox &&
            menuBox.x >= 0 &&
            menuBox.y >= 0 &&
            menuBox.x + menuBox.width <= width &&
            menuBox.y + menuBox.height <= height,
          `Menu fits viewport: ${JSON.stringify(menuBox)}`,
        );
        await menu.locator('button').last().scrollIntoViewIfNeeded();
        assert.equal(
          await menu
            .locator('button')
            .last()
            .evaluate((element) => {
              const r = element.getBoundingClientRect();
              return element.contains(
                document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
              );
            }),
          true,
          'Last menu command is not clipped by the chat column',
        );
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.composer-options').getAttribute('open'), null);
        assert.equal(await options.evaluate((element) => element === document.activeElement), true);
        await page.getByRole('button', { name: 'Collapse session panel', exact: true }).click();
        assert.equal(
          await page.locator('.session-inspector').getAttribute('data-collapsed'),
          'true',
        );
        await page.getByRole('button', { name: 'Expand session panel', exact: true }).click();
        assert.deepEqual(
          (await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()).violations,
          [],
          'Session contrast',
        );
        await page.goto(url + '/session', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.getByRole('textbox', { name: 'Message WrongStack', exact: true }).waitFor();
        const restored = await page.locator('.session-view-slot').boundingBox();
        assert.ok(
          restored &&
            restored.width >= 24 &&
            restored.x >= 0 &&
            restored.x + restored.width <= width,
          'Restored session navigation stays visible',
        );
        assert.equal(await page.evaluate(() => window.cleanup.scans), 0);
        await page.evaluate(() => {
          window.cleanup.holdScan = true;
        });
        await page.getByRole('tab', { name: 'Agents', exact: true }).press('End');
        const details = page.getByRole('tabpanel', { name: 'Details', exact: true });
        const pids = details.getByRole('status');
        await pids.getByText('Checking engine processes…').waitFor();
        await page.waitForFunction(() => typeof window.finishScan === 'function');
        await page.evaluate(() => {
          window.cleanup.holdScan = false;
          window.finishScan();
        });
        await pids.getByText('912', { exact: true }).waitFor();
        await details.getByText('Orphaned engine PIDs (desktop-wide)').waitFor();
        const refresh = details.getByRole('button', { name: 'Refresh PIDs' });
        await refresh.scrollIntoViewIfNeeded();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await page.evaluate(() => {
          window.cleanup.failScan = true;
        });
        await refresh.press('Enter');
        await pids.getByText('Could not scan for orphaned engines.').waitFor();
        await page.evaluate(() => {
          window.cleanup.failScan = false;
          window.fixtureOrphans = window.cleanup.rows;
          window.cleanup.rows = [];
        });
        await refresh.press('Enter');
        await pids.getByText('No confirmed orphaned engines found.').waitFor();
        await page.evaluate(() => {
          window.cleanup.rows = window.fixtureOrphans;
        });
        assert.equal(await details.getByRole('button', { name: /stop/i }).count(), 0);

        const office = page.locator('.topbar .office-shortcut');
        assert.equal(await office.count(), 1, 'One Office shortcut in the focused header');
        const shortcut = await office.boundingBox();
        assert.ok(shortcut && shortcut.x > width / 2 && shortcut.x + shortcut.width <= width);
        await office.press('Enter');
        await page.locator('.office-shortcut[aria-current="page"]').waitFor();

        await page.getByRole('button', { name: 'Activity', exact: true }).click();
        const chooser = page.locator('.office-shortcut > summary');
        await chooser.press('Enter');
        await page
          .locator('.office-projects')
          .getByRole('button', { name: 'WrongStack UI' })
          .waitFor();
        await page.keyboard.press('Escape');
        assert.equal(await chooser.evaluate((node) => node === document.activeElement), true);

        const cleanup = page.getByRole('region', { name: 'Background engines' });
        const scan = cleanup.getByRole('button', { name: 'Scan for orphaned engines' });
        await scan.click();
        await cleanup.getByRole('button', { name: 'Stop PID 912', exact: true }).click();
        await cleanup.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(await page.evaluate(() => window.cleanup.stops.length), 0);
        await page.evaluate(() => {
          window.cleanup.fail = true;
        });
        await cleanup.getByRole('button', { name: 'Stop PID 912', exact: true }).click();
        await cleanup.getByRole('button', { name: 'Force stop PID 912' }).click();
        await cleanup
          .getByRole('alert')
          .getByText(/no longer a confirmed orphan/)
          .waitFor();
        await page.evaluate(() => {
          window.cleanup.fail = false;
        });
        await scan.click();
        await cleanup.getByRole('button', { name: 'Stop PID 912', exact: true }).click();
        await cleanup.getByRole('button', { name: 'Force stop PID 912' }).click();
        await cleanup.getByText('Stopped engine PID 912.').waitFor();
        assert.equal(await page.evaluate(() => window.cleanup.stops.at(-1).identity), '123');
        await scan.click();
        await cleanup.getByText('No confirmed orphaned engines found.').waitFor();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        assert.deepEqual(errors, []);
        assert.deepEqual(await page.evaluate(() => window.uiUnexpected), []);
        console.log(
          `PASS: real App ${mode} ${width}x${height}; fleet, session, no overflow or runtime errors`,
        );
        await context.close();
      }
    }
  }
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(artifacts, 'failure.png') });
    console.error(
      await page.evaluate(() => ({
        unexpected: window.uiUnexpected,
        text: document.body.textContent.slice(0, 1800),
      })),
    );
  }
  throw error;
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
