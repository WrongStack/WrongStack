import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer, transformWithOxc } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = `
import {createRoot} from 'react-dom/client';
import {useRef,useState} from 'react';
import {TranscriptVirtualizer} from '/src/TranscriptVirtualizer.tsx';
function Fixture(){
 const pane=useRef(null), list=useRef(null), following=useRef(false);
 const [narrow,setNarrow]=useState(true), [expanded,setExpanded]=useState(false);
 const messages=Array.from({length:80},(_,i)=>({id:'row-'+i,role:'assistant',text:('Row '+i+' retained paragraph. ').repeat(4)}));
 return <><button onClick={()=>list.current.scrollToMessage(64)}>Find first</button>
 <button onClick={()=>setExpanded(true)}>Open activity</button>
 <button onClick={()=>{setNarrow(true);list.current.scrollToMessage(64)}}>Resize and repeat</button>
 <button onClick={()=>{setNarrow(true);list.current.scrollToMessage(63)}}>Resize and change</button>
 <div id="pane" ref={pane} style={{height:narrow?100:300,width:narrow?270:700,overflow:'auto',border:'1px solid'}}>
 <TranscriptVirtualizer ref={list} scrollRef={pane} following={following} messages={messages}
  header={<div>Header</div>} footer={<div>End</div>}
  renderMessage={m=><><article data-id={m.id} style={{padding:12,margin:0,lineHeight:'20px'}}>{m.text}</article>
   {m.id==='row-64'&&<details open={expanded}><summary>Actual activity layout fixture</summary><pre style={{lineHeight:'20px',margin:0}}>{'Read output line\\n'.repeat(30)}</pre></details>}</>}/>
 </div></>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
const id = '\0repeat-find.tsx';
const server = await createServer({
  root,
  configFile: join(root, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/src-tauri/**', '**/dist*/**'] } },
  plugins: [
    {
      name: 'owned-repeat-find-proof',
      resolveId(value) {
        if (value === 'virtual:repeat-find') return id;
      },
      async load(value) {
        if (value === id)
          return (await transformWithOxc(source, 'fixture.tsx', { jsx: { runtime: 'automatic' } }))
            .code;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== '/__repeat-find') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<div id="root"></div><script type="module" src="/@id/virtual:repeat-find"></script>',
            ),
          );
        });
      },
    },
  ],
});
const state = (id) => {
  const pane = document.querySelector('#pane'),
    row = document.querySelector('[data-id="row-' + id + '"]');
  const p = pane.getBoundingClientRect(),
    r = row?.getBoundingClientRect();
  return {
    top: r ? r.top - p.top : null,
    bottom: r ? r.bottom - p.top : null,
    height: p.height,
    scrollTop: pane.scrollTop,
  };
};
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  for (const expanded of [false, true]) {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(server.resolvedUrls.local[0] + '__repeat-find');
    if (expanded) await page.getByRole('button', { name: 'Open activity', exact: true }).click();
    await page.getByRole('button', { name: 'Find first', exact: true }).click();
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done))),
        ),
    );
    const actual = await page.evaluate(state, 64);
    console.log(expanded ? 'EXPANDED ACTIVITY' : 'CONTROL CLOSED ACTIVITY', JSON.stringify(actual));
    assert.ok(
      actual.top !== null && actual.bottom > 0 && actual.top < actual.height,
      'Find brings the requested message into view even with its activity expanded',
    );
    for (const same of [true, false]) {
      await page
        .getByRole('button', {
          name: same ? 'Resize and repeat' : 'Resize and change',
          exact: true,
        })
        .click();
      await page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done))),
          ),
      );
      const again = await page.evaluate(state, same ? 64 : 63);
      assert.ok(
        again.top !== null && again.bottom > 0 && again.top < again.height,
        'Repeated or adjacent navigation keeps the requested message visible',
      );
    }
    await page.close();
  }
  console.log('PASS: collapsed/expanded activity and repeated/adjacent message navigation');
} finally {
  await browser?.close();
  await server.close();
}
