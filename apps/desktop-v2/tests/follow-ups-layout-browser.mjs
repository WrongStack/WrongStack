import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer, transformWithOxc } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const id = 'virtual:follow-ups-layout';
const source = `
import {createRoot} from 'react-dom/client';
import {useRef,useState} from 'react';
import {TurnFollowUps} from '/src/TurnFollowUps.tsx';
import {LiveRunActivity} from '/src/TurnTools.tsx';
import {TranscriptVirtualizer} from '/src/TranscriptVirtualizer.tsx';
import {emptyEngineState} from '/src/engine-state.ts';
import '/src/styles.css'; import '/src/chat.css'; import '/src/workspace.css';
import '/src/brand-tokens.css'; import '/src/appearance.css'; import '/src/workbench.css';
import '/src/project.css'; import '/src/files.css'; import '/src/knowledge.css';
import '/src/atlas.css'; import '/src/chronicle.css'; import '/src/git-history.css';
import '/src/skills.css'; import '/src/shell.css'; import '/src/controls.css';
import '/src/composer.css'; import '/src/transcript-message.css';
const events=[{type:'tool.started',payload:{id:'read-1',name:'read',input:{path:'src/example.ts'}}},
{type:'tool.executed',payload:{id:'read-1',name:'read',ok:true,durationMs:12345,outputBytes:1234567,output:'Source output\\n'.repeat(40)}}];
function Fixture(){
 const pane=useRef(null),continued=useRef(0),[sent,setSent]=useState(''),[mode,setMode]=useState('off');
 const state={...emptyEngineState,hydrating:false,nextSteps:[{index:1,text:'Inspect the result',auto:true},{index:2,text:'Run focused checks'}],results:{'prefs.updated':{autonomy:mode,yolo:true}}};
 return <><select aria-label="Continuation mode" value={mode} onChange={e=>setMode(e.target.value)}><option value="off">Manual</option><option value="auto">Automatic</option></select>
 <output data-testid="sent">{sent}</output>
 <div className="native-chat-messages" ref={pane}><TranscriptVirtualizer scrollRef={pane} messages={[]} renderMessage={()=>null} footer={null} header={<LiveRunActivity events={events} onOpenFile={()=>{}}/>}/></div>
 <div className="native-composer-stack"><TurnFollowUps state={state} composerEmpty={true} huntContinues={false} continued={continued} sending={false} onAdd={setSent} send={async text=>{setSent(text);return '';}} report={()=>{}} onContinue={setSent}/></div></>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
const server = await createServer({
  root,
  configFile: join(root, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/src-tauri/**', '**/dist*/**'] } },
  plugins: [
    {
      name: 'follow-ups-layout',
      resolveId(value) {
        if (value === id) return '\0follow-ups-layout.tsx';
      },
      async load(value) {
        if (value === '\0follow-ups-layout.tsx')
          return (await transformWithOxc(source, 'fixture.tsx', { jsx: { runtime: 'automatic' } }))
            .code;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== '/__follow-ups') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<div id="root"></div><script type="module" src="/@id/virtual:follow-ups-layout"></script>',
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
  const failures = [];
  for (const [width, height] of [
    [1480, 960],
    [800, 600],
    [390, 700],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.clock.install();
    await page.goto(server.resolvedUrls.local[0] + '__follow-ups');
    await page.locator('.next-steps-panel').waitFor();
    for (const [name, check] of [
      [
        'tool group layout',
        async () => {
          const sizes = await page.locator('.chat-run-activity').evaluate((group) => {
            const summary = group.querySelector(':scope > summary').getBoundingClientRect();
            const body = group.querySelector('.session-activity').getBoundingClientRect();
            return {
              summary: summary.width,
              body: body.width,
              top: body.top,
              bottom: summary.bottom,
            };
          });
          console.log('LAYOUT', width, sizes);
          assert.ok(
            sizes.summary > Math.min(250, width / 2),
            'Tool group summary has a readable width',
          );
          assert.ok(
            sizes.top >= sizes.bottom - 1,
            'Scrollable tool body sits below its summary, not beside it',
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
          );
          await page.locator('.chat-run-activity').evaluate((group) => {
            group.style.width = '250px';
          });
          const labelWidth = await page
            .locator('.activity-entry-label')
            .evaluate((label) => label.getBoundingClientRect().width);
          console.log('NARROW TOOL LABEL', width, labelWidth);
          assert.ok(
            labelWidth >= 100,
            'Tool labels remain readable in a narrow pane at a desktop viewport',
          );
          await page.locator('.chat-run-activity').evaluate((group) => {
            group.style.width = '';
          });
        },
      ],
      [
        'next steps visible',
        async () => {
          assert.equal(
            await page.getByLabel('Inspect the result', { exact: true }).isVisible(),
            true,
            'Next-step choices are visible without expanding a disclosure',
          );
        },
      ],
    ]) {
      try {
        await check();
      } catch (error) {
        failures.push(`${width}: ${name}: ${error.message}`);
      }
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  assert.deepEqual(failures, []);
  const page = await browser.newPage({ viewport: { width: 1480, height: 960 } });
  page.setDefaultTimeout(10000);
  await page.clock.install();
  const reset = async () => {
    await page.goto(server.resolvedUrls.local[0] + '__follow-ups');
    await page.locator('.next-steps-panel').waitFor();
    assert.equal(
      await page.locator('.auto-continue').count(),
      0,
      'Manual mode never starts a timer',
    );
    await page.getByRole('combobox', { name: 'Continuation mode' }).selectOption('auto');
    await page.locator('.auto-continue').scrollIntoViewIfNeeded();
    await page.clock.runFor(1000);
    await page.getByText('Continuing in 4 s with:', { exact: false }).waitFor();
  };
  await reset();
  await page.clock.runFor(5000);
  assert.equal(
    await page.locator('[data-testid="sent"]').textContent(),
    'Inspect the result',
    'Visible opted-in automatic mode still continues',
  );
  await reset();
  await page.getByLabel('Run focused checks', { exact: true }).focus();
  await page.clock.runFor(10000);
  await page.getByLabel('Run focused checks', { exact: true }).press('Space');
  assert.equal(
    await page.locator('[data-testid="sent"]').textContent(),
    '',
    'Reviewing a choice cancels automatic submission',
  );
  await page.getByRole('button', { name: 'Send 1 step', exact: true }).click();
  assert.equal(
    await page.locator('[data-testid="sent"]').textContent(),
    'Run focused checks',
    'Manual selection sends the chosen option, not the automatic default',
  );
  await reset();
  await page.locator('.next-steps-panel > summary').click();
  await page.clock.runFor(10000);
  assert.equal(
    await page.locator('[data-testid="sent"]').textContent(),
    '',
    'Collapsing choices cancels automatic submission',
  );
  await reset();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.clock.runFor(10000);
  assert.equal(
    await page.locator('[data-testid="sent"]').textContent(),
    '',
    'Cancel stops the automatic continuation',
  );
  await reset();
  await page.locator('.native-composer-stack').evaluate((stack) => {
    stack.style.marginTop = '2000px';
  });
  await page.clock.runFor(10000);
  assert.equal(
    await page.locator('[data-testid="sent"]').textContent(),
    '',
    'Offscreen options never auto-submit',
  );
  await page.locator('.native-composer-stack').evaluate((stack) => {
    stack.style.marginTop = '';
  });
  await page.locator('.auto-continue').scrollIntoViewIfNeeded();
  await page.clock.runFor(1000);
  await page.getByText('Continuing in 4 s with:', { exact: false }).waitFor();
  assert.equal(
    await page.locator('[data-testid="sent"]').textContent(),
    '',
    'Returning to visible choices gives a fresh grace period',
  );
  await page.close();
  console.log(
    'PASS: visible choices, cancellable/visibility-gated auto-continue and readable tool groups',
  );
} finally {
  await browser?.close();
  await server.close();
}
