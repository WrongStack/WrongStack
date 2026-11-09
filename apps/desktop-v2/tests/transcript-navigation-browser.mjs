import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer, transformWithOxc } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = 'virtual:navigation-proof',
  resolved = '\0navigation-proof.tsx';
const source = `
import {createRoot} from 'react-dom/client';
import {useRef,useState} from 'react';
import {TranscriptVirtualizer} from '/src/TranscriptVirtualizer.tsx';
import {useTranscriptFollowHandlers} from '/src/transcript-follow.ts';
import '/src/styles.css';
import '/src/transcript-message.css';
function Fixture(){
  const pane=useRef(null), following=useRef(true), list=useRef(null);
  const [lines,setLines]=useState(1),[active,setActive]=useState(true);
  const messages=[{id:'old',role:'assistant',text:'Short control answer'},
    {id:'new',role:'assistant',text:lines===1?'Short second answer':'Recorded long response. '.repeat(2400)},
    ...(lines===1?[]:Array.from({length:22},(_,i)=>({id:'tail-'+i,role:i%2?'assistant':'user',text:'History retained message '+i})))];
  const pause=()=>{following.current=false;setActive(false);};
  const resume=()=>{following.current=true;setActive(true);};
  const handlers=useTranscriptFollowHandlers(following,pause,resume);
  return <><button onClick={()=>setLines(n=>n===1?1000:2000)}>Grow answer</button>
    <button onClick={()=>{pause();list.current.scrollToMessage(0);}}>Find early message</button>
    <div id="pane" data-lines={lines} data-following={String(active)} ref={pane}
      className="native-chat-messages" style={{height:300,width:700,overflow:'auto'}}
      {...handlers}>
      <TranscriptVirtualizer ref={list} following={following} scrollRef={pane} messages={messages}
        header={<span>Conversation</span>} footer={<div id="tail">Long reply complete.</div>}
        renderMessage={m=><article className="chat-message"><p style={{margin:0,lineHeight:'20px'}}>{m.text}</p></article>}/>
    </div></>;
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
      name: 'navigation-proof',
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
          if (req.url !== '/__navigation') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<html><body><div id="root"></div><script type="module" src="/@id/virtual:navigation-proof"></script></body></html>',
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
  await page.goto(server.resolvedUrls.local[0] + '__navigation');
  await page.getByText('Short control answer', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Grow answer', exact: true }).click();
  await page.waitForFunction(() => {
    const pane = document.querySelector('#pane');
    return (
      pane.dataset.lines === '1000' && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 5
    );
  });
  assert.equal(
    await page.locator('#pane').getAttribute('data-following'),
    'true',
    'Layout growth must not impersonate user scrolling',
  );
  await page.getByRole('button', { name: 'Find early message', exact: true }).click();
  await page.waitForFunction(() => {
    const pane = document.querySelector('#pane');
    const row = [...pane.querySelectorAll('p')].find(
      (row) => row.textContent === 'Short control answer',
    );
    if (!row) return false;
    const bounds = row.getBoundingClientRect(),
      view = pane.getBoundingClientRect();
    return bounds.top >= view.top && bounds.bottom <= view.bottom;
  });
  assert.deepEqual(errors, []);
  console.log('PASS: early message navigation before a very tall answer');
} finally {
  await browser?.close();
  await server.close();
}
