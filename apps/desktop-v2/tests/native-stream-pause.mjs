import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const state = () => {
  const pane = document.querySelector('.native-chat-messages');
  const row = [...pane.querySelectorAll('.chat-message.assistant')].at(-1);
  const bounds = pane.getBoundingClientRect();
  const visible =
    row &&
    [...row.querySelectorAll('li,p,h2,pre')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > bounds.top && r.top < bounds.bottom;
    });
  return {
    top: pane.scrollTop,
    height: pane.clientHeight,
    total: pane.scrollHeight,
    gap: pane.scrollHeight - pane.scrollTop - pane.clientHeight,
    messageId: row?.dataset.messageId,
    messageHeight: row?.getBoundingClientRect().height,
    anchor: visible?.textContent?.slice(0, 120),
    anchorOffset: visible ? visible.getBoundingClientRect().top - bounds.top : null,
  };
};
const nearEnd = () => {
  const p = document.querySelector('.native-chat-messages');
  return p && p.scrollHeight - p.scrollTop - p.clientHeight < 5;
};
const settle = (page) =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );

/** Actual partial provider text grows one native Markdown message while the reader pauses. */
export async function exerciseNativeStreamPause({
  page,
  rpc,
  project,
  waitFor,
  providerFixture,
  artifactDir,
  sessionIds,
}) {
  const receipt = { checks: [], samples: [] };
  const pass = (text) => {
    receipt.checks.push(text);
    console.log('PASS: ' + text);
  };
  await page.addInitScript(() => {
    const schedule = window.setTimeout.bind(window),
      cancel = window.clearTimeout.bind(window),
      held = new Map();
    let frozen = false,
      next = -1;
    window.setTimeout = (callback, delay, ...args) => {
      if (frozen && delay === 150 && typeof callback === 'function') {
        const id = next--;
        held.set(id, () => callback(...args));
        return id;
      }
      return schedule(callback, delay, ...args);
    };
    window.clearTimeout = (id) => {
      if (!held.delete(id)) cancel(id);
    };
    window.streamPauseClock = {
      hold: () => {
        frozen = true;
      },
      count: () => held.size,
      release: () => {
        frozen = false;
        for (const callback of held.values()) schedule(callback, 0);
        held.clear();
      },
    };
  });
  await page.reload();
  await page.getByRole('status', { name: 'Local engine connected', exact: true }).waitFor();
  const agent = await rpc('session.open', {
    projectId: project.id,
    kind: 'agent',
    title: 'Paused streaming reader',
  });
  receipt.agent = agent;
  sessionIds.push(agent.id);
  const identity = await waitFor(
    async () => {
      const v = await rpc('engine.identity', { id: agent.id });
      return v.sessionId ? v : null;
    },
    'Streaming engine',
    100000,
  );
  let offset = 0;
  const frames = [];
  const pump = async () => {
    for (;;) {
      const previous = offset,
        batch = await rpc('engine.events', { id: agent.id, offset });
      offset = batch.offset;
      frames.push(...batch.events);
      if (!(batch.hasMore ?? batch.events.length === 200) || offset === previous) break;
    }
  };
  const call = async (type, payload, replies) => {
    const requestId = crypto.randomUUID();
    await rpc('engine.send', {
      id: agent.id,
      message: { type, payload: { ...payload, requestId } },
    });
    const v = await waitFor(
      async () => {
        await pump();
        return frames.find(
          (e) =>
            e.payload?.requestId === requestId && (replies.includes(e.type) || e.type === 'error'),
        );
      },
      type,
      60000,
    );
    assert.notEqual(v.type, 'error');
    assert.notEqual(v.payload.success, false);
    return v.payload;
  };
  await call('prefs.update', { autonomy: 'off', enhanceEnabled: false }, ['key.operation_result']);
  const prefs = await call('prefs.get', {}, ['prefs.updated']);
  assert.equal(prefs.autonomy, 'off');
  assert.equal(prefs.enhanceEnabled, false);
  await page.locator('.tree-session').filter({ hasText: agent.title }).click();
  await page.locator(`[data-engine-session="${identity.sessionId}"]`).waitFor();
  const pane = page.locator('.native-chat-messages');
  const composer = page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  const fold = page.locator('.composer-fold-controls > button').first();
  const start = async (content) => {
    await pump();
    const turn = { from: frames.length, id: crypto.randomUUID() };
    await rpc('engine.send', {
      id: agent.id,
      message: {
        type: 'user_message',
        payload: { id: turn.id, requestId: crypto.randomUUID(), content, timestamp: Date.now() },
      },
    });
    return turn;
  };
  const finish = async (turn) => {
    const result = await waitFor(
      async () => {
        await pump();
        return frames
          .slice(turn.from)
          .find((e) => e.type === 'run.result' && e.payload?.requestId === turn.id)?.payload;
      },
      'Streaming turn completed',
      90000,
    );
    assert.equal(result.status, 'done');
    assert.ok(result.iterations > 0);
    await waitFor(
      async () => !(await page.locator('.agent-working').count()),
      'Renderer consumes completion',
      60000,
    );
  };
  try {
    await finish(
      await start(
        '[native-composer-stream-control] Answer briefly.\n[native-composer-reading-finished]',
      ),
    );
    if (!(await composer.isVisible())) await fold.click();
    await composer.fill('Keep the streaming reader draft.');
    await waitFor(
      async () =>
        page.evaluate(
          async (id) =>
            (
              await window.__TAURI_INTERNALS__.invoke('host_request', {
                method: 'draft.get',
                params: { id },
              })
            ).text === 'Keep the streaming reader draft.',
          agent.id,
        ),
      'Draft persisted',
    );
    for (const viewport of [
      { width: 1280, height: 840 },
      { width: 800, height: 600 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => window.streamPauseClock.hold());
      const previous = await page.evaluate(state);
      const turn = await start(
        `[native-composer-long-reply] [native-composer-stream-pause] Stream the answer at ${viewport.width}px.`,
      );
      await waitFor(
        () => providerFixture.holds.has('stream-pause-1'),
        'First real stream boundary',
        90000,
      );
      await page.waitForFunction((previous) => {
        const row = [
          ...document.querySelectorAll('.native-chat-messages .chat-message.assistant'),
        ].at(-1);
        return (
          row && row.dataset.messageId !== previous && row.getBoundingClientRect().height > 6000
        );
      }, previous.messageId);
      await page.waitForFunction(nearEnd);
      await waitFor(
        async () => (await page.locator('.agent-working').count()) > 0,
        'Renderer observes partial active reply',
        60000,
      );
      if (await composer.isVisible()) await fold.click();
      await page.waitForFunction(nearEnd);
      await pane.hover();
      await page.mouse.wheel(0, -1200);
      await page.getByRole('button', { name: /^Jump to latest(?:\s|$)/ }).waitFor();
      await settle(page);
      const before = await page.evaluate(state);
      receipt.samples.push({ viewport, paused: before });
      assert.ok(
        before.gap > 1000,
        `A reader's wheel pause must remain above the partial reply: ${JSON.stringify(before)}`,
      );
      assert.ok(before.anchor && before.messageId);
      assert.ok(
        await page.evaluate(() => window.streamPauseClock.count() > 0),
        'Measurement timeout is held explicitly',
      );
      providerFixture.releaseHold('stream-pause-1');
      await waitFor(
        () => providerFixture.holds.has('stream-pause-2'),
        'Second real stream boundary',
        90000,
      );
      await page.waitForFunction((previous) => {
        const row = [
          ...document.querySelectorAll('.native-chat-messages .chat-message.assistant'),
        ].at(-1);
        return (
          row &&
          row.dataset.messageId === previous.messageId &&
          row.getBoundingClientRect().height > previous.messageHeight + 6000
        );
      }, before);
      await settle(page);
      const after = await page.evaluate(state);
      receipt.samples.push({ viewport, before, after });
      assert.equal(after.messageId, before.messageId, 'The same assistant message grows');
      assert.ok(
        Math.abs(after.top - before.top) <= 2,
        `Paused native reading is stable: ${JSON.stringify({ before, after })}`,
      );
      assert.ok(after.gap > 1000);
      await page.getByRole('button', { name: /^Jump to latest(?:\s|$)/ }).waitFor();
      await page.screenshot({
        path: join(artifactDir, `native-stream-paused-${viewport.width}.png`),
        fullPage: true,
      });
      pass(
        `${viewport.width}×${viewport.height}: a growing native Markdown reply preserves paused position behind held measurement timeouts`,
      );
      await page.getByRole('button', { name: /^Jump to latest(?:\s|$)/ }).click();
      await page.waitForFunction(nearEnd);
      providerFixture.releaseHold('stream-pause-2');
      await finish(turn);
      await page.waitForFunction(nearEnd);
      await page.evaluate(() => window.streamPauseClock.release());
      const draft = await page.evaluate(
        async (id) =>
          (
            await window.__TAURI_INTERNALS__.invoke('host_request', {
              method: 'draft.get',
              params: { id },
            })
          ).text,
        agent.id,
      );
      assert.equal(draft, 'Keep the streaming reader draft.');
      assert.equal(await page.getByRole('button', { name: /^Jump to latest(?:\s|$)/ }).count(), 0);
      pass(
        `${viewport.width}×${viewport.height}: explicit resume follows the remaining real stream and preserves the native draft`,
      );
    }
  } finally {
    providerFixture.releaseHold('stream-pause-1');
    providerFixture.releaseHold('stream-pause-2');
    await page.evaluate(() => window.streamPauseClock.release()).catch(() => {});
    receipt.results = frames.filter((e) => e.type === 'run.result').map((e) => e.payload.status);
    await writeFile(
      join(artifactDir, 'stream-pause-receipt.json'),
      JSON.stringify(receipt, null, 2),
    );
  }
}
