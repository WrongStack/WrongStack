import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const webuiRoot = path.resolve(here, '..');
const simpleuiRoot = path.resolve(here, '..', '..', 'simpleui');

function harnessPlugin(source) {
  const virtualId = 'virtual:user-input-browser-smoke';
  const resolvedId = `\0${virtualId}.tsx`;
  return {
    name: 'user-input-browser-smoke',
    resolveId(id) {
      return id === virtualId ? resolvedId : undefined;
    },
    load(id) {
      return id === resolvedId ? source : undefined;
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/__user_input_smoke') return next();
        const html = await server.transformIndexHtml(
          req.url,
          '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/@id/virtual:user-input-browser-smoke"></script></body></html>',
        );
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
      });
    },
  };
}

const webuiSource = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/index.css';
import { UserInputDialog } from '/src/components/UserInputDialog.tsx';
import { ensureSessionLane, setActiveSessionLane } from '/src/stores/session-lanes.ts';
import { useUserInputStore } from '/src/stores/user-input-store.ts';
ensureSessionLane('browser-session');
setActiveSessionLane('browser-session');
const options = Array.from({ length: 6 }, (_, index) => ({ id: 'option_' + index, label: 'Option ' + (index + 1), description: 'A concrete trade-off for option ' + (index + 1) }));
useUserInputStore.getState().enqueue({ sessionId: 'browser-session', request: {
  id: 'browser-form', title: 'Production architecture decisions', description: 'Answer the questions required to continue safely.', submitLabel: 'Submit answers',
  tabs: [
    { id: 'architecture', label: 'Architecture', description: 'Core system choices', questions: Array.from({ length: 5 }, (_, index) => ({ id: 'choice_' + index, prompt: 'Architecture question ' + (index + 1) + '?', description: 'This choice affects the implementation contract.', kind: index === 1 ? 'multi_select' : 'single_select', required: true, options, recommendedOptionIds: ['option_0'], recommendationReason: 'This is the safest default.', allowCustomResponse: true })) },
    { id: 'product', label: 'Product', questions: [{ id: 'tenant_name', prompt: 'Tenant name?', kind: 'text', required: true, recommendedText: 'Example Inc.', recommendationReason: 'A clear placeholder.' }] }
  ]
} });
createRoot(document.getElementById('root')).render(React.createElement(UserInputDialog));
window.__userInputReady = true;
`;

const simpleuiSource = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles.css';
import { UserInputModal } from '/src/user-input-modal.tsx';
const options = Array.from({ length: 6 }, (_, index) => ({ id: 'option_' + index, label: 'Option ' + (index + 1), description: 'Trade-off ' + (index + 1) }));
const pending = { sessionId: 'simple-session', request: { id: 'simple-form', title: 'SimpleUI decisions', submitLabel: 'Submit answers', tabs: [
  { id: 'architecture', label: 'Architecture', questions: Array.from({ length: 5 }, (_, index) => ({ id: 'choice_' + index, prompt: 'Question ' + (index + 1) + '?', kind: 'single_select', required: true, options, recommendedOptionIds: ['option_0'], recommendationReason: 'Safest default.', allowCustomResponse: true })) },
  { id: 'product', label: 'Product', questions: [{ id: 'tenant_name', prompt: 'Tenant name?', kind: 'text', required: true }] }
] } };
const send = (type, payload) => { window.__submitted = { type, payload }; };
createRoot(document.getElementById('root')).render(React.createElement(UserInputModal, { pending, queuedCount: 2, send }));
window.__userInputReady = true;
`;

