import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findConversationMessages } from './transcript-test-helpers.mjs';

const instruction = (body) =>
  (body.messages ?? [])
    .filter((message) => message.role === 'user')
    .flatMap((message) =>
      typeof message.content === 'string'
        ? [message.content]
        : (message.content ?? [])
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? ''),
    )
    .findLast((text) => /^\[native-composer-/.test(text.trim()));

/** Only the provider's tool choice is controlled; the packaged read/discovery tools execute. */
export function resolveNativeReadingToolCall(body) {
  if (!body.stream || !instruction(body)?.startsWith('[native-composer-reading-tool]'))
    return undefined;
  const id = 'native-reading-read';
  if (body.messages.some((message) => message.role === 'tool' && message.tool_call_id === id))
    return undefined;
  const searched = body.messages.some(
    (message) => message.role === 'tool' && message.tool_call_id === id + '-search',
  );
  const offered = body.tools?.some((tool) => tool.function?.name === 'read');
  const name = offered || searched ? 'read' : 'tool_search';
  assert.ok(
    offered || searched || body.tools?.some((tool) => tool.function?.name === 'tool_search'),
  );
  return {
    index: 0,
    id: name === 'read' ? id : id + '-search',
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(name === 'read' ? { path: 'README.md' } : { query: 'read' }),
    },
  };
}

const position = (id) => {
  const pane = document.querySelector('.native-chat-messages');
  const row = document.querySelector(`[data-message-id="${id}"]`);
  const detail = row?.closest('.transcript-row')?.querySelector('details.chat-run-activity');
  return {
    offset: row ? row.getBoundingClientRect().top - pane.getBoundingClientRect().top : null,
    scrollTop: pane?.scrollTop,
    height: pane?.clientHeight,
    scrollHeight: pane?.scrollHeight,
    open: !!detail?.open,
    mountedMessages: pane?.querySelectorAll('.chat-message').length,
  };
};
const nearEnd = () => {
  const pane = document.querySelector('.native-chat-messages');
  return pane && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 5;
};
const settle = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

