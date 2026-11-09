import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer, transformWithOxc } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = `
import { createRoot } from 'react-dom/client';
import { useRef, useState } from 'react';
import { TranscriptVirtualizer } from '/src/TranscriptVirtualizer.tsx';
import { useSurfaceScroll } from '/src/surface-scroll.ts';
import { ChimeraMessageCard } from '/src/ChimeraMessageCard.tsx';
import { chimeraFollowup, chimeraFollowupState } from '/src/chimera-followup.ts';
function Fixture() {
  const scroll = useRef(null), list = useRef(null);
  const [messages, setMessages] = useState(Array.from({length:10000}, (_,i)=>({id:'m'+i,role:'assistant',text:'Message '+i})));
  return <><button onClick={()=>list.current.scrollToMessage(7890)}>Find 7890</button>
    <button onClick={()=>setMessages(m=>[...m,{id:'new',role:'assistant',text:'New streamed reply'}])}>Append</button>
    <div ref={scroll} id="scroll" data-count={messages.length} style={{height:500,width:700,overflow:'auto',border:'1px solid'}}>
      <TranscriptVirtualizer ref={list} scrollRef={scroll} messages={messages}
        header={<p>Conversation</p>} footer={<button>Pending approval</button>}
        renderMessage={(message)=><article data-message-id={message.id} style={{padding:12,minHeight:40}}>
          {message.text}<button>Copy {message.id}</button>
        </article>}/>
    </div></>;
}
function ScrollFixture(){
  const [scope,setScope]=useState('project-a');
  const ref=useSurfaceScroll(scope,'memory');
  return <><button onClick={()=>setScope('project-a')}>Project A</button><button onClick={()=>setScope('project-b')}>Project B</button>
    <div id="surface" ref={ref} data-scope={scope} style={{height:200,overflow:'auto'}}><div style={{height:4000}}>{scope}</div></div></>;
}
function ReviewFixture(){
  const [draft,setDraft]=useState('');
  const blocked=chimeraFollowupState({messages:[],connected:true,synced:true,running:false},'review-1',draft,0);
  return <><input aria-label="Review draft" value={draft} onChange={e=>setDraft(e.target.value)}/>
    <ChimeraMessageCard reportId="review-1" text="Needs review"
      onOpen={()=>document.body.dataset.openReport='review-1'}
      action={blocked ? {reason:blocked} : {run:()=>setDraft(chimeraFollowup('review-1'))}}/></>;
}
createRoot(document.getElementById('root')).render(<><Fixture/><ScrollFixture/><ReviewFixture/></>);
`;
const id = 'virtual:transcript-check',
  resolved = '\0transcript-check.tsx';
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
      name: 'transcript-check',
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
          if (req.url !== '/__transcript') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<html><body><div id="root"></div><script type="module" src="/@id/virtual:transcript-check"></script></body></html>',
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
  page.setDefaultNavigationTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(server.resolvedUrls.local[0] + '__transcript');
  await page.locator('[data-message-id="m0"]').waitFor();
  const initial = await page.locator('article').count();
  assert(initial < 80, '10,000 messages must not mount 10,000 rows');
  await page.getByRole('button', { name: 'Find 7890', exact: true }).click();
  await page.locator('[data-message-id="m7890"]').waitFor();
  assert(
    (await page.locator('article').count()) < 80,
    'Offscreen search must keep the mounted row count bounded',
  );
  assert(
    (await page.getByRole('button', { name: 'Pending approval', exact: true }).count()) === 1,
    'Approvals remain mounted',
  );
  await page.getByRole('button', { name: 'Copy m7890', exact: true }).focus();
  await page.locator('#scroll').evaluate((el) => (el.scrollTop = 0));
  await page.locator('[data-message-id="m0"]').waitFor();
  assert.equal(
    await page.locator('[data-message-id="m7890"]').count(),
    1,
    'Keyboard-focused row stays mounted',
  );
  await page.getByRole('button', { name: 'Append', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#scroll').dataset.count === '10001');
  await page.locator('#scroll').evaluate(async (el) => {
    await new Promise(requestAnimationFrame);
    el.scrollTop = el.scrollHeight;
  });
  await page.locator('[data-message-id="new"]').waitFor();
  assert((await page.locator('article').count()) < 80);
  await page.locator('#surface').evaluate((el) => (el.scrollTop = 1200));
  await page.waitForFunction(
    () => sessionStorage.getItem('wrongstack.desktop.scroll:project-a:memory') === '1200',
  );
  await page.getByRole('button', { name: 'Project B', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('#surface').dataset.scope === 'project-b' &&
      document.querySelector('#surface').scrollTop === 0,
  );
  await page.locator('#surface').evaluate((el) => (el.scrollTop = 500));
  await page.waitForFunction(
    () => sessionStorage.getItem('wrongstack.desktop.scroll:project-b:memory') === '500',
  );
  await page.getByRole('button', { name: 'Project A', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#surface').scrollTop === 1200);
  await page.getByRole('button', { name: 'Prepare follow-up', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('input[aria-label="Review draft"]').value.includes('review-1'),
  );
  assert(await page.getByRole('button', { name: 'Prepare follow-up', exact: true }).isDisabled());
  await page.getByRole('textbox', { name: 'Review draft', exact: true }).fill('Keep my draft');
  assert(await page.getByRole('button', { name: 'Prepare follow-up', exact: true }).isDisabled());
  await page.getByRole('button', { name: 'Open report', exact: true }).click();
  assert.equal(await page.locator('body').getAttribute('data-open-report'), 'review-1');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: 10,000 rows bounded; offscreen find, focused row, pending approval and append work; initial mounted rows=' +
      initial,
  );
} finally {
  await browser?.close();
  await server.close();
}