async function start(root, source) {
  const server = await createServer({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    plugins: [harnessPlugin(source)],
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not expose a TCP port');
  return { server, url: `http://127.0.0.1:${address.port}/__user_input_smoke` };
}

async function assertGeometry(page, width, height) {
  const dialog = page.getByRole('dialog');
  const submit = page.getByRole('button', { name: 'Submit answers' });
  await dialog.waitFor();
  const [dialogBox, submitBox] = await Promise.all([dialog.boundingBox(), submit.boundingBox()]);
  if (!dialogBox || !submitBox) throw new Error(`Missing visible geometry at ${width}x${height}`);
  const epsilon = 1;
  if (
    dialogBox.x < -epsilon ||
    dialogBox.y < -epsilon ||
    dialogBox.x + dialogBox.width > width + epsilon ||
    dialogBox.y + dialogBox.height > height + epsilon
  ) {
    const computed = await dialog.evaluate((element) => ({
      attribute: element.getAttribute('style'),
      width: getComputedStyle(element).width,
      maxWidth: getComputedStyle(element).maxWidth,
      maxHeight: getComputedStyle(element).maxHeight,
      display: getComputedStyle(element).display,
    }));
    const viewport = await page.evaluate(() => ({
      innerWidth,
      innerHeight,
      clientWidth: document.documentElement.clientWidth,
      clientHeight: document.documentElement.clientHeight,
      visualWidth: visualViewport?.width,
      visualHeight: visualViewport?.height,
      small: matchMedia('(min-width: 40rem)').matches,
      rootZoom: getComputedStyle(document.documentElement).zoom,
      bodyZoom: getComputedStyle(document.body).zoom,
    }));
    throw new Error(
      `Dialog escaped ${width}x${height}: ${JSON.stringify({ dialogBox, computed, viewport })}`,
    );
  }
  if (
    submitBox.y < dialogBox.y ||
    submitBox.y + submitBox.height > dialogBox.y + dialogBox.height + epsilon
  ) {
    throw new Error(`Submit footer was clipped at ${width}x${height}`);
  }
  const scroll = page.getByTestId('user-input-scroll-region');
  const scrollable = await scroll.evaluate(
    (element) => element.scrollHeight > element.clientHeight,
  );
  if (!scrollable)
    throw new Error(`Long form did not create a scroll region at ${width}x${height}`);
}

async function runSurface(browser, root, source, name) {
  const { server, url } = await start(root, source);
  const page = await browser.newPage();
  try {
    for (const [width, height] of [
      [390, 520],
      [390, 300],
      [1280, 300],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(url);
      await page.waitForFunction(() => window.__userInputReady === true);
      await assertGeometry(page, width, height);
    }
    const tab = (label) =>
      name === 'WebUI'
        ? page.getByRole('tab', { name: new RegExp(label) })
        : page.locator('.user-input-tabs button').filter({ hasText: label });
    await tab('Product').click();
    await page.getByRole('textbox').fill('Acme');
    await tab('Architecture').click();
    await page.getByRole('textbox', { name: 'Custom answer' }).first().fill('Manual database');
    const customSelected = await page
      .getByRole('radio', { name: 'Select custom answer' })
      .first()
      .isChecked();
    const recommendedCleared = !(await page
      .getByRole('radio', { name: /Option 1/ })
      .first()
      .isChecked());
    if (!customSelected || !recommendedCleared) {
      throw new Error(`${name} did not select Other and clear the single radio choice`);
    }
    await page
      .getByRole('radio', { name: /Option 2/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Apply tab recommendations' }).click();
    const recommendedChecked = await page
      .getByRole('radio', { name: /Option 1/ })
      .first()
      .isChecked();
    if (!recommendedChecked) throw new Error(`${name} failed to restore the recommended answer`);
    const delegate = page.getByRole('button', { name: /You decide/ }).first();
    await delegate.click();
    if ((await delegate.getAttribute('aria-pressed')) !== 'true') {
      throw new Error(`${name} failed to select the model-delegation answer`);
    }
    await page
      .getByRole('radio', { name: /Option 2/ })
      .first()
      .click();
    if ((await delegate.getAttribute('aria-pressed')) !== 'false') {
      throw new Error(`${name} did not clear delegation after a concrete answer`);
    }
    if (name === 'SimpleUI') {
      await page.getByRole('button', { name: 'Submit answers' }).click();
      const submitted = await page.evaluate(() => window.__submitted);
      if (submitted?.type !== 'user.input_submit') {
        throw new Error('SimpleUI submit did not produce a tool response');
      }
    }
    return {
      name,
      viewports: ['390x520', '390x300', '1280x300'],
      interaction: 'passed',
    };
  } finally {
    await page.close();
    await server.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const results = [];
  results.push(await runSurface(browser, webuiRoot, webuiSource, 'WebUI'));
  results.push(await runSurface(browser, simpleuiRoot, simpleuiSource, 'SimpleUI'));
  process.stdout.write(`${JSON.stringify({ passed: true, results })}\n`);
} finally {
  await browser.close();
}
