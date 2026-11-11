import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer, transformWithOxc } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = `
import {createRoot} from 'react-dom/client';
import {EngineWorkspace} from '/src/EngineWorkspace.tsx';
import {emptyEngineState,reduceEngine} from '/src/engine-state.ts';
import '/src/styles.css'; import '/src/chat.css'; import '/src/workspace.css';
import '/src/workbench.css'; import '/src/appearance.css'; import '/src/shell.css';
const run = [{type:'tool.executed', payload:{id:'read-1', name:'read', input:{path:'README.md'}, ok:true, output:'Read file'}}];
const messages = Array.from({length:100}, (_, index) => ({
  id:'message-'+index, role:index % 2 ? 'assistant' : 'user',
  text:'Message '+index+' — '+('A paragraph in the retained conversation. ').repeat(index % 3 + 1),
  ...(index === 64 ? {activityAfter:run} : {}),
}));
const listeners = new Set();
let state = {...emptyEngineState, connected:true, synced:true, needsSetup:false,
  provider:'fixture', model:'fixture', sessionId:'fixture', messages, activity:run};
window.bridge = {
  subscribe: (notify) => {listeners.add(notify); return () => listeners.delete(notify)},
  snapshot: () => state,
  send: async () => {},
  command: async () => ({}),
};
window.feed = (type, payload) => {
  state = reduceEngine(state, {type,payload});
  listeners.forEach(notify=>notify());
};
const noop = () => {}, save = async () => true;
createRoot(document.getElementById('root')).render(
  <div className="app-shell"><div className="workspace-shell workspace-focused"><main className="main-content">
    <section className="session-workbench"><div className="session-workspace focused-session">
      <EngineWorkspace id="test" sessionTitle="Reading position" projectId="project" projectRoot="D:/fixture"
        scopeKey="D:/fixture" mode="btw" draft="Keep this draft" draftConflict={false} onModeChange={noop}
        validateDraft={save} onDraftChange={save} references={[]} attachments={[]} inputDrafts={{}}
        onError={error=>{throw error}} onAttachmentsChange={save} onReferencesChange={save}
        onInputDraftChange={noop} onSettings={noop} onOpen={noop}/>
    </div></section>
  </main></div></div>,
);
`;
const modules = new Map([
  ['\0transcript-tab-return.tsx', fixture],
  [
    '\0transcript-tab-engine.tsx',
    `import {useSyncExternalStore} from 'react';
    function useFixture(){const {subscribe,snapshot,send,command}=window.bridge;
      return {state:useSyncExternalStore(subscribe,snapshot),send,command}}
    export const useEngine=useFixture, useProjectEngine=useFixture, useProfileEngine=useFixture;`,
  ],
  [
    '\0transcript-tab-files.tsx',
    'export function ProjectSessionTools(){return <h2>Project files</h2>}',
  ],
]);
const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/src-tauri/**', '**/dist*/**'] } },
  plugins: [
    {
      name: 'transcript-tab-return-proof',
      enforce: 'pre',
      resolveId(id, importer) {
        if (id === 'virtual:transcript-tab-return') return '\0transcript-tab-return.tsx';
        if (!importer?.includes('/desktop-v2/src/')) return;
        if (id === './useEngine') return '\0transcript-tab-engine.tsx';
        if (id === './ProjectSessionTools') return '\0transcript-tab-files.tsx';
      },
      async load(id) {
        const code = modules.get(id);
        if (code)
          return (await transformWithOxc(code, 'fixture.tsx', { jsx: { runtime: 'automatic' } }))
            .code;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== '/__transcript-tab-return') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<html lang="en"><body><div id="root"></div><script type="module" src="/@id/virtual:transcript-tab-return"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});

const anchor = '[data-message-id="message-64"]';
const pane = '.native-chat-messages';
const readingPosition = () => {
  const row = document.querySelector('[data-message-id="message-64"]');
  const view = document.querySelector('.native-chat-messages');
  const disclosure = row?.nextElementSibling;
  return {
    offset: row ? row.getBoundingClientRect().top - view.getBoundingClientRect().top : null,
    scrollTop: view?.scrollTop ?? null,
    open: disclosure?.open ?? false,
  };
};
async function checkReturn(browser, url, viewport) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(url, { waitUntil: 'commit' });
  await page.locator('[data-message-id="message-99"]').waitFor();
  const nearEnd = () => {
    const view = document.querySelector('.native-chat-messages');
    return view && view.scrollHeight - view.scrollTop - view.clientHeight < 5;
  };
  await page.waitForFunction(nearEnd);
  console.log('CONTROL: initial conversation follows the latest message');
  await page.locator(pane).hover();
  await page.mouse.wheel(0, -1200);
  await page.getByRole('button', { name: 'Jump to latest' }).waitFor();
  // Use the production conversation finder to reach a row outside the mounted range.
  await page.keyboard.press('Control+f');
  const find = page.locator('input[data-find-input="conversation"]');
  await find.fill('Message 64 —');
  await find.press('Enter');
  await page.locator('.chat-message.find-current').waitFor();
  await find.press('Escape');
  await page.locator(`${anchor} + details > summary`).click();
  const before = await page.evaluate(readingPosition);
  assert.equal(before.open, true);
  assert.ok(
    before.offset !== null && before.offset >= -20 && before.offset < 500,
    JSON.stringify(before),
  );
  const nav = page.locator('.workspace-tabs');
  const chat = nav.getByRole('button', { name: /^Chat\b/ });
  const files = nav.getByRole('button', { name: 'Files', exact: true });
  for (const tool of ['Files', 'Run activity']) {
    if (tool === 'Files') {
      await files.click();
      await page.getByRole('heading', { name: 'Project files' }).waitFor();
    } else {
      await nav.getByRole('button', { name: 'Tools', exact: true }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /Run activity/ })
        .click();
    }
    assert.equal(await page.locator(pane).isVisible(), false, 'The transcript is hidden in tools');
    assert.equal(await page.getByRole('button', { name: 'Pin message' }).count(), 0);
    if (tool === 'Run activity') {
      await page.evaluate(() =>
        window.feed('provider.text_delta', {
          messageId: 'stream',
          text: 'Incoming reply. '.repeat(240),
        }),
      );
    }
    await chat.press('Enter');
    await page.locator(pane).waitFor();
    const after = await page.evaluate(readingPosition);
    console.log(`${tool} EXPECTED ${JSON.stringify(before)} ACTUAL ${JSON.stringify(after)}`);
    assert.ok(
      after.offset !== null && Math.abs(after.offset - before.offset) <= 2,
      `${tool} must preserve the visible row and its offset`,
    );
    assert.equal(after.open, true, `${tool} must preserve the open tool details`);
    assert.equal(await chat.evaluate((button) => button === document.activeElement), true);
  }
  await page.getByRole('button', { name: /Jump to latest.*1 new/ }).waitFor();
  assert.equal(await page.locator('.composer-input textarea').inputValue(), 'Keep this draft');
  await page.getByRole('button', { name: 'Jump to latest' }).click();
  await page.waitForFunction(nearEnd);
  await files.click();
  await page.evaluate(() =>
    window.feed('provider.text_delta', {
      messageId: 'stream',
      text: ' Continued reply. '.repeat(240),
    }),
  );
  await chat.click();
  await page.waitForFunction(nearEnd);
  const incoming = page.locator('[data-message-id="assistant:stream:100"]');
  await incoming.waitFor();
  assert.match((await incoming.textContent()) ?? '', /Continued reply/);
  assert.equal(await page.getByRole('button', { name: 'Jump to latest' }).count(), 0);

  await files.click();
  await page.evaluate(() =>
    window.feed('user.input_requested', {
      request: {
        id: 'question',
        title: 'Review choices',
        tabs: [
          {
            id: 'review',
            label: 'Review',
            questions: Array.from({ length: 8 }, (_, i) => ({
              id: 'question-' + i,
              prompt: 'Review question ' + (i + 1),
              kind: 'text',
            })),
          },
        ],
      },
    }),
  );
  await chat.click();
  await page.getByRole('heading', { name: 'Review choices' }).waitFor();
  const question = await page.locator(pane).evaluate((view) => {
    const heading = view.querySelector('.input-request-card h3').getBoundingClientRect();
    const frame = view.getBoundingClientRect();
    return {
      visible: heading.top >= frame.top && heading.bottom <= frame.bottom,
      scrollTop: view.scrollTop,
    };
  });
  assert.equal(
    question.visible,
    true,
    `A new question must start in view after returning: ${JSON.stringify(question)}`,
  );
  await page.getByRole('button', { name: 'Review conversation', exact: true }).click();
  await page.locator('.chat-message').first().waitFor();
  await files.click();
  await chat.click();
  assert.ok(
    await page.locator('.chat-message').count(),
    'Tool visits preserve conversation review',
  );
  await page.getByRole('button', { name: 'Focus questions', exact: true }).click();
  await page.waitForFunction(() => {
    const view = document.querySelector('.native-chat-messages');
    const heading = view.querySelector('.input-request-card h3').getBoundingClientRect();
    const frame = view.getBoundingClientRect();
    return heading.top >= frame.top && heading.bottom <= frame.bottom;
  });
  assert.deepEqual(errors, []);
  console.log(
    `PASS ${viewport.width}×${viewport.height}: tool visits preserve paused reading and open details during streaming; following returns to the latest reply`,
  );
  await page.close();
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const url = server.resolvedUrls.local[0] + '__transcript-tab-return';
  await checkReturn(browser, url, { width: 1280, height: 840 });
  await checkReturn(browser, url, { width: 800, height: 600 });

  const compact = await browser.newPage({ viewport: { width: 400, height: 300 } });
  compact.setDefaultTimeout(12000);
  await compact.goto(url, { waitUntil: 'commit' });
  const transcript = compact.locator(pane);
  await transcript.waitFor();
  assert.ok((await transcript.boundingBox()).height >= 70);
  const send = compact.getByRole('button', { name: 'Send message', exact: true });
  await send.scrollIntoViewIfNeeded();
  const button = await send.boundingBox();
  assert.ok(button.y >= 0 && button.y + button.height <= 300);
  assert.ok(
    await compact.locator('.workspace-focused .main-content').evaluate((el) => el.scrollTop > 0),
  );
  assert.equal(await compact.evaluate(() => document.documentElement.scrollWidth), 400);
  await compact.close();
  console.log('PASS 400×300: the transcript and send action are reachable in the short workbench');
} finally {
  await browser?.close();
  await server.close();
}
