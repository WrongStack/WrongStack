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

async function assertSquareCorners(page, state) {
  const rounded = await page.evaluate(() => {
    const corners = ['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight'];
    const offenders = [];
    for (const element of document.body.querySelectorAll('*')) {
      for (const pseudo of [null, '::before', '::after']) {
        const style = getComputedStyle(element, pseudo);
        if (pseudo && style.content === 'none') continue;
        if (corners.some((corner) => style[`border${corner}Radius`] !== '0px')) {
          offenders.push(
            `${element.tagName}.${element.getAttribute('class') ?? ''}${pseudo ?? ''}`,
          );
        }
        if (offenders.length >= 12) return offenders;
      }
    }
    return offenders;
  });
  assert.deepEqual(rounded, [], `${state} must have square corners`);
}

async function assertActionInView(action, name) {
  const result = await action.evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return {
      rect: [x, y, width, height],
      reachable:
        width >= 24 &&
        height >= 24 &&
        element.contains(document.elementFromPoint(x + width / 2, y + height / 2)) &&
        element.contains(document.elementFromPoint(x + width / 2, y + height - 3)),
    };
  });
  assert.ok(result.reachable, `${name} is immediately clickable: ${result.rect.join(', ')}`);
}

async function assertSearchIconSpacing(search) {
  assert.ok(
    await search.evaluate((element) => {
      const icon = element.parentElement.querySelector('svg');
      const style = getComputedStyle(element);
      return (
        icon &&
        icon.getBoundingClientRect().right < element.getBoundingClientRect().left &&
        style.borderLeftWidth === '0px' &&
        style.marginTop === '0px'
      );
    }),
    'The search icon and text share one frame in separate columns',
  );
}

