import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { ArchitectureDecisionStore } from '@wrongstack/core/storage';
import { createServer } from 'vite';
import { buildAdrCommand } from '../../runtime/src/portable-commands/adr.ts';

// Browser render + real portable command + real isolated SQLite. The fixture's
// HTTP transport replaces only WebSocket RPC; command routing has separate tests.
const webuiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'adr-browser-'));
const originalHome = process.env.WRONGSTACK_HOME;
process.env.WRONGSTACK_HOME = path.join(scratch, 'home');
const projectRoot = path.join(scratch, 'project');
await mkdir(projectRoot);
await writeFile(path.join(projectRoot, 'contract.txt'), 'required marker');
const command = buildAdrCommand({
  projectRoot,
  permissionPolicy: { explain: async () => ({ decision: { permission: 'auto' } }) },
  toolRegistry: {
    get: () => ({
      name: 'read',
      permission: 'auto',
      mutating: false,
      description: 'Read fixture.',
      inputSchema: { type: 'object' },
      execute: async () => '',
    }),
  },
});
const reportDir = path.resolve(webuiRoot, '../../.reports/architecture-decisions');
await mkdir(reportDir, { recursive: true });
const source = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/index.css';
import { i18n } from '/src/i18n/index.ts';
import { ArchitectureDecisionsPanel } from '/src/components/ArchitectureDecisionsPanel.tsx';
import { WorkspaceDock } from '/src/components/WorkspaceDock.tsx';
import { useSessionStore, useUIStore } from '/src/stores/index.ts';
import { setActiveSessionLane } from '/src/stores/session-lanes.ts';
await i18n.changeLanguage('en');
await i18n.loadNamespaces('activity');
document.documentElement.lang = 'en';
useSessionStore.setState({ projectRoot: ${JSON.stringify(projectRoot)} });
useUIStore.setState({ dockSection: null, hiddenChips: [] });
setActiveSessionLane('browser-review');
function Fixture() {
  const section = useUIStore(state => state.dockSection);
  return React.createElement('main', {style:{maxWidth:680,margin:'0 auto',padding:16,height:'100dvh',overflowY:'auto'}},
    React.createElement(WorkspaceDock),
    section === 'adr' ? React.createElement(ArchitectureDecisionsPanel, {sessionId:'browser-review'}) : null);
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
`;
const rpc = `export async function invokePortableCommand(name,args) {
  const response = await fetch('/__adr_rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,args})});
  return response.json();
}`;
const plugin = {
  name: 'adr-browser-fixture',
  enforce: 'pre',
  resolveId(id) {
    if (id === 'virtual:adr-browser') return '\0adr-browser.tsx';
    if (id.includes('portable-command-rpc')) return '\0adr-browser-rpc.ts';
  },
  load(id) {
    if (id === '\0adr-browser.tsx') return source;
    if (id === '\0adr-browser-rpc.ts') return rpc;
  },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url === '/__adr_rpc' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        res.setHeader('Content-Type', 'application/json');
        try {
          const { name, args } = JSON.parse(body);
          assert.equal(name, 'adr');
          res.end(JSON.stringify(await command.run(args, { projectRoot })));
        } catch (error) {
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }
      if (req.url?.split('?')[0] !== '/__adr_browser') return next();
      const html = await server.transformIndexHtml(
        req.url,
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:adr-browser"></script></body></html>',
      );
      res.setHeader('Content-Type', 'text/html;charset=utf-8');
      res.end(html);
    });
  },
};
let server;
let browser;
try {
  server = await createServer({
    root: webuiRoot,
    configFile: path.join(webuiRoot, 'vite.config.ts'),
    plugins: [plugin],
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer.address();
  const url = `http://127.0.0.1:${address.port}/__adr_browser`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(url);
  const adrChip = page.getByRole('button', { name: /^ADRs/ });
  const store = new ArchitectureDecisionStore(projectRoot);
  const worker = store.propose(
    {
      title: 'Worker proposal awaiting review',
      context: 'An agent made a lasting choice.',
      decision: 'Review architecture changes explicitly.',
      alternatives: [],
      consequences: [],
      constraints: [],
      scope: [],
      revisitWhen: '',
    },
    'browser-worker',
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: /ADRs.*Pending review: 1/ }).waitFor();
  await page.screenshot({
    path: path.join(reportDir, 'desktop-pending-inbox.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await page.screenshot({ path: path.join(reportDir, 'mobile-pending-inbox.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await adrChip.click();
  await page.getByRole('button', { name: /Worker proposal awaiting review/ }).click();
  await page.getByLabel('Review reason (required)').fill('Reviewed and declined this proposal.');
  await page.getByRole('button', { name: 'Reject proposal', exact: true }).click();
  assert.equal(store.get(worker.id).status, 'rejected');
  await page.getByRole('button', { name: /^ADRs$/ }).waitFor();
  await page.getByRole('button', { name: 'New proposal' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Keep provider adapters outside core');
  await page
    .getByLabel('Context', { exact: true })
    .fill('Core needs a stable provider-independent boundary.');
  await page
    .getByLabel('Decision', { exact: true })
    .fill('Define the provider port in contracts and keep implementations in providers.');
  await page
    .getByLabel('Alternatives', { exact: true })
    .fill('Put adapters directly in core\nUse a shared implementation package');
  await page
    .getByLabel('Consequences', { exact: true })
    .fill('Provider implementations remain replaceable.');
  await page
    .getByLabel('Required constraints', { exact: true })
    .fill('Core must not import provider implementations.\n');
  await page.getByRole('button', { name: 'Add check', exact: true }).click();
  await page.getByLabel('Project-relative file', { exact: true }).fill('contract.txt');
  await page.getByLabel('Condition', { exact: true }).selectOption('contains_text');
  await page.getByLabel('Literal text', { exact: true }).fill('required marker');
  await page.getByRole('button', { name: 'Save proposal' }).click();
  const card = page.getByRole('button', { name: /Keep provider adapters outside core/ });
  await card.waitFor();
  assert.equal(store.list().filter((record) => record.status === 'proposed').length, 1);
  await card.click();
  const accept = page.getByRole('button', { name: 'Accept this revision' });
  await accept.waitFor();
  assert.equal(await accept.isDisabled(), true);
  await page.screenshot({ path: path.join(reportDir, 'desktop-proposal.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
    'Mobile layout must not overflow horizontally',
  );
  await page.screenshot({ path: path.join(reportDir, 'mobile-proposal.png'), fullPage: true });
  await accept.scrollIntoViewIfNeeded();
  assert.equal(
    await accept.isVisible(),
    true,
    'Mobile review actions remain reachable by scrolling',
  );
  await page.screenshot({
    path: path.join(reportDir, 'mobile-review-actions.png'),
    fullPage: true,
  });
  await page
    .getByLabel('Review reason (required)')
    .fill('Reviewed the alternatives and accepted the interface boundary.');
  await accept.click();
  await page.getByRole('status').filter({ hasText: 'Review saved' }).waitFor();
  assert.equal(
    new ArchitectureDecisionStore(projectRoot)
      .list()
      .filter((record) => record.status === 'accepted').length,
    1,
  );
  await page.reload();
  await adrChip.click();
  await card.click();
  await page.getByRole('button', { name: 'Retire decision' }).waitFor();
  await page.getByRole('button', { name: 'Run checks', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Passed' }).waitFor();
  await writeFile(path.join(projectRoot, 'contract.txt'), 'changed contract');
  await page.getByRole('button', { name: 'Run checks', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Failed' }).waitFor();
  await page.getByRole('status').filter({ hasText: 'Failed' }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(reportDir, 'mobile-compliance-failed.png'),
    fullPage: true,
  });
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Markdown' }).click();
  const download = await downloadEvent;
  assert.match(download.suggestedFilename(), /^ADR-.*\.md$/);
  await page.screenshot({ path: path.join(reportDir, 'mobile-accepted.png'), fullPage: true });

  const transferDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download proposal JSON', exact: true }).click();
  const portable = await transferDownload;
  assert.match(portable.suggestedFilename(), /^ADR-.*\.adr\.json$/);
  const bundle = JSON.parse(await readFile(await portable.path(), 'utf8'));
  assert.deepEqual(Object.keys(bundle), ['format', 'version', 'proposal']);
  assert.equal(bundle.proposal.status, undefined);
  assert.equal(bundle.proposal.projectId, undefined);
  assert.equal(bundle.proposal.checks[0].kind, 'contains_text');
  bundle.proposal.title = 'Imported provider boundary';
  const beforeImport = store.list().length;
  await page.getByLabel('ADR proposal JSON file').setInputFiles({
    name: 'shared.adr.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(bundle)),
  });
  const importedTitle = page.getByRole('textbox', { name: 'Title', exact: true });
  await importedTitle.waitFor();
  assert.equal(await importedTitle.inputValue(), 'Imported provider boundary');
  assert.equal(
    await page.getByLabel('Project-relative file', { exact: true }).inputValue(),
    'contract.txt',
  );
  assert.equal(store.list().length, beforeImport, 'Import preview must not write a proposal');
  assert.equal(
    await page.getByRole('button', { name: 'Import proposal JSON', exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await page.screenshot({
    path: path.join(reportDir, 'mobile-import-preview.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Save proposal', exact: true }).click();
  await page.getByRole('button', { name: /Imported provider boundary/ }).waitFor();
  assert.equal(
    store.list().find((record) => record.title === 'Imported provider boundary').status,
    'proposed',
  );
  assert.equal(store.list().filter((record) => record.status === 'accepted').length, 1);
  const predecessor = store.list().find((record) => record.status === 'accepted');
  await card.click();
  await page.getByRole('button', { name: 'Revision history', exact: true }).click();
  await page.getByRole('button', { name: /^Revision 1 · Proposed/ }).click();
  const historical = page.getByRole('region', { name: 'Historical revision', exact: true });
  await historical
    .getByText('Read-only historical snapshot. Agent guidance uses the current accepted decisions.')
    .waitFor();
  assert.equal(await historical.getByRole('button').count(), 0);
  assert.equal(await historical.getByRole('textbox').count(), 0);
  await historical.getByRole('heading', { level: 4 }).scrollIntoViewIfNeeded();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await page.screenshot({
    path: path.join(reportDir, 'mobile-revision-history.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Propose replacement', exact: true }).click();
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Replaces ADR id (optional)', exact: true })
      .inputValue(),
    predecessor.id,
  );
  assert.equal(
    await page.getByLabel('Project-relative file', { exact: true }).inputValue(),
    'contract.txt',
  );
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Revised provider boundary');
  await page
    .getByRole('textbox', { name: 'Decision', exact: true })
    .fill('Use the reviewed adapter boundary version two.');
  await page.getByRole('button', { name: 'Save proposal', exact: true }).click();
  const replacementCard = page.getByRole('button', { name: /Revised provider boundary/ });
  await replacementCard.waitFor();
  const replacement = store.list().find((record) => record.title === 'Revised provider boundary');
  assert.equal(
    store.get(predecessor.id).status,
    'accepted',
    'A replacement proposal must leave its predecessor active',
  );
  assert.equal(replacement.status, 'proposed');
  await replacementCard.click();
  assert.equal(
    await page.getByRole('button', { name: 'Accept this revision', exact: true }).isDisabled(),
    true,
  );
  await page
    .getByLabel('Review reason (required)')
    .fill('Reviewed the replacement and its inherited checks.');
  await page.getByRole('button', { name: 'Accept this revision', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Review saved' }).waitFor();
  assert.equal(store.get(replacement.id).status, 'accepted');
  assert.equal(store.get(predecessor.id).status, 'superseded');
  assert.equal(store.get(predecessor.id).supersededBy, replacement.id);
  assert.equal(store.getRevision(predecessor.id, 2).status, 'accepted');
  await card.click();
  await page.getByRole('button', { name: 'Revision history', exact: true }).click();
  await page.getByRole('button', { name: /^Revision 2 · Accepted/ }).click();
  await historical.getByRole('heading', { level: 4 }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Propose replacement', exact: true }).count(),
    0,
  );
  await historical.getByRole('heading', { level: 4 }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(reportDir, 'mobile-superseded-history.png'),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: proposal inbox, explicit review, compliance, persistence, JSON/Markdown transfer, read-only revision history and explicit replacement acceptance with an atomically superseded predecessor; desktop/mobile geometry; no page errors.',
  );
  console.log(`Screenshots: ${reportDir}`);
} finally {
  await browser?.close();
  await server?.close();
  if (originalHome === undefined) delete process.env.WRONGSTACK_HOME;
  else process.env.WRONGSTACK_HOME = originalHome;
  await rm(scratch, { recursive: true, force: true });
}
