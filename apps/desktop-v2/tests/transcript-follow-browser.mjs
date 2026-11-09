import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer, transformWithOxc } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = 'virtual:follow-proof',
  resolved = '\0follow-proof.tsx';
const source = `
import {createRoot} from 'react-dom/client';
import {useRef,useState} from 'react';
import {TranscriptVirtualizer} from '/src/TranscriptVirtualizer.tsx';
import {useTranscriptFollowHandlers} from '/src/transcript-follow.ts';
function Fixture(){
  const pane=useRef(null), following=useRef(true);
  const [lines,setLines]=useState(1),[active,setActive]=useState(true);
  const messages=[{id:'old',role:'assistant',text:'Short control answer'},
    {id:'new',role:'assistant',text:Array.from({length:lines},(_,i)=>'Long line '+i).join('\\n')}];
  const pause=()=>{following.current=false;setActive(false);};
  const resume=()=>{following.current=true;setActive(true);};
  const handlers=useTranscriptFollowHandlers(following,pause,resume);
  return <><button onClick={()=>setLines(n=>n===1?1000:2000)}>Grow answer</button>
    <div id="pane" data-lines={lines} data-following={String(active)} ref={pane}
      style={{height:300,width:700,overflow:'auto'}}
      {...handlers}>
      <TranscriptVirtualizer following={following} scrollRef={pane} messages={messages}
        header={<span>Conversation</span>} footer={<div id="tail">Long reply complete.</div>}
        renderMessage={m=><pre style={{margin:0,lineHeight:'20px'}}>{m.text}</pre>}/>
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
      name: 'follow-proof',
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
          if (req.url !== '/__follow') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<html><body><div id="root"></div><script type="module" src="/@id/virtual:follow-proof"></script></body></html>',
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
  await page.goto(server.resolvedUrls.local[0] + '__follow');
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
  await page.locator('#pane').hover();
  await page.mouse.wheel(0, -1000);
  await page.waitForFunction(() => document.querySelector('#pane').dataset.following === 'false');
  await page.waitForFunction(() => {
    const pane = document.querySelector('#pane');
    return pane.scrollHeight - pane.scrollTop - pane.clientHeight > 900;
  });
  const before = await page.locator('#pane').evaluate((el) => el.scrollTop);
  await page.getByRole('button', { name: 'Grow answer', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#pane').dataset.lines === '2000');
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await page.locator('#pane').getAttribute('data-following'), 'false');
  const after = await page.locator('#pane').evaluate((el) => ({
    top: el.scrollTop,
    gap: el.scrollHeight - el.scrollTop - el.clientHeight,
  }));
  assert(Math.abs(after.top - before) < 5, 'Reader keeps their position during further streaming');
  assert(after.gap > 900, 'Explicit user scrolling remains respected');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: short control; growing 1,000-line answer follows its end; explicit wheel pause survives 2,000-line growth without jumping',
  );
} finally {
  await browser?.close();
  await server.close();
}