/** Native Files/Run visits exercise the actual engine journal and retained virtual transcript. */
export async function exerciseNativeReadingPosition({
  page,
  rpc,
  project,
  waitFor,
  providerFixture,
  artifactDir,
  sessionIds,
}) {
  const checks = [],
    samples = [],
    frames = [];
  const receipt = { checks, samples };
  const pass = (text) => {
    checks.push(text);
    console.log('PASS: ' + text);
  };
  const agent = await rpc('session.open', {
    projectId: project.id,
    kind: 'agent',
    title: 'Reading continuity',
  });
  receipt.agent = agent;
  sessionIds.push(agent.id);
  let offset = 0;
  const pump = async () => {
    for (;;) {
      const previous = offset;
      const batch = await rpc('engine.events', { id: agent.id, offset });
      offset = batch.offset;
      frames.push(...batch.events);
      if (!(batch.hasMore ?? batch.events.length === 200) || offset === previous) break;
    }
  };
  const identity = await waitFor(
    async () => {
      const value = await rpc('engine.identity', { id: agent.id });
      return value.sessionId ? value : null;
    },
    'Reading engine identity',
    100000,
  );
  const call = async (type, payload, replies) => {
    const requestId = crypto.randomUUID();
    await rpc('engine.send', {
      id: agent.id,
      message: { type, payload: { ...payload, requestId } },
    });
    return waitFor(
      async () => {
        await pump();
        const event = frames.find(
          (item) =>
            item.payload?.requestId === requestId &&
            (replies.includes(item.type) || item.type === 'error'),
        );
        if (event?.type === 'error' || event?.payload?.error || event?.payload?.success === false)
          throw Error(JSON.stringify(event));
        return event?.payload;
      },
      type,
      60000,
    );
  };
  await call('prefs.update', { autonomy: 'off', enhanceEnabled: false }, ['key.operation_result']);
  const prefs = await call('prefs.get', {}, ['prefs.updated']);
  assert.equal(prefs.autonomy, 'off');
  assert.equal(prefs.enhanceEnabled, false);
  await page.locator('.tree-session').filter({ hasText: agent.title }).click();
  await page.locator(`[data-engine-session="${identity.sessionId}"]`).waitFor();
  const pane = page.locator('.native-chat-messages');
  const nav = page.getByRole('navigation', { name: 'Agent workspace views' });
  const chat = nav.getByRole('button', { name: 'Chat', exact: true });
  const composer = page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  const start = async (content) => {
    await pump();
    const from = frames.length;
    const id = crypto.randomUUID();
    await rpc('engine.send', {
      id: agent.id,
      message: {
        type: 'user_message',
        payload: {
          id,
          requestId: crypto.randomUUID(),
          content: `${content}\n[native-composer-reading-finished]`,
          timestamp: Date.now(),
        },
      },
    });
    return { from, id };
  };
  const finish = async (turn) => {
    const result = await waitFor(
      async () => {
        await pump();
        return frames
          .slice(turn.from)
          .find((event) => event.type === 'run.result' && event.payload?.requestId === turn.id)
          ?.payload;
      },
      'Actual reading turn completed',
      90000,
    );
    assert.equal(result.status, 'done', JSON.stringify(result));
    assert.ok(
      result.iterations > 0,
      'Every expected reply actually ran, rather than being deduplicated',
    );
    await waitFor(
      async () => (await page.locator('.agent-working').count()) === 0,
      'The native renderer has consumed the run result',
      60000,
    );
  };
  const send = async (content) => finish(await start(content));
  const visit = async (tool) => {
    if (tool === 'Files') {
      await nav.getByRole('button', { name: 'Files', exact: true }).click();
      await page.getByRole('treeitem', { name: 'README.md', exact: true }).waitFor();
    } else {
      await nav.getByRole('button', { name: 'Tools', exact: true }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /Run activity/ })
        .click();
      await page.locator('.session-activity:not(.session-activity-compact)').waitFor();
    }
    assert.equal(await pane.count(), 1, 'The native transcript stays mounted during tools');
    assert.equal(await pane.isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'Pin message', exact: true }).count(), 0);
  };
  const back = async () => {
    await chat.press('Enter');
    await pane.waitFor();
    await settle(page);
    assert.equal(await chat.evaluate((button) => document.activeElement === button), true);
  };
  const assertDraft = async () => {
    const text = await page.evaluate(
      async (id) =>
        (
          await window.__TAURI_INTERNALS__.invoke('host_request', {
            method: 'draft.get',
            params: { id },
          })
        ).text,
      agent.id,
    );
    assert.equal(text, 'Keep this native reading draft.');
  };
  try {
    for (let index = 0; index < 10; index++) {
      await send(
        index === 2
          ? '[native-composer-reading-tool] Read README.md, then answer briefly.'
          : `[native-composer-reading-${index}] Answer briefly for retained reading row ${index}.`,
      );
    }
    assert.ok(
      frames.some((event) => event.type === 'tool.executed' && event.payload?.name === 'read'),
      'The real read tool provides the completed disclosure',
    );
    await page.waitForFunction(nearEnd);
    pass(
      'Ten actual native turns and a real read tool populate the virtual transcript; initial view follows latest',
    );
    const fold = page.locator('.composer-fold-controls > button').first();
    if (!(await composer.isVisible())) await fold.click();
    await composer.fill('Keep this native reading draft.');
    await waitFor(async () => {
      const saved = await page.evaluate(
        async (id) =>
          (
            await window.__TAURI_INTERNALS__.invoke('host_request', {
              method: 'draft.get',
              params: { id },
            })
          ).text,
        agent.id,
      );
      return saved === 'Keep this native reading draft.';
    }, 'Native draft saved');
    if (await composer.isVisible()) await fold.click();

    for (const viewport of [
      { width: 1280, height: 840 },
      { width: 800, height: 600 },
    ]) {
      await page.setViewportSize(viewport);
      if (await composer.isVisible()) await fold.click();
      await settle(page);
      await pane.hover();
      await page.mouse.wheel(0, -1200);
      await page.getByRole('button', { name: /^Jump to latest(?:\s|$)/ }).waitFor();
      const [anchorId] = await findConversationMessages(page, '[native-composer-reading-tool]', 1);
      const anchor = page.locator(`[data-message-id="${anchorId}"]`);
      const detail = anchor.locator('..').locator('details.chat-run-activity');
      await detail.waitFor({ state: 'attached' });
      if ((await detail.getAttribute('open')) === null)
        await detail.locator(':scope > summary').click();
      await settle(page);
      const before = await page.evaluate(position, anchorId);
      assert.equal(before.open, true);
      assert.ok(before.offset !== null && before.offset >= -20 && before.offset < before.height);
      assert.ok(
        before.scrollHeight - before.scrollTop - before.height > 100,
        'Older reading is paused',
      );
      assert.ok(before.mountedMessages < 20, 'Only the virtual range is mounted');
      for (let repeat = 0; repeat < 3; repeat++) {
        for (const tool of ['Files', 'Run activity']) {
          await visit(tool);
          if (tool === 'Run activity') {
            const from = await start(
              `[native-composer-hold-reading] Continue the native reading check ${viewport.width}/${repeat}.`,
            );
            await waitFor(
              () => providerFixture.holds.has('reading'),
              'Real provider response held',
            );
            await waitFor(
              async () => (await page.locator('.agent-working').count()) > 0,
              'The retained renderer observes the held reading turn',
              60000,
            );
            providerFixture.releaseHold('reading');
            await finish(from);
          }
          await back();
          const after = await page.evaluate(position, anchorId);
          samples.push({ viewport, repeat, tool, before, after });
          assert.ok(
            after.offset !== null && Math.abs(after.offset - before.offset) <= 2,
            `${tool} preserves the older row within 2 CSS px: ${JSON.stringify({ before, after })}`,
          );
          assert.equal(after.open, true, 'The completed tool disclosure remains open');
          await assertDraft();
        }
      }
      await page.getByRole('button', { name: /Jump to latest.*new/ }).waitFor();
      await page.screenshot({
        path: join(artifactDir, `native-reading-paused-${viewport.width}.png`),
        fullPage: true,
      });
      pass(
        `${viewport.width}×${viewport.height}: three Files/Run returns preserve paused position, open details, focus and draft during actual replies`,
      );
      await page.getByRole('button', { name: /^Jump to latest(?:\s|$)/ }).click();
      await page.waitForFunction(nearEnd);
      const from = await start(
        `[native-composer-hold-following] Continue while following the latest reply at ${viewport.width}px.`,
      );
      await waitFor(() => providerFixture.holds.has('following'), 'Following response held');
      await waitFor(
        async () => (await page.locator('.agent-working').count()) > 0,
        'The renderer observes the held following turn',
        60000,
      );
      await page.waitForFunction(nearEnd);
      await visit('Files');
      providerFixture.releaseHold('following');
      await finish(from);
      await back();
      await page.waitForFunction(nearEnd);
      assert.equal(await page.getByRole('button', { name: /^Jump to latest(?:\s|$)/ }).count(), 0);
      await assertDraft();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      pass(
        `${viewport.width}×${viewport.height}: following resumes at the actual new reply after a Files visit`,
      );
    }
    if (!(await composer.isVisible())) await fold.click();
    assert.equal(await composer.inputValue(), 'Keep this native reading draft.');
  } finally {
    providerFixture.releaseHold('reading');
    providerFixture.releaseHold('following');
    receipt.engineResults = frames
      .filter((event) => event.type === 'run.result')
      .map((event) => event.payload.status);
    await writeFile(
      join(artifactDir, 'reading-position-receipt.json'),
      JSON.stringify(receipt, null, 2),
    );
  }
}