// Production App and controller. Only native transport, storage and runtime data are fixtures.
const source = `
import '/src/square-corners.css';
import {createRoot} from 'react-dom/client';
import {App} from '/src/App.tsx';
import {defaultAppearance} from '/src/appearance.ts';
import '/src/styles.css'; import '/src/chat.css'; import '/src/workspace.css';
import '/src/brand-tokens.css'; import '/src/appearance.css'; import '/src/workbench.css';
import '/src/project.css'; import '/src/files.css'; import '/src/knowledge.css';
import '/src/atlas.css'; import '/src/chronicle.css'; import '/src/git-history.css';
import '/src/skills.css'; import '/src/shell.css'; import '/src/controls.css';
import '/src/ide-workbench.css';
const now=Date.now();
const projects=[{id:'p1',name:'WrongStack UI',root:'D:/fixture/ui',createdAt:now},{id:'p2',name:'Unicode 検証 '+ 'long-project-'.repeat(5),root:'D:/fixture/unicode',createdAt:now}];
const titles=['Review the session workspace','Verify keyboard navigation','Investigate a failed build','Unicode 検証 '+ 'long-session-'.repeat(6)];
const terminal=location.search.includes('terminal');
const sessions=titles.map((title,i)=>({id:'s'+i,projectId:i===3?'p2':'p1',title,kind:'agent',workdir:projects[i===3?1:0].root,status:i===2?'error':i===1?'interrupted':'running',createdAt:now-600000,updatedAt:now-60000*i,exitCode:null,error:i===2?'Fixture: build exited with a diagnostic':null})).concat(terminal?[{id:'st0',projectId:'p1',title:'Fixture terminal',kind:'terminal',workdir:projects[0].root,status:'running',createdAt:now-300000,updatedAt:now-1000,exitCode:null,error:null}]:[]);
const acp=location.search.includes('acp');
const model=acp?'fixture-agent':'Fixture model';
let runtime={};
const longModel='review-model-with-a-long-qualified-name';
let appearance={...defaultAppearance,mode:location.pathname.endsWith('/light')?'light':'dark'};
const initialLayout=location.pathname.includes('/session')?JSON.stringify({project:'p1',selected:'s0',section:'fleet',openSessionIds:['s0']}):null;
const queues=new Map(),offsets=new Map();
window.uiCalls=[]; window.uiUnexpected=[]; window.terminalStreams=[]; window.terminalAcks=[]; window.terminalStops=[];
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
 if(command==='terminal_stream'){window.terminalStreams.push({id:args.id,subscription:args.subscription,channel:args.channel});return null;}
 if(command==='terminal_ack'){window.terminalAcks.push(args.subscription);return null;}
 if(command==='terminal_stop'){window.terminalStops.push(args.subscription);return null;}
 if(command!=='host_request')throw Error('Unexpected native command '+command);
 const {method,params}=args;window.uiCalls.push({method,params});
 if(method==='snapshot')return {projects,sessions,hostPid:1,layout:initialLayout,appearance:JSON.stringify(appearance)};
 if(method==='settings.save'){if(params.key==='appearance')appearance=JSON.parse(params.value);return null;}
 if(method==='draft.get')return {text:'',references:[],attachments:[],mode:'btw',revisions:{text:0,references:0,attachments:0,mode:0}};
 if(method==='draft.object'||method==='form-draft.get')return {value:null,revision:0};
 if(method==='draft.save'||method==='form-draft.save')return {revision:(params.expectedRevision||0)+1};
 if(method==='engine.http'||method==='project.http')return {status:200,body:{}};
 if(method==='engine.status')return {running:true,offset:0};
 if(method==='project.status')return {status:'running',error:null};
 if(method==='project.open')return null;
 if(method==='engine.start'||method==='project.start')return null;
 if(method==='profile.open')return null;
 if(method==='profile.status')return {status:'running',error:null};
 if(method==='profile.events'||method==='engine.events'){
  const id=params.id;let events=queues.get(id)||[];queues.set(id,[]);
  if(params.offset===0)events=[{type:'session.start',payload:{sessionId:id,provider:acp?'acp':'fixture',model,reset:true,protocolCapabilities:['session.user-ack'],replayMessages:[{role:'user',content:'Review the workspace layout and keep the important controls easy to reach.'},{role:'assistant',content:'The session layout is ready for review.\\n\\n- Keep the leader conversation primary.\\n- Inspect delegated work without changing the input destination.\\n- Verify the plan and keyboard navigation.'}],agentSessions:Array.from({length:5},(_,i)=>({subagentId:'worker'+i,agentName:i===0?'Accessibility review':i===1?'Unicode 検証 '+ 'long-name-'.repeat(10):'Layout review '+i,status:i%2?'running':'completed',task:'Check responsive layout and keyboard access',transcript:[{id:'entry'+i,kind:'text',content:'Verified the session boundary and reviewed the layout.',iteration:1}]}))}},{type:'prefs.updated',payload:{autonomy:'off',enhanceEnabled:false,uiLocale:'en'}},...events];
  const offset=(offsets.get(id)||0)+events.length;offsets.set(id,offset);return {offset,events,hasMore:false};
 }
 if(method==='profile.send'||method==='engine.send'){
  const {type,payload}=params.message;const requestId=payload.requestId;
  if(type==='todos.get')enqueue(params.id,{type:'todos.updated',payload:{requestId,todos:[{id:'layout',content:'Verify the session layout',status:'in_progress'},{id:'keyboard',content:'Check keyboard navigation',status:'pending'}]}});
  else if(type==='prefs.get')enqueue(params.id,{type:'prefs.updated',payload:{requestId,autonomy:'off',enhanceEnabled:false,acpRuntime:runtime,favoriteModels:[],disabledModels:[],disabledProviders:[]}});
  else if(type==='prefs.update'){
   runtime=payload.acpRuntime||runtime;
   enqueue(params.id,{type:'key.operation_result',payload:{requestId,success:true}});
  }
  else if(type==='context.debug')enqueue(params.id,{type,payload:{requestId,total:3500,systemPrompt:500,tools:{total:1000,count:30,breakdown:Array.from({length:30},(_,i)=>({name:'workspace-tool-'+i,tokens:33}))},messages:{total:2000,count:1,breakdown:[{role:'user',preview:'Review session workspace',tokens:2000}]},mode:'adaptive'}});
  else if(type==='providers.list')enqueue(params.id,{type:'provider.catalog',payload:{requestId,providers:[{id:acp?'acp':'fixture',name:acp?'ACP agents':'Fixture provider'}]}});
  else if(type==='providers.saved')enqueue(params.id,{type,payload:{requestId,providers:[]}});
  else if(type==='provider.models')enqueue(params.id,{type,payload:{requestId,provider:payload.providerId,models:[{id:model,name:acp?'Fixture agent':model},{id:longModel,name:'Review model'}]}});
  else if(type==='model.switch')enqueue(params.id,{type:'model.switch_result',payload:{requestId,success:true,provider:payload.provider,model:payload.model}});
  else if(type==='acp.config_options' && window.failAcpOptions){
   window.failAcpOptions=false;
   enqueue(params.id,{type,payload:{requestId,ok:false,error:'Fixture agent unavailable'}});
  }
  else if(type==='acp.config_options')enqueue(params.id,{type,payload:{requestId,ok:true,options:[{id:'model',name:'Model',category:'model',currentValue:payload.values?.model||'default',options:[{value:'default',name:'Default'},{value:longModel,name:longModel}]}]}});
  else if(requestId)enqueue(params.id,{type:'key.operation_result',payload:{requestId,success:true}});
  return null;
 }
 if(method==='project.events')return {offset:1,events:params.offset===0?[{type:'session.start',payload:{sessionId:'carrier-'+params.projectId,provider:'fixture',model:'Fixture model'}}]:[],hasMore:false};
 if(method==='project.send')return null;
 if(method==='session.resize'||method==='session.write')return null;
 window.uiUnexpected.push(method);throw Error('Unexpected host method '+method);
};
createRoot(document.getElementById('root')).render(<App/>);`;
const server = await createServer({
  root,
  cacheDir,
  configFile: join(root, 'vite.config.ts'),
  // Lazy route imports must not trigger a dependency-optimizer reload mid-interaction.
  optimizeDeps: {
    noDiscovery: true,
    include: [
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
      'i18next',
      'i18next-resources-to-backend',
      'react-i18next',
      'lucide-react',
      'clsx',
      'react-markdown',
      'rehype-highlight',
      'remark-gfm',
      'tailwind-merge',
      'virtua',
      '@xyflow/react',
      '@monaco-editor/react',
      '@xterm/addon-fit',
      '@xterm/xterm',
    ],
  },
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
let pageErrors = [];
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
        [800, 600],
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
        pageErrors = errors;
        page.on('pageerror', (error) => errors.push(String(error)));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await page.goto(width === 800 ? `${url}?acp` : url, {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        await page.locator('.session-card').first().waitFor();
        if (mode === 'light')
          await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
        const desktopMenu = page.getByRole('button', { name: 'Desktop', exact: true });
        const explorerToggle = page.getByRole('button', {
          name: 'Projects and sessions',
          exact: true,
        });
        const explorer = page.locator('.sidebar .explorer');
        const workspace = page.locator('.workspace-shell');
        const originalWidth = (await workspace.boundingBox()).width;
        const compact = width < 620;
        assert.equal(await explorer.isVisible(), !compact);
        await desktopMenu.press('ArrowDown');
        const desktopPopup = page.getByRole('menu', { name: 'Desktop', exact: true });
        await desktopPopup.waitFor();
        await assertSquareCorners(page, 'Desktop menu');
        assert.ok(
          await desktopPopup
            .getByRole('menuitem')
            .first()
            .evaluate((el) => el === document.activeElement),
        );
        await page.keyboard.press('ArrowDown');
        const menuExplorer = desktopPopup.getByRole('menuitemcheckbox');
        assert.ok(await menuExplorer.evaluate((el) => el === document.activeElement));
        await page.keyboard.press('Enter');
        await desktopPopup.waitFor({ state: 'hidden' });
        await explorer.waitFor({ state: compact ? 'visible' : 'hidden' });
        const toggledWidth = (await workspace.boundingBox()).width;
        if (compact)
          assert.equal(
            toggledWidth,
            originalWidth,
            'compact Explorer overlays instead of resizing',
          );
        else
          assert.ok(
            toggledWidth > originalWidth,
            'collapsing Explorer gives width back to the workspace',
          );
        await page.keyboard.press(compact ? 'Escape' : 'Control+b');
        await explorer.waitFor({ state: compact ? 'hidden' : 'visible' });
        assert.ok(await explorerToggle.evaluate((el) => el === document.activeElement));
        await desktopMenu.press('ArrowUp');
        await desktopPopup.waitFor();
        await page.keyboard.press('Escape');
        await desktopPopup.waitFor({ state: 'hidden' });
        assert.ok(await desktopMenu.evaluate((el) => el === document.activeElement));
        await desktopMenu.click();
        await desktopPopup.getByRole('menuitem').first().click();
        const palette = page.getByRole('dialog', { name: 'Find anything', exact: true });
        await palette.waitFor();
        const paletteSearch = palette.getByRole('combobox');
        assert.ok(await paletteSearch.evaluate((element) => document.activeElement === element));
        await assertSearchIconSpacing(paletteSearch);
        assert.equal(await palette.getByRole('group', { name: 'Commands' }).count(), 1);
        assert.equal(await palette.getByRole('group', { name: 'Projects' }).count(), 1);
        assert.equal(await palette.getByRole('group', { name: 'Sessions' }).count(), 1);
        if (width === 1440) {
          const accessibility = await new AxeBuilder({ page })
            .include('.workspace-palette')
            .withRules([
              'aria-allowed-role',
              'aria-required-children',
              'aria-valid-attr-value',
              'color-contrast',
            ])
            .analyze();
          assert.deepEqual(accessibility.violations, [], 'Command palette accessibility');
        }
        await page.screenshot({ path: join(artifacts, `${mode}-${width}-${height}-palette.png`) });
        const firstCommand = await paletteSearch.getAttribute('aria-activedescendant');
        await paletteSearch.press('ArrowDown');
        assert.notEqual(await paletteSearch.getAttribute('aria-activedescendant'), firstCommand);
        assert.ok(await paletteSearch.evaluate((element) => document.activeElement === element));
        await paletteSearch.fill('no-result-command');
        await palette
          .getByRole('status')
          .getByText('No matching commands, projects, or sessions.')
          .waitFor();
        assert.equal(await paletteSearch.getAttribute('aria-activedescendant'), null);
        await paletteSearch.fill('start a new agent session');
        await paletteSearch.press('Enter');
        await page.getByRole('dialog', { name: 'New session', exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await palette.waitFor({ state: 'hidden' });
        assert.equal(await page.getByRole('dialog').count(), 0);
        if (width === 800 || width === 1440) {
          const opener = page
            .locator('.topbar')
            .getByRole('button', { name: 'New session', exact: true });
          await opener.click();
          const newSession = page.getByRole('dialog');
          await assertActionInView(
            newSession.getByRole('button', { name: 'Create agent session' }),
            'Create agent session',
          );
          await newSession.getByRole('button', { name: /Terminal/ }).click();
          await assertActionInView(
            newSession.getByRole('button', { name: 'Create terminal session' }),
            'Create terminal session',
          );
          assert.equal(await newSession.getAttribute('aria-labelledby'), 'dialog-title');
          await newSession.getByRole('button', { name: 'Cancel', exact: true }).click();
          await newSession.waitFor({ state: 'hidden' });
          assert.ok(await opener.evaluate((element) => element === document.activeElement));
        }
        if (width === 1440) {
          const splitter = page.getByRole('separator', { name: 'Projects and sessions' });
          const original = Number(await splitter.getAttribute('aria-valuenow'));
          await splitter.press('ArrowRight');
          assert.equal(await splitter.getAttribute('aria-valuenow'), String(original + 8));
          const box = await splitter.boundingBox();
          assert.ok(box);
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2);
          await page.mouse.up();
          assert.equal(await splitter.getAttribute('aria-valuenow'), String(original + 28));
          await page.setViewportSize({ width: 590, height });
          await splitter.waitFor({ state: 'hidden' });
          await page.setViewportSize({ width, height });
          await splitter.waitFor();
          assert.equal(await splitter.getAttribute('aria-valuenow'), String(original + 28));
          await page.reload();
          await splitter.waitFor();
          assert.equal(await splitter.getAttribute('aria-valuenow'), String(original + 28));
          await desktopMenu.click();
          await desktopPopup.getByRole('menuitem', { name: 'Workspace layout' }).click();
          const layout = page.getByRole('dialog', { name: 'Workspace layout' });
          await layout.waitFor();
          await assertSquareCorners(page, 'Workspace layout');
          const focusPreset = layout.getByRole('button', { name: 'Focus', exact: true });
          const codePreset = layout.getByRole('button', { name: 'Code', exact: true });
          await focusPreset.press('Enter');
          await explorer.waitFor({ state: 'hidden' });
          assert.equal(await focusPreset.getAttribute('aria-pressed'), 'true');
          assert.equal(await codePreset.getAttribute('aria-pressed'), 'false');
          await page.screenshot({ path: join(artifacts, `${mode}-workspace-layout.png`) });
          await codePreset.click();
          await explorer.waitFor();
          await layout.getByRole('spinbutton', { name: 'Projects and sessions width' }).fill('300');
          await layout.getByRole('button', { name: 'Apply pane settings' }).click();
          assert.equal(await splitter.getAttribute('aria-valuenow'), '300');
          await layout.getByRole('button', { name: 'Reset layout' }).click();
          assert.equal(await splitter.getAttribute('aria-valuenow'), String(original));
          await page.keyboard.press('Escape');
          await layout.waitFor({ state: 'hidden' });
          await page.locator('.session-card').first().waitFor();
          const lightSwitch = page.getByRole('button', {
            name: 'Switch to light mode',
            exact: true,
          });
          if (mode === 'light' && (await lightSwitch.isVisible())) await lightSwitch.click();
        }
        const statusBar = page.locator('.desktop-status-bar');
        await statusBar.getByRole('status', { name: 'Local engine connected' }).waitFor();
        const statusBox = await statusBar.boundingBox();
        assert.ok(statusBox && Math.abs(statusBox.y + statusBox.height - height) <= 1);
        await assertSquareCorners(page, 'Fleet');
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
        await assertActionInView(page.locator('.composer-send'), 'Send message');
        if (width === 1440) {
          const prose = await page
            .locator('.native-chat-messages .markdown-content > p')
            .first()
            .evaluate((paragraph) => ({
              width: paragraph.getBoundingClientRect().width,
              available: paragraph.parentElement.getBoundingClientRect().width,
              lineHeight: parseFloat(getComputedStyle(paragraph).lineHeight),
            }));
          assert.ok(
            prose.width < prose.available && prose.lineHeight >= 25,
            'Prose has a readable measure inside the wide transcript',
          );
          const inspector = page.locator('.session-inspector');
          const divider = inspector.getByRole('separator');
          const start = Number(await divider.getAttribute('aria-valuenow'));
          const startWidth = (await inspector.boundingBox()).width;
          await divider.press('ArrowLeft');
          assert.equal(await divider.getAttribute('aria-valuenow'), String(start + 8));
          assert.equal((await inspector.boundingBox()).width, startWidth + 8);
          await divider.press('ArrowRight');
        }
        await assertSquareCorners(page, 'Session');
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
        const modelButton = page.locator('.model-selector');
        await modelButton.click();
        const picker = page.locator('.profile-model-picker');
        await picker.locator('button[aria-pressed="true"]').first().waitFor();
        const modelSearch = picker.getByRole('textbox');
        assert.ok(await modelSearch.evaluate((element) => document.activeElement === element));
        await assertSearchIconSpacing(modelSearch);
        await modelSearch.fill('no-result-model');
        assert.equal(await picker.locator('.composer-model-list > button').count(), 0);
        await modelSearch.fill('Review model');
        assert.equal(await picker.locator('.composer-model-list > button').count(), 1);
        await modelSearch.press('ArrowDown');
        const result = picker.locator('.composer-model-list > button').first();
        assert.ok(await result.evaluate((element) => document.activeElement === element));
        await result.press('ArrowUp');
        assert.ok(await modelSearch.evaluate((element) => document.activeElement === element));
        await modelSearch.fill('');
        await assertSquareCorners(page, 'Model picker');
        await page.screenshot({ path: join(artifacts, `${mode}-${width}-${height}-models.png`) });
        await page.keyboard.press('Escape');
        await picker.waitFor({ state: 'hidden' });
        assert.ok(await modelButton.evaluate((el) => el === document.activeElement));
        if (width === 1440) {
          await modelButton.press('Enter');
          await picker.locator('button[aria-pressed="true"]').first().waitFor();
          await modelSearch.fill('Review model');
          await modelSearch.press('Enter');
          await picker.waitFor({ state: 'hidden' });
          const switchedModel = await page.evaluate(
            () =>
              window.uiCalls.find(({ params }) => params.message?.type === 'model.switch')?.params
                .message.payload.model,
          );
          assert.equal(switchedModel, 'review-model-with-a-long-qualified-name');
          assert.ok(await modelButton.evaluate((element) => element === document.activeElement));
        }

        const contextMenu = page.locator('.composer-options > summary');
        await contextMenu.press('Enter');
        await page
          .locator('.composer-options')
          .getByRole('button', { name: /context/i })
          .click();
        const contextDialog = page.locator('.context-inspector');
        await contextDialog.locator('.context-summary').getByText('3,500').waitFor();
        await contextDialog.locator('details > summary').first().click();
        const footer = contextDialog.locator(':scope > footer');
        const footerBox = await footer.boundingBox();
        assert.ok(footerBox && footerBox.y + footerBox.height <= height);
        await footer.getByRole('button', { name: 'Clear provider context' }).click();
        await contextDialog
          .getByRole('heading', { name: 'Clear this provider context?' })
          .waitFor();
        await contextDialog.getByRole('button', { name: 'Keep context' }).click();
        await page.screenshot({ path: join(artifacts, `${mode}-${width}-${height}-context.png`) });
        await page.keyboard.press('Escape');
        await contextDialog.waitFor({ state: 'hidden' });

        if (width === 800) {
          const trigger = page.locator('.session-model-controls .acp-runtime-controls > summary');
          const composer = page.locator('.native-composer');
          const before = await composer.boundingBox();
          await page.evaluate(() => {
            window.failAcpOptions = true;
          });
          await trigger.press('Enter');
          const runtimePanel = page.locator('.session-model-controls .acp-runtime-controls');
          await runtimePanel.getByRole('alert').getByText('Fixture agent unavailable').waitFor();
          await runtimePanel.getByRole('button', { name: 'Refresh', exact: true }).click();
          const acpModel = page.getByRole('combobox', { name: 'ACP Model', exact: true });
          await acpModel.waitFor();
          const acpBox = await acpModel.boundingBox();
          assert.ok(acpBox && before && acpBox.y >= 0 && acpBox.y + acpBox.height < before.y);
          assert.deepEqual(await composer.boundingBox(), before, 'ACP options do not resize input');
          const value = 'review-model-with-a-long-qualified-name';
          await acpModel.selectOption(value);
          await trigger.getByText(value, { exact: false }).waitFor();
          await page.screenshot({ path: join(artifacts, `${mode}-${width}-${height}-acp.png`) });
          await trigger.press('Enter');
          await acpModel.waitFor({ state: 'hidden' });
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
        const expandInspector = page.getByRole('button', {
          name: 'Expand session panel',
          exact: true,
        });
        const collapseInspector = page.getByRole('button', {
          name: 'Collapse session panel',
          exact: true,
        });
        if (width <= 800) {
          await expandInspector.waitFor();
          const transcript = page.locator('.native-chat-messages');
          const initial = await transcript.boundingBox();
          await expandInspector.press('Enter');
          await collapseInspector.waitFor();
          assert.deepEqual(
            await transcript.boundingBox(),
            initial,
            'Inspector opens without moving the conversation',
          );
          await page.keyboard.press('Escape');
          await expandInspector.waitFor();
          assert.ok(
            await expandInspector.evaluate((element) => element === document.activeElement),
          );
          await assertActionInView(
            page.locator('.composer-send'),
            'Send message after closing inspector',
          );
        } else await collapseInspector.click();
        assert.equal(
          await page.locator('.session-inspector').getAttribute('data-collapsed'),
          'true',
        );
        await expandInspector.click();
        if (width === 1440) {
          const inspector = page.locator('.session-inspector');
          const original = (await inspector.boundingBox()).width;
          await page.setViewportSize({ width: 800, height: 600 });
          await expandInspector.waitFor();
          await page.setViewportSize({ width, height });
          await collapseInspector.waitFor();
          assert.equal(
            (await inspector.boundingBox()).width,
            original,
            'Compact layout leaves saved inspector width intact',
          );
        }
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
        if (width < 620 && !(await page.locator('.explorer').isVisible()))
          await page.getByRole('button', { name: 'Projects and sessions', exact: true }).click();
        const project = page.locator('.project-item').filter({ hasText: 'WrongStack UI' });
        await project.click();
        const overview = page.locator('.project-overview');
        await overview.getByRole('heading', { name: 'WrongStack UI', exact: true }).waitFor();
        await overview.getByText('D:/fixture/ui', { exact: true }).waitFor();
        assert.equal(await project.getAttribute('aria-current'), 'location');
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await page.screenshot({ path: join(artifacts, `${mode}-${width}-${height}-project.png`) });
        await overview
          .locator('.project-session-rows')
          .getByRole('button', { name: /Review the session workspace/ })
          .click();
        await page.getByRole('textbox', { name: 'Message WrongStack', exact: true }).waitFor();
        assert.deepEqual(errors, []);
        assert.deepEqual(await page.evaluate(() => window.uiUnexpected), []);
        console.log(
          `PASS: real App ${mode} ${width}x${height}; fleet, session, no overflow or runtime errors`,
        );
        await context.close();
      }
    }
    // Standalone terminal dock flow in a fresh ?terminal context: the query adds exactly
    // one terminal session ('st0'), so every context above keeps its four fleet cards.
    // Docking must move the live xterm between tab and panel: the same DOM node, one
    // terminal_stream, no terminal_stop and no session.kill anywhere in the flow.
    {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: 'reduce',
      });
      page = await context.newPage();
      page.setDefaultTimeout(20000);
      const errors = [];
      pageErrors = errors;
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto(`${url}?terminal`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.locator('.session-card').first().waitFor();
      assert.equal(
        await page.locator('.session-card').count(),
        5,
        '?terminal adds exactly one terminal session',
      );
      await page
        .locator('.session-card')
        .filter({ hasText: 'Review the session workspace' })
        .locator('.session-card-main')
        .click();
      const composer = page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
      await composer.waitFor();
      await page
        .locator('.sidebar')
        .getByRole('button', { name: /Fixture terminal/ })
        .first()
        .click();
      const dockButton = page.getByRole('button', { name: 'Dock terminal', exact: true });
      await dockButton.waitFor();
      await page.locator('.xterm').waitFor();
      await page.waitForFunction(() =>
        window.uiCalls.some((call) => call.method === 'session.resize'),
      );
      const tag = 'dock-flow-probe';
      // One live xterm with the probe tag and the accumulated output, one stream that was
      // never stopped, and no kill: the invariants every placement change must preserve.
      const expectTerminalIntact = async (state, needle) => {
        await page.waitForFunction(
          ([probe, text]) => {
            const pane = document.querySelector('.xterm');
            return (
              document.querySelectorAll('.xterm').length === 1 &&
              pane?.dataset.probe === probe &&
              (document.querySelector('.xterm-rows')?.textContent ?? '').includes(text)
            );
          },
          [tag, needle],
        );
        assert.deepEqual(
          await page.evaluate(() => window.terminalStreams.map((stream) => stream.id)),
          ['st0'],
          `${state}: exactly one terminal stream`,
        );
        assert.equal(
          await page.evaluate(() => window.terminalStops.length),
          0,
          `${state}: stream never stopped`,
        );
        assert.equal(
          await page.evaluate(() => window.uiCalls.some((call) => call.method === 'session.kill')),
          false,
          `${state}: terminal never killed`,
        );
      };
      // Representative ANSI output travels the real subscription channel into xterm.
      await page.evaluate((probe) => {
        document.querySelector('.xterm').dataset.probe = probe;
        window.terminalStreams[0].channel.onmessage(
          new TextEncoder().encode('\x1b[32mfixture-ok\x1b[0m \x1b[36mready\x1b[0m $ ').buffer,
        );
      }, tag);
      await page.waitForFunction(() => window.terminalAcks.length >= 1);
      await expectTerminalIntact('terminal tab', 'fixture-ok');
      // Dock: the panel joins the focused chat without remounting the terminal.
      await dockButton.press('Enter');
      const panel = page.getByRole('region', { name: 'Terminal panel' });
      const hideToggle = panel.getByRole('button', { name: 'Hide terminal panel', exact: true });
      await panel.waitFor();
      assert.equal(
        await hideToggle.evaluate((button) => button === document.activeElement),
        true,
        'Docking moves focus to the panel toggle',
      );
      await composer.waitFor();
      assert.ok(await panel.locator('.xterm').isVisible(), 'docked panel hosts the live xterm');
      await expectTerminalIntact('docked', 'fixture-ok');
      // The stream survives the dock: output written while docked still arrives.
      await page.evaluate(() => {
        window.terminalStreams[0].channel.onmessage(
          new TextEncoder().encode('\r\n\x1b[91mdocked-ok\x1b[0m').buffer,
        );
      });
      await page.waitForFunction(() => window.terminalAcks.length >= 2);
      await expectTerminalIntact('docked stream', 'docked-ok');
      await assertSquareCorners(page, 'Terminal dock');
      await page.screenshot({ path: join(artifacts, 'terminal-dock.png') });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        'Docked terminal has no page overflow',
      );
      // Hide keeps the terminal mounted but out of view; Show restores it unchanged.
      await panel.getByRole('button', { name: 'Hide terminal panel', exact: true }).click();
      const showToggle = panel.getByRole('button', { name: 'Show terminal panel', exact: true });
      await showToggle.waitFor();
      assert.equal(await showToggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('.xterm').isVisible(), false, 'hidden panel hides xterm');
      await expectTerminalIntact('hidden', 'docked-ok');
      await showToggle.click();
      await panel.getByRole('button', { name: 'Hide terminal panel', exact: true }).waitFor();
      assert.ok(await page.locator('.xterm').isVisible(), 'shown panel reveals xterm again');
      await expectTerminalIntact('reshown', 'docked-ok');
      // Back to a tab: same node and stream, panel gone, dock action available again.
      await panel.getByRole('button', { name: 'Move terminal to tab', exact: true }).press('Enter');
      await panel.waitFor({ state: 'detached' });
      await expectTerminalIntact('tab again', 'docked-ok');
      await dockButton.waitFor();
      assert.equal(
        await dockButton.evaluate((button) => button === document.activeElement),
        true,
        'Returning to the tab restores focus to Dock terminal',
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        'Undocked terminal has no page overflow',
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(await page.evaluate(() => window.uiUnexpected), []);
      console.log(
        'PASS: terminal dock flow; dock, hide, show, tab round trip, single stream, no kill',
      );
      await context.close();
    }
  }
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(error);
    if (pageErrors.length) console.error(pageErrors);
    try {
      await page.screenshot({ path: join(artifacts, 'failure.png'), timeout: 4000 });
      console.error(
        await page.evaluate(() => ({
          unexpected: window.uiUnexpected,
          text: document.body.textContent.slice(0, 1800),
        })),
      );
    } catch (captureError) {
      console.error('Could not capture failure screenshot', captureError);
    }
  }
  throw error;
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
