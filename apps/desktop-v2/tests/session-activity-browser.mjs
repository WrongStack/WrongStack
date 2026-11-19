import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createServer, transformWithOxc } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(root, '../../.temp_files/session-activity-browser');
const source = `
import {createRoot} from 'react-dom/client';
import {useEffect,useRef,useState} from 'react';
import {TranscriptVirtualizer} from '/src/TranscriptVirtualizer.tsx';
import {TranscriptMessage} from '/src/TranscriptMessage.tsx';
import {AgentWorking} from '/src/TurnTools.tsx';
import {SessionInspector} from '/src/SessionInspector.tsx';
import {emptyEngineState,reduceEngine} from '/src/engine-state.ts';
import '/src/styles.css'; import '/src/chat.css'; import '/src/workspace.css';
import '/src/brand-tokens.css'; import '/src/appearance.css'; import '/src/workbench.css';
import '/src/composer.css'; import '/src/shell.css'; import '/src/density.css';
const fixtureAt=Date.parse('2026-11-18T10:11:12Z');
const initial=[
 {type:'iteration.started',payload:{index:0}},
 {type:'provider.thinking_delta',payload:{text:'Thinking fixture: inspect the existing implementation.'}},
 {type:'tool.started',payload:{id:'read',name:'read',input:{path:'src/検証.ts'}}},
 {type:'tool.executed',payload:{id:'read',name:'read',ok:true,output:'Verified source line.\\n'.repeat(60)}},
 {type:'iteration.completed',payload:{index:0}},
 {type:'iteration.started',payload:{index:1}},
 {type:'tool.started',payload:{id:'edit',name:'edit',input:{path:'src/'+ 'long-path-'.repeat(24)+'.ts'}}},
];
for(let i=0;i<initial.length;i++)initial[i]={...initial[i],at:fixtureAt+i*1000};
let base={...emptyEngineState,sessionId:'fixture-session',synced:true,connected:true,hydrating:false};
for(const [kind,content] of [['thinking','Worker thinking fixture'],['text','Worker result fixture']])
 base=reduceEngine(base,{type:'agent.timeline.message',payload:{sessionId:'fixture-session',subagentId:'worker',agentName:'Review worker',kind,content,iteration:1,ts:new Date(fixtureAt).toISOString()}});
function Fixture(){
 const pane=useRef(null), following=useRef(false);
 const [events,setEvents]=useState(initial),[live,setLive]=useState(true),[thinking,setThinking]=useState(true),[empty,setEmpty]=useState(false);
 useEffect(()=>{const params=new URLSearchParams(location.search);if(params.has('details'))document.querySelectorAll('[role="tab"]')[2]?.click();if(params.has('dark'))document.documentElement.dataset.mode='dark';},[]);
 const state={...events.reduce(reduceEngine,base),running:live};
 const messages=empty?[]:[{id:'prompt',role:'user',at:fixtureAt-1000,text:'Fixture: center the conversation and group calls by iteration.'},{id:'answer',role:'assistant',at:fixtureAt,text:'I will inspect the source, then update the activity view.',activityAfter:events}];
 const display={showThinkingLogs:thinking,groupToolCalls:true,autoCollapseInput:false,keyboardShortcuts:true};
 return <main className="focused-session" style={{height:'100dvh',display:'flex',flexDirection:'column'}}>
 <nav aria-label="Fixture controls" style={{display:'flex',flexWrap:'wrap',gap:8,padding:8}}>
 <button onClick={()=>setEvents(current=>[...current,{type:'tool.progress',payload:{id:'edit',event:{text:'Applying changes'}}}])}>Advance fixture</button>
 <button onClick={()=>{setEvents(current=>[...current,{type:'tool.executed',payload:{id:'edit',name:'edit',ok:false,output:'Fixture failure: changes refused'}},{type:'run.result',payload:{status:'failed',error:{message:'Fixture run failed'}}}]);setLive(false)}}>Finish fixture</button>
 <button onClick={()=>setThinking(value=>!value)}>Toggle thinking</button>
 <button onClick={()=>setEmpty(value=>!value)}>Toggle empty</button>
 </nav>
 <div className="session-conversation-layout"><div className="session-conversation-panes">
 <div className="session-leader-column">
 <div ref={pane} className="native-chat-messages" aria-label="Session conversation">
 <TranscriptVirtualizer scrollRef={pane} following={following} messages={messages}
 header={empty?<p className="quiet-state">No conversation yet.</p>:null}
 footer={live&&!empty?<AgentWorking waiting={false} since={null} timeline={events} showThinking={thinking}/>:null}
 renderMessage={message=><TranscriptMessage message={message} state={state} display={display} activityLive={live} onLink={()=>{}} onOpenFile={()=>{}}/>}/>
 </div>
 <div className="native-composer-stack"><div className="native-composer"><label>Fixture composer<textarea aria-label="Fixture composer" placeholder="Message the leader"/></label></div></div>
 </div>
 <SessionInspector state={state} command={async()=>({todos:[]})} onLink={()=>{}} showThinkingLogs={thinking}/>
 </div></div></main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
const id = '\0session-activity-fixture.tsx';
const server = await createServer({
  root,
  configFile: join(root, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/src-tauri/**', '**/dist*/**'] } },
  plugins: [
    {
      name: 'session-activity-fixture',
      resolveId(value) {
        if (value === 'virtual:session-activity-fixture') return id;
      },
      async load(value) {
        if (value === id)
          return (await transformWithOxc(source, 'fixture.tsx', { jsx: { runtime: 'automatic' } }))
            .code;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url?.split('?')[0] !== '/__session-activity') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><title>Session activity regression fixture</title></head><body><div id="root"></div><script type="module" src="/@id/virtual:session-activity-fixture"></script></body></html>',
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
  const url = `${server.resolvedUrls.local[0]}__session-activity`;
  console.log(`Activity fixture: ${url}`);
  if (process.argv.includes('--serve')) {
    await new Promise((done) => {
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
  } else {
    await mkdir(artifacts, { recursive: true });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const theme of ['light', 'dark']) {
      for (const density of ['comfortable', 'compact']) {
        for (const [width, height] of [
          [1440, 900],
          [390, 800],
          [1024, 480],
        ]) {
          await page.setViewportSize({ width, height });
          await page.goto(url);
          await page.evaluate(
            ({ theme, density }) => {
              document.documentElement.dataset.mode = theme;
              document.documentElement.classList.toggle('dark', theme === 'dark');
              document.documentElement.dataset.density = density;
            },
            { theme, density },
          );
          const panel = page.locator('.chat-run-activity');
          await expect(panel).toHaveAttribute('open', '');
          // The conversation lists the calls as one flat set of steps; iteration groups and
          // per-call clock times belong to the full run log, not the chat.
          await expect(page.locator('.activity-iteration')).toHaveCount(0);
          await expect(page.locator('.chat-message > header time')).toHaveCount(2);
          await expect(page.locator('.chat-step.activity-kind-tool')).toHaveCount(2);
          await expect(page.locator('.chat-step-target')).toHaveCount(2);
          await page.getByRole('tab', { name: 'Details', exact: true }).click();
          await expect(page.locator('.session-tool-total dd')).toHaveText('2');
          await expect(page.locator('.session-tool-summary dl > div')).toHaveCount(3);
          await page.getByRole('tab', { name: 'Agents', exact: true }).click();
          const geometry = await page.evaluate(() => {
            const pane = document.querySelector('.native-chat-messages');
            const rect = pane.getBoundingClientRect();
            return {
              centers: [...pane.querySelectorAll('.transcript-row')].map((row) => {
                const r = row.getBoundingClientRect();
                return Math.abs(
                  (r.left + r.right) / 2 -
                    (rect.left + rect.right - (pane.offsetWidth - pane.clientWidth)) / 2,
                );
              }),
              overlaps: [...pane.querySelectorAll('.activity-kind-tool > summary')].some(
                (summary) => {
                  const hint = summary.querySelector('.chat-step-target')?.getBoundingClientRect();
                  const time = summary
                    .querySelector('.chat-step-time, .chat-step-status')
                    ?.getBoundingClientRect();
                  return (
                    hint &&
                    time &&
                    hint.left < time.right &&
                    hint.right > time.left &&
                    hint.top < time.bottom &&
                    hint.bottom > time.top
                  );
                },
              ),
              overflow:
                pane.scrollWidth > pane.clientWidth + 1 ||
                document.documentElement.scrollWidth > innerWidth,
            };
          });
          assert.ok(
            geometry.centers.every((delta) => delta <= 1),
            JSON.stringify(geometry),
          );
          assert.equal(geometry.overflow, false, 'No horizontal page or transcript overflow');
          assert.equal(geometry.overlaps, false, 'Long tool hints never overlap timestamps');
          await panel.locator(':scope > summary').focus();
          await page.keyboard.press('Enter');
          await expect(panel).not.toHaveAttribute('open');
          await page.getByRole('button', { name: 'Advance fixture' }).click();
          await expect(panel).not.toHaveAttribute('open');
          await panel.locator(':scope > summary').focus();
          await page.keyboard.press('Space');
          await expect(panel).toHaveAttribute('open', '');
          // A step opens to its details from the keyboard and closes again.
          const first = page.locator('.chat-step.activity-kind-tool').first();
          await first.locator(':scope > summary').focus();
          await page.keyboard.press('Enter');
          await expect(first).toHaveAttribute('open', '');
          await expect(first.locator('.activity-entry-body')).toBeVisible();
          await page.keyboard.press('Enter');
          await expect(first).not.toHaveAttribute('open');
          await page.locator('.activity-kind-reasoning > summary').click();
          await expect(
            page.getByText('Thinking fixture: inspect the existing implementation.', {
              exact: true,
            }),
          ).toBeVisible();
          await page.getByRole('button', { name: 'Toggle thinking' }).click();
          await expect(page.locator('.activity-kind-reasoning')).toHaveCount(0);
          await expect(
            page.getByText('Thinking fixture: inspect the existing implementation.', {
              exact: true,
            }),
          ).toHaveCount(0);
          await page.getByRole('button', { name: 'Toggle thinking' }).click();
          await expect(page.locator('.activity-kind-reasoning')).toHaveCount(1);
          await page.getByRole('button', { name: 'Finish fixture' }).click();
          await expect(panel).toHaveAttribute('open', '');
          await expect(page.locator('.activity-kind-tool.activity-failed')).toHaveCount(1);
          await expect(page.locator('.activity-kind-run.activity-failed')).toHaveCount(1);
          await page.getByRole('tab', { name: 'Details', exact: true }).click();
          await expect(page.locator('.session-tool-total dd')).toHaveText('2');
          await page.screenshot({
            path: join(artifacts, `details-${theme}-${density}-${width}x${height}.png`),
          });
          await page.getByRole('tab', { name: 'Agents', exact: true }).click();
          await page.getByRole('button', { name: /Review worker/ }).click();
          await expect(page.locator('.agent-step.thinking')).toHaveCount(1);
          await expect(page.locator('.agent-step.thinking > summary time')).toHaveCount(1);
          await expect(page.locator('.agent-step.text > time')).toHaveCount(1);
          await page.getByRole('button', { name: 'Toggle thinking' }).click();
          await expect(page.locator('.agent-step.thinking')).toHaveCount(0);
          await page.getByRole('button', { name: 'Toggle thinking' }).click();
          await expect(page.locator('.agent-step.thinking')).toHaveCount(1);
          await page.locator('.agent-step.thinking > summary').click();
          await expect(page.getByText('Worker thinking fixture', { exact: true })).toBeVisible();
          await page.screenshot({
            path: join(artifacts, `${theme}-${density}-${width}x${height}.png`),
          });
          await page.getByRole('button', { name: 'Toggle empty' }).click();
          await expect(page.getByText('No conversation yet.')).toBeVisible();
          console.log(
            `PASS ${theme} ${density} ${width}x${height}: centering, keyboard, streaming, grouping, thinking, failure, empty`,
          );
        }
      }
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
