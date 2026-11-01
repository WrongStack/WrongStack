import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startMcpFixture } from './native-mcp-content.mjs';

/**
 * A user runs an MCP tool from the composer: it becomes a step of the
 * conversation (approval when the profile asks for one), the server receives
 * exactly one call, and the next provider request carries its result.
 */
export async function exerciseNativeMcpTool({
  page,
  rpc,
  waitFor,
  artifactDir,
  project,
  sessionIds,
  providerFixture,
}) {
  const fixture = await startMcpFixture(),
    name = 'native-tool-runner';
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
      title: 'MCP tool runner',
    });
    sessionIds.push(session.id);
    await page.locator('.tree-session').filter({ hasText: 'MCP tool runner' }).click();
    const draft = page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
    await draft.waitFor({ timeout: 100000 });
    await page.locator('.composer-options').getByLabel('Composer options', { exact: true }).click();
    await page.getByRole('button', { name: 'MCP resources & prompts', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Add MCP content to draft', exact: true })
      .getByRole('button', { name: `Run tools from ${name}`, exact: true })
      .click();
    const runner = page.getByRole('dialog', { name: `MCP tools from ${name}`, exact: true });
    await runner.getByRole('button').filter({ hasText: 'native_note' }).click();
    assert.equal(await runner.getByLabel('Tool input', { exact: true }).inputValue(), '{}');
    await runner.getByLabel('Tool input', { exact: true }).fill('[1]');
    await runner.getByRole('button', { name: 'Run in this conversation', exact: true }).click();
    await runner.getByText('The input must be a JSON object.', { exact: true }).waitFor();
    await runner.getByLabel('Tool input', { exact: true }).fill('{}');
    await page.screenshot({
      path: join(artifactDir, 'native-mcp-tool-runner.png'),
      fullPage: true,
    });
    assert.equal(fixture.calls.filter((row) => row.method === 'tools/call').length, 0);
    await runner.getByRole('button', { name: 'Run in this conversation', exact: true }).click();
    await runner.waitFor({ state: 'detached' });
    // The harness profile runs without YOLO, so the call stops at the conversation's approval
    // card and reaches the server only after it is allowed.
    const notice = page.locator('.composer-notice').filter({ hasText: 'native_note' });
    const allow = page.getByRole('button', { name: 'Allow once', exact: true });
    await allow.first().waitFor({ timeout: 90000 });
    await page.screenshot({
      path: join(artifactDir, 'native-mcp-tool-approval.png'),
      fullPage: true,
    });
    assert.equal(fixture.calls.filter((row) => row.method === 'tools/call').length, 0);
    await allow.first().click();
    await notice
      .filter({ hasText: 'Its result is in the conversation' })
      .waitFor({ timeout: 90000 });
    assert.equal(fixture.calls.filter((row) => row.method === 'tools/call').length, 1);
    await page
      .locator('.native-chat-messages')
      .getByText('Native fixture note: the tool ran.', { exact: false })
      .waitFor();
    await page.screenshot({
      path: join(artifactDir, 'native-mcp-tool-result.png'),
      fullPage: true,
    });
    const before = providerFixture.calls.length;
    await draft.fill('[native-mcp-tool-followup] What did the tool say?');
    await draft.press('Enter');
    const keep = page.getByRole('button', { name: 'Keep original draft', exact: true });
    await waitFor(
      async () => {
        if (providerFixture.calls.slice(before).some((call) => call.userRunMcpTool)) return true;
        // Prompt refinement may review the message first; send it as written.
        if ((await keep.count()) > 0) await keep.first().click();
        return false;
      },
      'Next provider request carries the user-run tool result',
      90000,
    );
    await profile('mcp.remove', {});
    console.log(
      'PASS: native composer runs an MCP tool as a conversation step: it waits at the approval card with no server call, runs once on Allow once, and the next request carries the result',
    );
  } finally {
    await fixture.close();
  }
}
