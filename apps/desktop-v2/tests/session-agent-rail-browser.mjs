import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from '@playwright/test';
import { createServer, transformWithOxc } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(root, '../../.temp_files/session-inspector-browser');
const source = `
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {EngineWorkspace} from '/src/EngineWorkspace.tsx';
import {emptyEngineState,reduceEngine} from '/src/engine-state.ts';
import '/src/styles.css'; import '/src/chat.css'; import '/src/workspace.css';
import '/src/brand-tokens.css'; import '/src/appearance.css'; import '/src/workbench.css';
import '/src/project.css'; import '/src/controls.css'; import '/src/composer.css';
import '/src/shell.css'; import '/src/transcript-message.css';
const text='Fixture: keep the leader visible while reviewing delegated work.';
let state={...emptyEngineState,sessionId:'proof-session',connected:true,synced:true,hydrating:false,provider:'fixture',model:'fixture-model',messages:[{id:'leader-message',role:'assistant',text}],results:{'prefs.updated':{autonomy:'off'}}};
for(let i=0;i<24;i++){
 const name=i===0?'Ada — source audit':i===1?'Bob — tests':i===2?'Unicode 検証 '+ 'long-name-'.repeat(12):'Worker '+i;
 state=reduceEngine(state,{type:'agent.timeline.message',payload:{sessionId:'proof-session',subagentId:'worker-'+i,agentName:name,kind:'text',content:i===0?'Audit result: **verified**.\\n\\n'+('Long transcript line.\\n\\n'.repeat(30))+'\\n\\n~~~ts\\n'+('long_code_'.repeat(120))+'\\n~~~':'Worker result '+i,iteration:1,ts:'2026-11-17'}});
 state=reduceEngine(state,{type:'agent.status_changed',payload:{sessionId:'proof-session',subagentId:'worker-'+i,agentName:name,status:i===1?'failed':i%2?'running':'completed',task:'Fixture task: inspect the session boundary '+i}});
}
state=reduceEngine(state,{type:'agent.timeline.message',payload:{sessionId:'foreign-session',subagentId:'foreign',agentName:'Foreign worker',kind:'text',content:'Must never appear',iteration:1}});
const bootEvents=[{type:'session.start',payload:{sessionId:'proof-session',provider:'fixture',model:'fixture-model',reset:true,replayMessages:state.messages.map(message=>({role:message.role,content:message.text})),agentSessions:Object.values(state.agents).map(agent=>({subagentId:agent.id,agentName:agent.name,status:agent.status,task:agent.task,transcript:agent.entries}))}},{type:'prefs.updated',payload:{autonomy:'off',enhanceEnabled:false}}];
window.proofState=state; window.proofCalls=[]; window.proofErrors=[]; window.proofEvents=[]; window.proofOffset=1;
window.proofInvoke=async (command,args)=>{
 if(command==='speech_status')return {available:false,reason:'Fixture'};
 if(command!=='host_request')throw Error('Unexpected native command '+command);
 const {method,params}=args;
 window.proofCalls.push({method,params});
 if(method==='engine.events'){
  const events=params.offset===0?bootEvents:window.proofEvents.splice(0);
  if(events.length)window.proofOffset++;
  return {offset:window.proofOffset,events,hasMore:false};
 }
 if(method==='form-draft.get'||method==='draft.object')return {revision:0,value:null};
 if(method==='form-draft.save'||method==='draft.save')return {revision:1};
 if(method==='engine.http')return {status:200,body:{}};
 if(method==='engine.send'){
  if(params.message.type==='todos.get')window.proofEvents.push({type:'todos.updated',payload:{requestId:params.message.payload.requestId,todos:[]}});
  return null;
 }
 throw Error('Unexpected host request '+method);
};
function Fixture(){
 const [draft,setDraft]=useState('');
 return <div className="focused-session" style={{height:'100dvh',display:'flex',flexDirection:'column'}}>
 <EngineWorkspace id="proof" sessionTitle="Session rail fixture" projectId="fixture-project" projectRoot="D:/fixture" scopeKey="fixture" draft={draft} mode="btw" onModeChange={()=>{}} draftConflict={false} validateDraft={async()=>true} onDraftChange={async value=>{setDraft(value);return true;}} references={[]} attachments={[]} onAttachmentsChange={async()=>true} onReferencesChange={async()=>true} inputDrafts={{}} onInputDraftChange={()=>{}} onSettings={()=>{}} onOpen={()=>{}} onError={error=>window.proofErrors.push(String(error))}/>
 </div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
const server = await createServer({
  root,
  configFile: join(root, 'vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
    watch: { ignored: ['**/src-tauri/**', '**/dist*/**'] },
  },
  plugins: [
    {
      name: 'session-agent-rail-proof',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'virtual:session-agent-proof') return '\0session-agent-proof.tsx';
        if (id === '@tauri-apps/api/core') return '\0session-agent-native.ts';
      },
      async load(id) {
        if (id === '\0session-agent-native.ts')
          return 'export const isTauri=()=>true; export const invoke=(...args)=>window.proofInvoke(...args); export class Channel {}';
        if (id === '\0session-agent-proof.tsx')
          return (await transformWithOxc(source, 'fixture.tsx', { jsx: { runtime: 'automatic' } }))
            .code;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url?.split('?')[0] !== '/__session-agents') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><title>Session agents fixture</title></head><body><div id="root"></div><script type="module" src="/@id/virtual:session-agent-proof"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
let browser;
let activePage;
try {
  await mkdir(artifacts, { recursive: true });
  await server.listen();
  const url = server.resolvedUrls.local[0] + '__session-agents';
  if (process.argv.includes('--serve')) {
    console.log(`Session agent fixture: ${url}`);
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
        const page = await context.newPage();
        activePage = page;
        page.setDefaultTimeout(20000);
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.goto(url);
        await page.evaluate((mode) => {
          document.documentElement.dataset.mode = mode;
          document.documentElement.classList.toggle('dark', mode === 'dark');
        }, mode);
        const leader = page.locator('.native-chat-messages');
        await leader
          .getByText('Fixture: keep the leader visible while reviewing delegated work.', {
            exact: true,
          })
          .waitFor();
        const compact = width <= 760;
        const agents = page.getByRole('tab', { name: 'Agents', exact: true });
        const inspector = page.locator('.session-inspector');
        if (compact) {
          await inspector.waitFor({ state: 'hidden' });
          await agents.press('Enter');
        }
        await page.locator('.session-agent-rail').waitFor();
        assert.equal(await page.locator('.agent-tabs button').count(), 25);
        assert.equal(await page.getByText('Foreign worker').count(), 0);
        await leader.evaluate((element) => {
          element.dataset.proofKept = 'yes';
        });
        const ada = page.locator('.agent-tabs button').filter({ hasText: 'Ada — source audit' });
        await ada.click();
        await page.getByRole('region', { name: 'Ada — source audit transcript' }).waitFor();
        assert.equal(await leader.isVisible(), true);
        assert.equal(await leader.getAttribute('data-proof-kept'), 'yes');
        assert.equal(
          await page
            .locator('.agent-transcript')
            .getByText('verified', { exact: true })
            .isVisible(),
          true,
        );
        const contrast = await new AxeBuilder({ page })
          .include('.session-inspector')
          .withRules(['color-contrast'])
          .analyze();
        assert.deepEqual(contrast.violations, [], `Rail contrast at ${mode} ${width}x${height}`);
        await page.screenshot({ path: join(artifacts, `${mode}-${width}-${height}-agent.png`) });
        const geometry = await page.evaluate(() => {
          const rail = document.querySelector('.session-inspector').getBoundingClientRect();
          const chat = document.querySelector('.native-chat-messages').getBoundingClientRect();
          const composer = document.querySelector('.composer-host').getBoundingClientRect();
          const icons = document.querySelector('.session-inspector-rail').getBoundingClientRect();
          const panes = document
            .querySelector('.session-conversation-panes')
            .getBoundingClientRect();
          return {
            rail: { x: rail.x, y: rail.y, bottom: rail.bottom, width: rail.width },
            composer: { y: composer.y, right: composer.right, bottom: composer.bottom },
            chat: {
              x: chat.x,
              y: chat.y,
              right: chat.right,
              height: chat.height,
              width: chat.width,
            },
            icons: { x: icons.x, right: icons.right, width: icons.width, height: icons.height },
            panes: { x: panes.x, right: panes.right, bottom: panes.bottom },
            title: document.querySelector('.session-inspector-heading h2')?.textContent ?? '',
            strips: document.querySelectorAll('.session-inspector-tabs').length,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        assert.equal(geometry.overflow, false, `No page overflow at ${width} ${mode}`);
        assert.ok(geometry.chat.height >= 90, `Leader remains readable at ${width}x${height}`);
        assert.ok(geometry.title.length > 0, 'Sidebar shows a title');
        assert.equal(geometry.strips, 0, 'No horizontal tab strip across the sidebar top');
        assert.ok(
          geometry.icons.right >= geometry.panes.right - 1,
          `Icon menu sits at the far right edge: ${JSON.stringify(geometry.icons)}`,
        );
        assert.ok(geometry.icons.width >= 32, 'Icon menu keeps a usable target width');
        if (!compact) assert.ok(geometry.rail.x >= geometry.chat.right - 1, 'Rail is on the right');
        if (!compact) {
          assert.ok(
            geometry.composer.right <= geometry.rail.x + 1,
            'Composer ends before inspector',
          );
          assert.ok(
            Math.abs(geometry.composer.bottom - geometry.rail.bottom) < 2,
            'Inspector spans composer height',
          );
        } else {
          assert.ok(
            geometry.rail.x >= geometry.chat.x && geometry.rail.bottom <= geometry.panes.bottom,
            'Compact inspector overlays the right edge within the workbench',
          );
        }
        await page.getByRole('tab', { name: 'Agents', exact: true }).focus();
        await page.keyboard.press('ArrowRight');
        await page
          .getByText('No plan yet. Todos created during this session will appear here.', {
            exact: true,
          })
          .waitFor();
        await page.evaluate(() =>
          window.proofEvents.push({
            type: 'todos.updated',
            payload: {
              todos: [
                {
                  id: 'proof-todo',
                  content: 'Live plan: verify the separated composer 検証',
                  status: 'in_progress',
                },
              ],
            },
          }),
        );
        await page
          .getByText('Live plan: verify the separated composer 検証', { exact: true })
          .waitFor();
        const planContrast = await new AxeBuilder({ page })
          .include('.session-inspector')
          .withRules(['color-contrast'])
          .analyze();
        assert.deepEqual(planContrast.violations, [], 'Plan contrast');
        await page.screenshot({ path: join(artifacts, `${mode}-${width}-${height}-plan.png`) });
        await page.getByRole('tab', { name: 'Details', exact: true }).click();
        await page
          .locator('.session-inspector-details')
          .getByText('fixture-model', { exact: true })
          .waitFor();
        await page.getByRole('button', { name: 'Collapse session panel', exact: true }).click();
        assert.equal(
          await page.getByRole('tab').count(),
          3,
          'Icon rail stays visible while the sidebar is collapsed',
        );
        assert.equal(await page.locator('.session-inspector-rail').isVisible(), true);
        const expandedChat = await leader.boundingBox();
        if (compact) {
          assert.equal(
            expandedChat.width,
            geometry.chat.width,
            'Compact overlay leaves chat width intact',
          );
          assert.equal(
            expandedChat.height,
            geometry.chat.height,
            'Compact overlay leaves chat height intact',
          );
        } else
          assert.ok(
            expandedChat.width > geometry.chat.width + 200,
            'Collapse releases space to chat',
          );
        await page.getByRole('tab', { name: 'Plan', exact: true }).click();
        assert.equal(
          await page.locator('.session-inspector').getAttribute('data-collapsed'),
          'false',
          'Clicking a rail icon opens the sidebar',
        );
        assert.equal(
          await page.getByRole('tab', { name: 'Plan', exact: true }).getAttribute('aria-selected'),
          'true',
        );
        await page.getByRole('tab', { name: 'Details', exact: true }).click();
        await page.getByRole('button', { name: 'Collapse session panel', exact: true }).click();
        await page.getByRole('button', { name: 'Expand session panel', exact: true }).focus();
        await page.keyboard.press('Enter');
        assert.equal(
          await page
            .getByRole('tab', { name: 'Details', exact: true })
            .getAttribute('aria-selected'),
          'true',
        );
        await page.getByRole('tab', { name: 'Agents', exact: true }).click();
        assert.equal(
          await page
            .locator('.agent-tabs button')
            .filter({ hasText: 'Ada — source audit' })
            .getAttribute('aria-pressed'),
          'true',
        );
        assert.equal(await leader.getAttribute('data-proof-kept'), 'yes');
        if (compact) {
          await page.keyboard.press('Escape');
          await inspector.waitFor({ state: 'hidden' });
          assert.ok(await agents.evaluate((element) => element === document.activeElement));
        }
        const composer = page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
        await composer.fill('Explicit leader message from fixture');
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        const sends = await page.evaluate(() =>
          window.proofCalls.filter(
            (call) => call.method === 'engine.send' && call.params.message.type === 'user_message',
          ),
        );
        assert.equal(sends.length, 1);
        assert.equal(sends[0].params.id, 'proof');
        if (compact) await agents.click();
        await page.locator('.agent-tabs button').first().focus();
        await page.keyboard.press('End');
        assert.equal(
          await page
            .locator('.agent-tabs button')
            .last()
            .evaluate((button) => button === document.activeElement),
          true,
        );
        await page.keyboard.press('Enter');
        await page.getByRole('region', { name: 'Worker 23 transcript' }).waitFor();
        await page.screenshot({ path: join(artifacts, `${mode}-${width}-${height}.png`) });
        const clearInactive = page.getByRole('button', {
          name: 'Clear inactive (13)',
          exact: true,
        });
        await clearInactive.click();
        assert.equal(await page.locator('.agent-tabs button').count(), 12);
        assert.equal(
          await page.getByRole('region', { name: 'Worker 23 transcript' }).isVisible(),
          true,
          'Selected active worker stays open',
        );
        assert.equal(await leader.isVisible(), true);
        assert.equal(await page.locator('.session-agent-count').textContent(), '12');
        await page.reload();
        if (compact) await agents.click();
        await page.getByRole('button', { name: 'Undo cleanup (13)', exact: true }).waitFor();
        assert.equal(
          await page.locator('.agent-tabs button').count(),
          12,
          'Cleanup persists through a real reload',
        );
        await page.getByRole('button', { name: 'Undo cleanup (13)', exact: true }).click();
        assert.equal(await page.locator('.agent-tabs button').count(), 25);
        await ada.click();
        await clearInactive.click();
        assert.equal(
          await page.locator('.agent-transcript').count(),
          0,
          'Clearing the selected inactive worker closes its inspector',
        );
        assert.equal(await page.locator('.agent-tabs button').count(), 12);
        await page.getByRole('button', { name: 'Undo cleanup (13)', exact: true }).click();
        await page.screenshot({ path: join(artifacts, `${mode}-${width}-${height}-cleanup.png`) });
        assert.deepEqual(errors, []);
        assert.deepEqual(await page.evaluate(() => window.proofErrors), []);
        console.log(
          `PASS: ${mode} ${width}x${height}; simultaneous transcripts, leader input, keyboard, all agents, overflow`,
        );
        await context.close();
      }
    }
  }
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    console.error(error);
    try {
      await activePage.screenshot({ path: join(artifacts, 'failure.png'), timeout: 4000 });
      console.error(
        await activePage.evaluate(() => ({
          text: document.querySelector('.session-leader-column')?.textContent?.slice(0, 1000),
          errors: window.proofErrors,
          chat: document.querySelector('.native-chat-messages')?.getBoundingClientRect().toJSON(),
          calls: window.proofCalls.filter((call) => call.method !== 'engine.events').slice(-8),
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
}
