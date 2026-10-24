// Production UI -> real WebSocket -> production route handlers/registry ->
// local HTTP MCP server. No paid provider, user profile or original tool replay.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { EventBus } from '@wrongstack/contracts/kernel';
import { ToolRegistry } from '@wrongstack/core/registry';
import { createServer } from 'vite';
import { WebSocketServer } from 'ws';
import { MCPRegistry } from '../../mcp/dist/index.js';
import { handleMcpRoute } from '../../webui-server/src/server/mcp-routes.ts';
import { createMcpTaskHandlers } from '../../webui-server/src/server/mcp-task-handlers.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(root, '../..');
const output = path.join(repository, '.temp_files/task-live-ui');
const base = await realpath(os.tmpdir());
const directory = await mkdtemp(path.join(base, 'wrongstack-mcp-task-browser-'));
assert.equal(path.dirname(directory), base);
assert.ok(path.basename(directory).startsWith('wrongstack-mcp-task-browser-'));
const states = new Map(),
  polls = new Map(),
  calls = [],
  delivered = [];
let grant = 'account-a';
const now = new Date().toISOString();
const upstream = createHttpServer(async (req, res) => {
  let raw = '';
  for await (const bytes of req) raw += bytes.toString();
  const m = JSON.parse(raw);
  calls.push(m.method);
  let result;
  if (m.method === 'server/discover')
    result = {
      resultType: 'complete',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } },
    };
  else if (m.method === 'tools/list')
    result = {
      resultType: 'complete',
      tools: ['compile', 'index', 'private_scan'].map((name) => ({
        name,
        inputSchema: { type: 'object' },
      })),
    };
  else if (m.method === 'tools/call') {
    const id = m.params.arguments.id;
    states.set(id, 'working');
    result = {
      resultType: 'task',
      taskId: id,
      status: 'working',
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: null,
      pollIntervalMs: 100,
    };
  } else if (m.method === 'tasks/cancel') result = { resultType: 'complete' };
  else {
    const id = m.params.taskId;
    polls.get(id)?.();
    const status = states.get(id);
    result = {
      resultType: 'complete',
      taskId: id,
      status,
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: null,
      pollIntervalMs: 100,
      ...(status === 'completed'
        ? { result: { content: [{ type: 'text', text: 'Recovered index' }] } }
        : {}),
    };
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const tools = new ToolRegistry(),
  events = new EventBus();
const opts = {
  toolRegistry: tools,
  events,
  log: { info() {}, warn() {}, error() {}, debug() {} },
  cwd: directory,
  taskJournalDir: path.join(directory, 'tasks'),
  authorizationProviderFactory: () => ({
    getAccessToken: async () => undefined,
    getTaskIdentity: async () => grant,
  }),
};
const first = new MCPRegistry(opts),
  registry = new MCPRegistry({ ...opts, toolRegistry: new ToolRegistry() });
const contexts = new Map();
for (const width of [1440, 390])
  for (const tab of ['a', 'b']) {
    const id = `tab-${tab}-${width}`;
    contexts.set(id, {
      session: { id },
      agentId: 'leader',
      signal: new AbortController().signal,
      requestUserInput: async () => {
        throw new Error('Unexpected input');
      },
      state: { appendMessage: (message) => delivered.push({ sessionId: id, message }) },
    });
  }
const config = {
  name: 'builder',
  transport: 'streamable-http',
  url: `http://127.0.0.1:${upstream.address().port}/mcp`,
  allowPrivateNetworks: true,
};
const virtualId = 'virtual:mcp-tasks-smoke';
const source = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/index.css';
import { i18n } from '/src/i18n/index.ts';
import { ThemeProvider } from '/src/components/ThemeProvider.tsx';
import { MCPSection } from '/src/components/SettingsPanel/MCPSection.tsx';
import { useConfigStore } from '/src/stores/config-store.ts';
import { setActiveSessionLane } from '/src/stores/session-lanes.ts';
import { getWSClient } from '/src/lib/ws-client.ts';
await i18n.changeLanguage('en'); await i18n.loadNamespaces(['settings','common']);
const width = new URLSearchParams(location.search).get('width');
const listeners = new Map(), client = getWSClient();
const socket = new WebSocket(location.origin.replace('http','ws') + '/__mcp_tasks');
const requests = [];
const emit = message => { for (const callback of listeners.get(message.type) || []) callback(message); };
socket.onmessage = event => emit(JSON.parse(event.data));
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
client.on = (type, callback) => { const list = listeners.get(type) || new Set(); list.add(callback); listeners.set(type, list); return () => list.delete(callback); };
Object.defineProperty(client, 'isConnected', { get: () => true });
client.send = message => {
  if(message.type === 'mcp.list') { queueMicrotask(() => emit({type:'mcp.list',payload:{servers:[]}})); return true; }
  if(!message.type.startsWith('mcp.tasks.')) return true;
  requests.push(message); if(socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
};
setActiveSessionLane('tab-a-' + width); useConfigStore.setState({wsConnected:true});
window.__tasks = { requests, switchTab: tab => setActiveSessionLane('tab-' + tab + '-' + width), disconnected: value => useConfigStore.setState({wsConnected:!value}) };
createRoot(document.getElementById('root')).render(<ThemeProvider><main className="mx-auto max-w-4xl p-4"><MCPSection/></main></ThemeProvider>);
`;
const taskHandlers = createMcpTaskHandlers({ registry, context: (id) => contexts.get(id) });
const sockets = new WebSocketServer({ noServer: true });
sockets.on('connection', (socket) => {
  socket.on('message', (raw) => {
    void handleMcpRoute(socket, JSON.parse(String(raw)), taskHandlers).catch((error) => {
      console.error(error);
      socket.close();
    });
  });
});
const vite = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, fs: { allow: [repository] } },
  plugins: [
    {
      name: 'mcp-task-smoke',
      resolveId: (id) => (id === virtualId ? `\0${virtualId}.tsx` : undefined),
      load: (id) =>
        id === `\0${virtualId}.tsx`
          ? new Bun.Transpiler({
              loader: 'tsx',
              tsconfig: { compilerOptions: { jsx: 'react' } },
            }).transformSync(source)
          : undefined,
      configureServer(server) {
        server.httpServer.on('upgrade', (req, socket, head) => {
          if (req.url === '/__mcp_tasks')
            sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit('connection', ws));
        });
        server.middlewares.use(async (req, res, next) => {
          if (req.url === '/favicon.ico') {
            res.writeHead(204).end();
            return;
          }
          if (!req.url?.startsWith('/__task_ui')) return next();
          res.setHeader('content-type', 'text/html');
          res.end(
            await server.transformIndexHtml(
              req.url,
              `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/${virtualId}"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
let browser;
const errors = [],
  observations = [];
try {
  await mkdir(output, { recursive: true });
  await first.start(config);
  const running = [];
  for (const width of [1440, 390])
    for (const [tab, tool] of [
      ['a', 'compile'],
      ['a', 'index'],
      ['b', 'private_scan'],
    ]) {
      const id = `${tool}-${width}`;
      let resolvePoll;
      const polled = new Promise((resolve) => {
        resolvePoll = resolve;
      });
      polls.set(id, resolvePoll);
      const promise = tools
        .list()
        .find((t) => t.name === `mcp__builder__${tool}`)
        .execute({ id }, contexts.get(`tab-${tab}-${width}`), {});
      void promise.catch(() => undefined);
      running.push(promise);
      let timeout;
      try {
        await Promise.race([
          polled,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Initial poll timed out')), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }
  await first.stopAll();
  await Promise.allSettled(running);
  await registry.start(config);
  await vite.listen();
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) {
    grant = 'account-a';
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    // LAN HTTP deployments do not expose this secure-context API.
    if (width === 390)
      await page.addInitScript(() =>
        Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }),
      );
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__task_ui?width=${width}`, {
      waitUntil: 'networkidle',
    });
    await page.getByRole('tab', { name: 'MCP tasks' }).click();
    const panel = page.getByRole('region', { name: 'MCP tasks' });
    await expect(panel.getByText('builder / compile')).toBeVisible();
    await expect(panel.getByText('builder / private_scan')).toHaveCount(0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({
      path: path.join(output, `tasks-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    states.set(`index-${width}`, 'completed');
    await panel
      .locator('article')
      .filter({ hasText: 'builder / index' })
      .getByRole('button', { name: 'Retry recovery' })
      .click();
    await expect
      .poll(() => delivered.filter((d) => d.sessionId === `tab-a-${width}`).length, {
        timeout: 5000,
      })
      .toBe(1);
    await expect(panel.getByText('Completed', { exact: true })).toBeVisible({ timeout: 3000 });
    await expect(panel.getByText('Result collected', { exact: true })).toBeVisible({
      timeout: 3000,
    });
    const compile = panel.locator('article').filter({ hasText: 'builder / compile' });
    await compile.getByRole('button', { name: 'Cancel task', exact: true }).click();
    await expect(compile.getByRole('button', { name: 'Cancel requested' })).toBeDisabled();
    await expect(compile.getByText('Working', { exact: true })).toBeVisible();
    states.set(`compile-${width}`, 'cancelled');
    await registry.recoverTasks(contexts.get(`tab-a-${width}`));
    await expect(compile.getByText('Cancelled', { exact: true })).toBeVisible({ timeout: 3000 });
    assert.equal(
      await page.evaluate(
        () => window.__tasks.requests.filter((m) => m.type === 'mcp.tasks.list').length,
      ),
      1,
    );
    await page.screenshot({
      path: path.join(output, `tasks-live-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    await page.evaluate(() => window.__tasks.switchTab('b'));
    await expect(panel.getByText('builder / private_scan')).toBeVisible();
    await expect(panel.getByText('builder / compile')).toHaveCount(0);
    grant = 'account-b';
    await panel.getByRole('button', { name: 'Cancel task', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText(
      'Check the server connection and active account',
    );
    await page.screenshot({
      path: path.join(output, `tasks-error-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    await page.evaluate(() => window.__tasks.disconnected(true));
    await expect(panel.getByText('Reconnect to manage tasks.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Cancel task', exact: true })).toBeDisabled();
    observations.push({
      width,
      scopedList: true,
      recovered: true,
      liveStatusAndResultWithoutRefresh: true,
      initialListRequests: 1,
      cancellationAcknowledgedBeforeTerminal: true,
      accountMismatchRejected: true,
    });
    await page.close();
  }
  assert.equal(calls.filter((m) => m === 'tools/call').length, 6);
  assert.equal(calls.filter((m) => m === 'tasks/cancel').length, 2);
  assert.deepEqual(errors, []);
  const result = {
    observations,
    originalToolCalls: 6,
    cancellationRequests: 2,
    browserErrors: errors,
  };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise((resolve) => sockets.close(resolve));
  await vite.close();
  await first.stopAll();
  await registry.stopAll();
  await new Promise((resolve) => {
    upstream.closeAllConnections();
    upstream.close(resolve);
  });
  await rm(directory, { recursive: true, force: true });
}
