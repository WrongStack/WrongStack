import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

/** A real 1x1 RGBA PNG. */
const NATIVE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

async function startMcpFixture() {
  const calls = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(request.method === 'DELETE' ? 200 : 405);
      response.end();
      return;
    }
    let text = '';
    for await (const chunk of request) {
      text += chunk;
      if (text.length > 65536) {
        response.writeHead(413);
        response.end();
        return;
      }
    }
    const message = JSON.parse(text);
    calls.push({
      method: message.method,
      argumentNames: Object.keys(message.params?.arguments ?? {}),
    });
    if (message.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    let result, error;
    switch (message.method) {
      case 'initialize':
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'native-mcp-fixture', version: '1.0.0' },
        };
        break;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = {
          tools: [
            {
              name: 'native_note',
              description: 'Read a fixture note.',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        };
        break;
      case 'resources/list':
        result = {
          resources: [
            {
              name: 'Native README',
              uri: 'repo://native/readme',
              mimeType: 'text/markdown',
              description: 'Profile-owned resource metadata.',
            },
            { name: 'Missing resource', uri: 'repo://native/missing', mimeType: 'text/plain' },
            { name: 'Native logo', uri: 'repo://native/logo.png', mimeType: 'image/png' },
          ],
        };
        break;
      case 'resources/templates/list':
        result = {
          resourceTemplates: [
            {
              name: 'Native project path',
              uriTemplate: 'repo://native/{path}',
              mimeType: 'text/plain',
            },
          ],
        };
        break;
      case 'resources/read':
        if (message.params.uri === 'repo://native/missing')
          error = { code: -32000, message: 'Native fixture resource is unavailable.' };
        else if (message.params.uri === 'repo://native/logo.png')
          result = {
            contents: [{ uri: message.params.uri, mimeType: 'image/png', blob: NATIVE_PNG }],
          };
        else
          result = {
            contents: [
              {
                uri: message.params.uri,
                mimeType: 'text/markdown',
                text: `# Native MCP resource\n\nExplicit read of ${message.params.uri}. No conversation was created.`,
              },
            ],
          };
        break;
      case 'prompts/list':
        result = {
          prompts: [
            {
              name: 'native-summary',
              title: 'Native summary prompt',
              description: 'Review a parametrized prompt before using it.',
              arguments: [
                { name: 'topic', required: true, description: 'What should be summarized?' },
                { name: 'style', required: false },
              ],
            },
          ],
        };
        break;
      case 'prompts/get':
        result = {
          description: 'Native prompt review fixture.',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Summarize ${message.params.arguments?.topic ?? ''} in ${message.params.arguments?.style || 'plain'} style.`,
              },
            },
          ],
        };
        break;
      default:
        error = { code: -32601, message: 'Method unavailable in native fixture.' };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ jsonrpc: '2.0', id: message.id, ...(error ? { error } : { result }) }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

export async function exerciseNativeMcpContent({ page, rpc, waitFor, artifactDir, configPath }) {
  const fixture = await startMcpFixture();
  const serverName = 'native-content-proof';
  let eventOffset = 0;
  const update = async (payload) => {
    const requestId = crypto.randomUUID();
    await rpc('profile.send', {
      message: { type: 'mcp.update', payload: { name: serverName, ...payload, requestId } },
    });
    return waitFor(
      async () => {
        const batch = await rpc('profile.events', { offset: eventOffset });
        eventOffset = batch.offset;
        const frame = batch.events.find(
          (row) => row.type === 'mcp.operation_result' && row.payload?.requestId === requestId,
        );
        if (!frame) return null;
        assert.notEqual(frame.payload.success, false, frame.payload.message);
        return frame.payload;
      },
      'Canonical MCP peer update',
      45000,
    );
  };
  try {
    assert.equal((await rpc('snapshot')).projects.length, 0);
    assert.equal((await rpc('snapshot')).sessions.length, 0);
    await page
      .getByRole('navigation', { name: 'WrongStack settings sections' })
      .getByRole('button', { name: 'Connected tools', exact: true })
      .click();
    await page.getByRole('button', { name: 'Add connection', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add MCP connection', exact: true });
    await dialog.getByLabel('Connection name', { exact: true }).fill(serverName);
    await dialog.getByLabel('MCP server URL', { exact: true }).fill(fixture.url);
    await dialog.getByLabel('Allow private MCP network addresses', { exact: true }).check();
    await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.mcpServers[serverName].transport, 'streamable-http');
    assert.equal(config.mcpServers[serverName].allowPrivateNetworks, true);
    assert.equal(config.mcpServers[serverName].enabled, false);
    const card = page
      .locator('.integration-card')
      .filter({ has: page.getByRole('heading', { name: serverName, exact: true }) });
    await card.getByRole('button', { name: 'Enable', exact: true }).click();
    await card
      .locator('.integration-status')
      .filter({ hasText: 'connected' })
      .waitFor({ timeout: 90000 });
    await card.getByText('1 tools available', { exact: true }).waitFor();
    await update({
      env: { SECRET_UI_TOKEN: 'fixture-mcp-secret-kept-in-config' },
      headers: { Authorization: 'Bearer fixture-mcp-header' },
    });
    await card.getByRole('button', { name: `Restart ${serverName}`, exact: true }).click();
    await card.getByRole('button', { name: 'Edit connection', exact: true }).click();
    const editor = page.getByRole('dialog', {
      name: `Edit MCP connection ${serverName}`,
      exact: true,
    });
    await editor
      .getByLabel('MCP connection description', { exact: true })
      .fill('Native changed-fields connection');
    await update({ url: `${fixture.url}?peer=1` });
    await page.screenshot({
      path: join(artifactDir, 'native-mcp-connection-edit.png'),
      fullPage: true,
    });
    await editor.getByRole('button', { name: 'Save connection changes', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    await card.getByText('Native changed-fields connection', { exact: true }).waitFor();
    let saved = JSON.parse(await readFile(configPath, 'utf8')).mcpServers[serverName];
    assert.equal(saved.url, `${fixture.url}?peer=1`, 'Unedited concurrent endpoint survives');
    assert.equal(saved.description, 'Native changed-fields connection');
    assert.equal(saved.allowPrivateNetworks, true);
    assert.equal(saved.headers.Authorization, 'Bearer fixture-mcp-header');
    assert.equal(saved.env.SECRET_UI_TOKEN, 'fixture-mcp-secret-kept-in-config');
    assert.equal(
      (await page.locator('body').innerText()).includes('fixture-mcp-secret-kept-in-config'),
      false,
    );
    await card.getByRole('button', { name: 'Edit connection', exact: true }).click();
    await editor
      .getByLabel('MCP connection description', { exact: true })
      .fill('Keep this local connection edit');
    await update({ description: 'Peer saved connection description' });
    await editor.getByRole('button', { name: 'Save connection changes', exact: true }).click();
    await editor.getByRole('alert').filter({ hasText: 'changed elsewhere' }).waitFor();
    assert.equal(
      await editor.getByLabel('MCP connection description', { exact: true }).inputValue(),
      'Keep this local connection edit',
    );
    saved = JSON.parse(await readFile(configPath, 'utf8')).mcpServers[serverName];
    assert.equal(saved.description, 'Peer saved connection description');
    await editor.getByRole('button', { name: 'Close MCP connection editor', exact: true }).click();
    await editor.getByRole('button', { name: 'Keep editing connection', exact: true }).click();
    await editor.getByRole('button', { name: 'Reload stored connection', exact: true }).click();
    await editor
      .getByRole('button', { name: 'Discard edits and reload connection', exact: true })
      .click();
    await waitFor(
      async () =>
        (await editor.getByLabel('MCP connection description', { exact: true }).inputValue()) ===
        'Peer saved connection description',
      'Explicit MCP connection reload',
    );
    await editor.getByRole('button', { name: 'Close MCP connection editor', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
    await card.getByRole('button', { name: 'Browse resources & prompts', exact: true }).click();
    const browser = page.getByRole('dialog', {
      name: `MCP content from ${serverName}`,
      exact: true,
    });
    const readCalls = () =>
      fixture.calls.filter(
        (call) => call.method === 'resources/read' || call.method === 'prompts/get',
      );
    await browser.getByRole('button').filter({ hasText: 'Native README' }).waitFor();
    assert.equal(readCalls().length, 0, 'Opening metadata never reads remote content');
    await browser.getByRole('button').filter({ hasText: 'Native README' }).click();
    assert.equal(readCalls().length, 0, 'Choosing metadata still requires explicit resource read');
    await browser.getByRole('button', { name: 'Read resource', exact: true }).click();
    await browser.getByRole('heading', { name: 'Native MCP resource', exact: true }).waitFor();
    await browser
      .getByText('External MCP content · explicit selection · repo://native/readme', {
        exact: true,
      })
      .waitFor();
    await browser.getByRole('button').filter({ hasText: 'Missing resource' }).click();
    await browser.getByRole('button', { name: 'Read resource', exact: true }).click();
    await browser
      .getByRole('alert')
      .filter({ hasText: 'Native fixture resource is unavailable' })
      .waitFor();
    // Binary resources: a raster preview from the bytes and a byte-exact saved file.
    await browser.getByRole('button').filter({ hasText: 'Native logo' }).click();
    await browser.getByRole('button', { name: 'Read resource', exact: true }).click();
    const preview = browser.getByRole('img', {
      name: 'MCP content preview, image/png',
      exact: true,
    });
    await preview.waitFor();
    assert.equal(await preview.evaluate((image) => image.naturalWidth), 1, 'The PNG decodes');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: artifactDir });
    await rm(join(artifactDir, 'logo.png'), { force: true });
    await browser.getByRole('button', { name: 'Save logo.png', exact: true }).click();
    const savedLogo = await waitFor(
      () => readFile(join(artifactDir, 'logo.png')).catch(() => null),
      'Saved MCP binary file',
      15000,
    );
    assert.equal(savedLogo.toString('base64'), NATIVE_PNG, 'The saved file has the exact bytes');
    await cdp.detach();
    await browser.getByRole('button').filter({ hasText: 'Native project path' }).click();
    await browser.getByLabel('MCP resource URI', { exact: true }).fill('repo://native/notes');
    await browser.getByRole('button', { name: 'Read resource', exact: true }).click();
    await browser
      .getByText('Explicit read of repo://native/notes. No conversation was created.', {
        exact: true,
      })
      .waitFor();
    await browser.getByRole('button').filter({ hasText: 'Native summary prompt' }).click();
    await browser
      .getByLabel('MCP prompt argument topic', { exact: true })
      .fill('native project boundaries');
    await browser.getByLabel('MCP prompt argument style', { exact: true }).fill('concise');
    await browser.getByRole('button', { name: 'Resolve prompt for review', exact: true }).click();
    await browser
      .getByText('Summarize native project boundaries in concise style.', { exact: true })
      .waitFor();
    assert.deepEqual(
      fixture.calls.findLast((call) => call.method === 'prompts/get').argumentNames.sort(),
      ['style', 'topic'],
    );
    await page.screenshot({ path: join(artifactDir, 'native-mcp-content.png'), fullPage: true });
    await page.setViewportSize({ width: 800, height: 640 });
    const bounds = await browser.boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 640);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: join(artifactDir, 'native-mcp-content-compact.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1480, height: 960 });
    await browser.getByRole('button', { name: 'Close MCP content', exact: true }).click();
    await browser.getByRole('button', { name: 'Keep browsing MCP content', exact: true }).click();
    assert.equal(
      await browser.getByLabel('MCP prompt argument topic', { exact: true }).inputValue(),
      'native project boundaries',
    );
    await browser.getByRole('button', { name: 'Close MCP content', exact: true }).click();
    await browser
      .getByRole('button', { name: 'Discard MCP inputs and close', exact: true })
      .click();
    await browser.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
    await card.getByRole('button', { name: `Remove ${serverName}`, exact: true }).click();
    await card.getByRole('button', { name: 'Remove connection', exact: true }).click();
    await waitFor(async () => !(await card.count()), 'Native MCP fixture removal');
    assert.equal((await rpc('snapshot')).projects.length, 0);
    assert.equal((await rpc('snapshot')).sessions.length, 0);
    // A saved file shows WebView2's own downloads flyout as a target; it is not an app window.
    assert.deepEqual(
      page
        .context()
        .pages()
        .map((item) => item.url())
        .filter((url) => !url.startsWith('edge://downloads')),
      [page.url()],
    );
    console.log(
      'PASS: real loopback MCP, typed connection changed-field save/readback, unrelated peer endpoint and hidden credential/policy preservation, same-field conflict/explicit reload, resource/template/prompt metadata and explicit content, correlated errors/provenance/compact layout without projects or sessions',
    );
  } finally {
    await fixture.close();
  }
}

export async function exerciseNativeMcpComposer({
  page,
  rpc,
  waitFor,
  artifactDir,
  project,
  sessionIds,
}) {
  const fixture = await startMcpFixture(),
    name = 'native-composer-content';
  let offset = 0;
  const profile = async (type, payload) => {
    const requestId = crypto.randomUUID();
    await rpc('profile.send', { message: { type, payload: { ...payload, name, requestId } } });
    await waitFor(
      async () => {
        const batch = await rpc('profile.events', { offset });
        offset = batch.offset;
        const frame = batch.events.find((row) => row.payload?.requestId === requestId);
        if (!frame) return null;
        assert.equal(frame.type, 'mcp.operation_result');
        assert.notEqual(frame.payload.success, false, frame.payload.message);
        return true;
      },
      type,
      60000,
    );
  };
  try {
    await profile('mcp.add', {
      transport: 'streamable-http',
      url: fixture.url,
      enabled: true,
      allowPrivateNetworks: true,
    });
    const session = await rpc('session.open', {
      projectId: project.id,
      kind: 'agent',
      title: 'MCP content draft owner',
    });
    sessionIds.push(session.id);
    await page.locator('.tree-session').filter({ hasText: 'MCP content draft owner' }).click();
    const draft = page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
    await draft.waitFor({ timeout: 100000 });
    await draft.fill('Keep my existing draft.');
    const open = async () => {
      await page
        .locator('.composer-options')
        .getByLabel('Composer options', { exact: true })
        .click();
      await page.getByRole('button', { name: 'MCP resources & prompts', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Add MCP content to draft', exact: true })
        .getByRole('button')
        .filter({ hasText: name })
        .click();
      return page.getByRole('dialog', { name: `MCP content from ${name}`, exact: true });
    };
    let browser = await open();
    await browser.getByRole('button').filter({ hasText: 'Native README' }).click();
    assert.equal(fixture.calls.filter((row) => row.method === 'resources/read').length, 0);
    await browser.getByRole('button', { name: 'Read resource', exact: true }).click();
    await browser.getByRole('heading', { name: 'Selected content', exact: true }).waitFor();
    await page.screenshot({
      path: join(artifactDir, 'native-mcp-composer-review.png'),
      fullPage: true,
    });
    await browser.getByRole('button', { name: 'Append text to draft', exact: true }).click();
    await browser.waitFor({ state: 'detached' });
    await waitFor(
      async () => (await draft.inputValue()).includes('External MCP resource from'),
      'Resource appended to existing draft',
    );
    const resourceDraft = await draft.inputValue();
    assert.ok(resourceDraft.startsWith('Keep my existing draft.'));
    assert.ok(resourceDraft.includes('repo://native/readme'));
    assert.equal(
      (await rpc('engine.events', { id: session.id, offset: 0 })).events.some(
        (event) => event.type === 'desktop.user_message',
      ),
      false,
    );
    browser = await open();
    await browser.getByRole('button').filter({ hasText: 'Native summary prompt' }).click();
    await browser
      .getByLabel('MCP prompt argument topic', { exact: true })
      .fill('the native composer');
    await browser.getByRole('button', { name: 'Resolve prompt for review', exact: true }).click();
    await browser.getByRole('button', { name: 'Append text to draft', exact: true }).click();
    await browser.waitFor({ state: 'detached' });
    await waitFor(
      async () => (await draft.inputValue()).includes('[Remote prompt role: user]'),
      'Prompt appended with remote role as text',
    );
    assert.ok((await draft.inputValue()).startsWith(resourceDraft));
    await page.reload();
    await draft.waitFor();
    assert.ok((await draft.inputValue()).includes('the native composer'));
    assert.equal(fixture.calls.filter((row) => row.method === 'tools/call').length, 0);
    assert.equal(page.context().pages().length, 1);
    await profile('mcp.remove', {});
    console.log(
      'PASS: native composer explicitly reads MCP resources/resolves prompt arguments, appends attributed text to the existing durable draft without invoking a tool or sending a message',
    );
  } finally {
    await fixture.close();
  }
}
