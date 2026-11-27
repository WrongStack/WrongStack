import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer, transformWithOxc } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Other desktop browser fixtures may run concurrently; do not invalidate their Vite cache.
const cacheDir = resolve(root, '../../.temp_files', `project-menu-vite-${process.pid}`);
const screenshots = process.env.WRONGSTACK_PROJECT_MENU_SCREENSHOTS;
// Real sidebar, controller, modal and IPC adapter; only the native process/folder picker is a fixture.
const source = `
import {createRoot} from 'react-dom/client';
import {Sidebar} from '/src/Sidebar.tsx';
import {useDesktop} from '/src/useDesktop.ts';
import {useWorkbenchExplorer} from '/src/useWorkbenchExplorer.ts';
import '/src/styles.css'; import '/src/brand-tokens.css'; import '/src/appearance.css';
import '/src/workbench.css'; import '/src/controls.css'; import '/src/shell.css'; import '/src/ide-workbench.css';
let projects=['Alpha','Beta','Unicode 検証 '+ 'long-name-'.repeat(15)].map((name,i)=>({id:'p'+i,name,root:'D:/fixture/'+name,createdAt:i}));
const original=structuredClone(projects);
const sessions=[['shell','Build shell','terminal','running'],['review','Review pending changes','agent','stopped']].map(([id,title,kind,status],i)=>({id,title,kind,status,projectId:'p0',workdir:'D:/fixture/Alpha',createdAt:i,updatedAt:i,exitCode:null,error:null}));
window.fixtureSessions=sessions;
window.proofCalls=[]; window.proofErrors=[]; window.cancelPicker=false; window.failSave=false;
window.proofInvoke=async(command,args)=>{
 if(command==='choose_project')return window.cancelPicker?null:'D:/fixture/Alpha';
 if(command!=='host_request')throw Error('Unexpected command '+command);
 const {method,params}=args; window.proofCalls.push({method,params});
 if(method==='snapshot')return {projects:structuredClone(projects),sessions:structuredClone(sessions.filter(s=>projects.some(p=>p.id===s.projectId))),hostPid:1,layout:null};
 if(method==='settings.save')return null;
 if(window.failSave){window.failSave=false;throw Error('Fixture write failed');}
 if(method==='project-menu.remove'){projects=projects.filter(p=>p.id!==params.id);return null;}
 if(method==='project-menu.move'){
  const {id,target,after}=params;
  const moved=projects.find(p=>p.id===id); projects=projects.filter(p=>p.id!==id);
  const index=projects.findIndex(p=>p.id===target);projects.splice(index+(after?1:0),0,moved);return null;
 }
 if(method==='project.register'){const p=original[0];if(!projects.some(row=>row.id===p.id))projects.push(p);return p;}
 throw Error('Unexpected request '+method);
};
function Fixture(){const vm=useDesktop();const explorer=useWorkbenchExplorer(JSON.stringify([vm.section,vm.project,vm.selected,vm.projectPage]));window.proofVm=vm;return <div className="app-shell"><Sidebar vm={vm} explorer={explorer}/><main className="workspace-shell"><div role="alert">{vm.error}</div><p>Project menu fixture</p></main></div>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
const server = await createServer({
  root,
  cacheDir,
  configFile: join(root, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null },
  plugins: [
    {
      name: 'project-menu-browser-fixture',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'virtual:project-menu-proof') return '\0project-menu-proof.tsx';
        if (id === '@tauri-apps/api/core') return '\0project-menu-native.ts';
        if (id === '@tauri-apps/api/webview') return '\0project-menu-webview.ts';
      },
      async load(id) {
        if (id === '\0project-menu-native.ts')
          return 'export const isTauri=()=>true; export const invoke=(...args)=>window.proofInvoke(...args); export class Channel {}';
        if (id === '\0project-menu-webview.ts')
          return 'export const getCurrentWebview=()=>({setZoom:async()=>{}});';
        if (id === '\0project-menu-proof.tsx')
          return (await transformWithOxc(source, 'fixture.tsx', { jsx: { runtime: 'automatic' } }))
            .code;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url?.split('?')[0] !== '/__project-menu') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><title>Project menu fixture</title></head><body><div id="root"></div><script type="module" src="/@id/virtual:project-menu-proof"></script></body></html>',
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
  if (screenshots) await mkdir(screenshots, { recursive: true });
  browser = await chromium.launch({ headless: true });
  for (const mode of ['dark', 'light']) {
    for (const [width, height] of [
      [1440, 900],
      [800, 600],
      [390, 800],
      [1280, 480],
    ]) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(server.resolvedUrls.local[0] + '__project-menu', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await page.locator('.project-item').first().waitFor({ state: 'attached' });
      await page.evaluate((mode) => window.proofVm.changeAppearance({ mode }), mode);
      const compact = width < 620;
      const reveal = async () => {
        if (compact && !(await page.locator('.explorer').isVisible()))
          await page.getByRole('button', { name: 'Projects and sessions', exact: true }).click();
      };
      await reveal();
      const names = () => page.locator('.project-item > span:last-child').allTextContents();
      assert.equal((await names())[0], 'Alpha');
      await page.evaluate(() => document.fonts.ready);
      const labelFits = (name) =>
        page
          .getByRole('button', { name, exact: true })
          .locator('span:last-child')
          .evaluate((label) => label.scrollWidth <= label.clientWidth);
      assert.equal(await labelFits('Alpha'), true, `Short project name is clipped at ${width}px`);
      await page.evaluate(() => window.proofVm.jumpToSession(window.fixtureSessions[0]));
      await reveal();
      const current = page.locator('.tree-session.chosen');
      await current.waitFor();
      assert.equal(await current.getAttribute('aria-current'), 'page');
      assert.ok(await current.locator('.tree-session-icon svg.lucide-square-terminal').isVisible());
      const actions = current
        .locator('..')
        .getByRole('button', { name: 'Stop Build shell', exact: true });
      assert.ok(await actions.isVisible());
      assert.ok((await actions.boundingBox()).width >= 24);
      assert.ok(await page.locator('.project-branch-sessions .lucide-message-square').isVisible());
      if (
        screenshots &&
        ((mode === 'dark' && width === 1440) || (mode === 'light' && width === 390))
      ) {
        await page
          .locator('.explorer')
          .screenshot({ path: join(screenshots, `explorer-${mode}-${width}.png`) });
      }
      await page.getByRole('button', { name: 'Reorder Beta', exact: true }).focus();
      await page.keyboard.press('Alt+ArrowUp');
      await page.waitForFunction(
        () => document.querySelector('.project-item > span:last-child')?.textContent === 'Beta',
      );
      assert.equal(
        await page
          .getByRole('button', { name: 'Reorder Beta', exact: true })
          .evaluate((e) => e === document.activeElement),
        true,
      );
      const alpha = page.locator('.project-item').filter({ hasText: 'Alpha' });
      await page
        .getByRole('button', { name: 'Reorder Beta', exact: true })
        .dragTo(alpha, { targetPosition: { x: 20, y: 24 } });
      await page.waitForFunction(
        () => document.querySelector('.project-item > span:last-child')?.textContent === 'Alpha',
      );
      const grip = page.getByRole('button', { name: 'Reorder Beta', exact: true });
      await grip.press('Enter');
      const reorder = page.getByRole('dialog', { name: 'Reorder project' });
      const position = reorder.getByRole('combobox', { name: 'New position' });
      await position.waitFor();
      assert.match(await reorder.textContent(), /D:\/fixture\/Beta/);
      const save = reorder.getByRole('button', { name: 'Move project' });
      assert.equal(await save.isDisabled(), true);
      await position.selectOption('p0');
      await page.keyboard.press('Escape');
      assert.equal((await names())[0], 'Alpha', 'Cancelling leaves the order unchanged');
      assert.ok(await grip.evaluate((node) => node === document.activeElement));
      await grip.click();
      await position.selectOption('p0');
      await page.evaluate(() => {
        window.failSave = true;
      });
      await save.click();
      await reorder.getByRole('alert').getByText('Fixture write failed').waitFor();
      assert.equal(
        await position.inputValue(),
        'p0',
        'Failed writes preserve the intended position',
      );
      assert.equal((await names())[0], 'Alpha', 'Failed writes leave the order unchanged');
      await save.click();
      await reorder.waitFor({ state: 'hidden' });
      assert.equal((await names())[0], 'Beta');
      assert.ok(await grip.evaluate((node) => node === document.activeElement));
      await page.getByRole('status').getByText('Beta moved.').waitFor();
      await grip.press('Alt+ArrowDown');
      await page.waitForFunction(
        () => document.querySelector('.project-item > span:last-child')?.textContent === 'Alpha',
      );

      await page.getByRole('button', { name: 'Remove project Alpha', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      assert.match(
        (await page.getByRole('dialog').textContent()) ?? '',
        /Files, history and drafts are kept/,
      );
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal((await names()).length, 3);
      await page.getByRole('button', { name: 'Remove project Alpha', exact: true }).click();
      await page.evaluate(() => {
        window.failSave = true;
      });
      await page.getByRole('button', { name: 'Remove', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Fixture write failed' }).waitFor();
      assert.equal(await page.getByRole('dialog').isVisible(), true);
      await page.getByRole('button', { name: 'Remove', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.project-item').length === 2);
      await reveal();
      await page.getByRole('button', { name: 'Add project', exact: true }).first().click();
      await page.waitForFunction(() => document.querySelectorAll('.project-item').length === 3);
      assert.equal((await names()).at(-1), 'Alpha');
      await page.evaluate(() => {
        window.cancelPicker = true;
      });
      const registrations = await page.evaluate(
        () => window.proofCalls.filter((c) => c.method === 'project.register').length,
      );
      await page.getByRole('button', { name: 'Add project', exact: true }).first().click();
      await page.waitForFunction(() => !window.proofVm.pending);
      assert.equal((await names()).length, 3);
      assert.equal(
        await page.evaluate(
          () => window.proofCalls.filter((c) => c.method === 'project.register').length,
        ),
        registrations,
      );
      // Inspect the rendered overflow and actual 24px pointer targets in both themes.
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        targets: [...document.querySelectorAll('.project-drag-handle,.project-remove')].every(
          (e) => {
            const r = e.getBoundingClientRect();
            return r.width >= 24 && r.height >= 24;
          },
        ),
        verticalScroll: getComputedStyle(document.querySelector('.project-tree')).overflowY,
      }));
      assert.equal(layout.overflow, false, `${mode} ${width} horizontal overflow`);
      assert.equal(layout.targets, true);
      for (const remaining of [2, 1, 0]) {
        await reveal();
        await page.locator('.project-remove').first().click();
        await page.getByRole('button', { name: 'Remove', exact: true }).click();
        await page.waitForFunction(
          (count) => document.querySelectorAll('.project-item').length === count,
          remaining,
        );
      }
      await reveal();
      await page.getByText('Add a project folder to start a session.', { exact: true }).waitFor();
      await page.evaluate(() => {
        window.cancelPicker = false;
      });
      await page.getByRole('button', { name: 'Add project', exact: true }).first().click();
      await page.waitForFunction(() => document.querySelectorAll('.project-item').length === 1);
      assert.deepEqual(await names(), ['Alpha']);
      assert.deepEqual(errors, []);
      console.log(
        `PASS project menu ${mode} ${width}x${height}: add/cancel, remove/retry/restore, drag, keyboard, no overflow`,
      );
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
