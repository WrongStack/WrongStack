import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { Context } from '@wrongstack/core/agent';
import { createServer, transformWithOxc } from 'vite';
import { createAgentLoopInjectors } from '../../../packages/core/src/core/agent-loop-injectors.ts';
import { handleUserBtw } from '../../../packages/webui-server/src/server/user-btw-handler.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(root, '../../.temp_files/btw-pending-browser');
const context = new Context({
  systemPrompt: [],
  provider: null,
  model: 'fixture',
  cwd: root,
  projectRoot: root,
  session: {
    id: 'btw-fixture',
    pendingToolUses: [],
    append: async () => {},
    flush: async () => {},
  },
  signal: new AbortController().signal,
  tokenCounter: { account() {} },
});
const injectors = createAgentLoopInjectors({
  ctx: context,
  events: {},
  logger: {},
  autoExtendLimit: false,
  maxAutoExtensions: 0,
});
const source = `
import {createRoot} from 'react-dom/client';
import {useEffect,useRef,useState} from 'react';
import {BtwReceipts} from '/src/BtwReceipts.tsx';
import {ComposerQueue} from '/src/ComposerQueue.tsx';
import {btwReceipts} from '/src/btw-receipts.ts';
import {dispatchComposer} from '/src/composer-model.ts';
import {emptyEngineState,reduceEngine} from '/src/engine-state.ts';
import '/src/styles.css'; import '/src/chat.css'; import '/src/brand-tokens.css';
import '/src/appearance.css'; import '/src/controls.css'; import '/src/composer.css';
let state={...emptyEngineState,sessionId:'btw-fixture',connected:true,hydrating:false,needsSetup:false,running:true,results:{'session.start':{protocolCapabilities:['session.user-btw']}}};
const command=async(type,payload={})=>{
 const response=await fetch('/__btw-api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,payload})});
 const result=await response.json(); if(result.success===false)throw Error(result.error); return result;
};
function Fixture(){
 const panel=useRef(null),[queue,setQueue]=useState([{id:'q1',text:'Verify the error path',addedAt:1,imageCount:0}]),[error,setError]=useState('');
 const send=async()=>{
  try{await dispatchComposer('Preserve public API compatibility — 検証','btw',{current:()=>state,command,send:async()=>{throw Error('Unexpected turn or abort');},waitForIdle:async()=>{throw Error('Unexpected wait');},onBtwSaved:(messageId,text)=>void btwReceipts.record('btw-fixture',{messageId,text,sentAt:Date.now()})});}
  catch(error){setError(String(error));}
 };
 useEffect(()=>{void send();},[]);
 const consume=async()=>{
  const response=await command('fixture.consume');
  window.consumedInstruction=response.instruction;
  state=reduceEngine({...state,queue},{type:'queue.drained',payload:{sessionId:'btw-fixture',item:queue[0]}});
  setQueue(state.queue);
 };
 return <main style={{padding:24,maxWidth:860,margin:'auto'}}>
 <h1>Session instructions</h1><p>Leader transcript stays here. Pending instructions clear when picked up.</p>
 <div style={{display:'flex',gap:12,flexWrap:'wrap',marginBottom:24}}>
 <button className="button secondary" onClick={send}>Send BTW instruction</button>
 <button className="button secondary" onClick={consume}>Process pending instructions</button></div>
 {error&&<p role="alert">{error}</p>}
 <div className="native-composer-stack"><ComposerQueue queue={queue} panel={panel} busy={false} connected={true} sending={false} onAction={()=>{}} onCopy={()=>{}}/>
 <BtwReceipts sessionId="btw-fixture" command={command} mailboxEvent={null}/></div>
 </main>;
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
      name: 'btw-pending-regression',
      resolveId(id) {
        if (id === 'virtual:btw-pending') return '\0btw-pending.tsx';
      },
      async load(id) {
        if (id === '\0btw-pending.tsx')
          return (await transformWithOxc(source, 'fixture.tsx', { jsx: { runtime: 'automatic' } }))
            .code;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url === '/__btw-api' && req.method === 'POST') {
            const buffers = [];
            for await (const chunk of req) buffers.push(chunk);
            const message = JSON.parse(Buffer.concat(buffers).toString('utf8'));
            res.setHeader('Content-Type', 'application/json');
            if (message.type === 'fixture.consume') {
              injectors.injectPendingBtwNotes();
              res.end(
                JSON.stringify({ success: true, instruction: JSON.stringify(context.messages) }),
              );
            } else
              handleUserBtw(message, {
                sessionId: 'btw-fixture',
                context,
                running: true,
                reply: (frame) => res.end(JSON.stringify(frame.payload)),
              });
            return;
          }
          if (req.url !== '/__btw-pending') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><title>BTW pending regression</title></head><body><div id="root"></div><script type="module" src="/@id/virtual:btw-pending"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
let browser;
try {
  await mkdir(artifacts, { recursive: true });
  await server.listen();
  const url = server.resolvedUrls.local[0] + '__btw-pending';
  if (process.argv.includes('--serve')) {
    console.log(`BTW fixture: ${url}`);
    await writeFile(join(artifacts, 'url.txt'), url);
    await new Promise((done) => {
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
  } else {
    browser = await chromium.launch({ headless: true });
    for (const mode of ['light', 'dark'])
      for (const [width, height] of [
        [1440, 900],
        [390, 700],
        [900, 480],
      ]) {
        const page = await browser.newPage({
          viewport: { width, height },
          reducedMotion: 'reduce',
        });
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.goto(url);
        await page.evaluate((mode) => {
          document.documentElement.dataset.mode = mode;
        }, mode);
        await page.getByRole('button', { name: 'Send BTW instruction', exact: true }).waitFor();
        await expect(page.locator('.btw-receipts')).toBeVisible();
        await page.locator('.btw-receipts summary').click();
        await expect(page.locator('.btw-receipts')).toContainText(
          'Preserve public API compatibility',
        );
        await page.screenshot({ path: join(artifacts, `${mode}-${width}-pending.png`) });
        await page
          .getByRole('button', { name: 'Process pending instructions', exact: true })
          .click();
        await expect(page.locator('.btw-receipts')).toHaveCount(0);
        await expect(page.locator('.composer-queue')).toHaveCount(0);
        const instruction = await page.evaluate(() => window.consumedInstruction);
        assert.ok(instruction.includes('the user added this'));
        assert.ok(instruction.includes('Preserve public API compatibility'));
        assert.equal(instruction.includes('FYI only'), false);
        assert.equal(instruction.includes('no reply needed'), false);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        assert.deepEqual(errors, []);
        await page.screenshot({ path: join(artifacts, `${mode}-${width}-consumed.png`) });
        await page.close();
      }
    console.log(
      'PASS: direct user instructions and cleared BTW/queue display; 6 light/dark viewport cases.',
    );
  }
} finally {
  await browser?.close();
  await server.close();
}
