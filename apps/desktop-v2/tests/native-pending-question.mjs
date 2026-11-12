import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const replies = new Map();

/** The provider chooses real tools; the engine constructs and owns the question. */
export function resolveNativePendingQuestionToolCall(body) {
  if (!body.stream) return;
  const users = (body.messages ?? []).flatMap((message, index) =>
    message.role !== 'user'
      ? []
      : (typeof message.content === 'string'
          ? [message.content]
          : (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text)
        )
          .filter((text) => /^\[native-composer-/.test(text.trim()))
          .map((text) => ({ text, index })),
  );
  const current = users.at(-1);
  if (!current?.text.startsWith('[native-composer-pending-question]')) return;
  const id = `native-pending-question-${current.index}`;
  const following = body.messages.slice(current.index + 1);
  const result = following.find(
    (message) => message.role === 'tool' && message.tool_call_id === id,
  );
  if (result) {
    replies.set(id, result.content);
    return;
  }
  const offered = body.tools?.some((tool) => tool.function?.name === 'clarify');
  const searched = following.some(
    (message) => message.role === 'tool' && message.tool_call_id === id + '-search',
  );
  const name = offered || searched ? 'clarify' : 'tool_search';
  assert.ok(
    offered || searched || body.tools?.some((tool) => tool.function?.name === 'tool_search'),
    'The engine offers clarify or real tool discovery',
  );
  return {
    index: 0,
    id: name === 'clarify' ? id : id + '-search',
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(
        name === 'tool_search'
          ? { query: 'clarify' }
          : {
              title: 'Native pending decisions',
              submitLabel: 'Submit pending decisions',
              tabs: [
                {
                  id: 'review',
                  label: 'Review',
                  questions: Array.from({ length: 8 }, (_, index) => ({
                    id: `decision_${index}`,
                    question: `Pending decision ${index + 1}`,
                    type: 'text',
                    required: index === 0,
                  })),
                },
              ],
            },
      ),
    },
  };
}

const settle = (page) =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
const geometry = () => {
  const pane = document.querySelector('.native-chat-messages');
  const heading = pane.querySelector('.input-request-card h3').getBoundingClientRect();
  const bounds = pane.getBoundingClientRect();
  return {
    top: pane.scrollTop,
    height: pane.clientHeight,
    total: pane.scrollHeight,
    headingTop: heading.top - bounds.top,
    headingBottom: heading.bottom - bounds.top,
    visible: heading.top >= bounds.top && heading.bottom <= bounds.bottom,
  };
};
const nearEnd = () => {
  const pane = document.querySelector('.native-chat-messages');
  return pane && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 5;
};

export async function exerciseNativePendingQuestion({
  page,
  rpc,
  project,
  waitFor,
  artifactDir,
  sessionIds,
  reloadAnswers = false,
}) {
  const receipt = { checks: [], samples: [] };
  const pass = (text) => {
    receipt.checks.push(text);
    console.log('PASS: ' + text);
  };
  const agent = await rpc('session.open', {
    projectId: project.id,
    kind: 'agent',
    title: 'Pending question reader',
  });
  receipt.agent = agent;
  sessionIds.push(agent.id);
  const frames = [];
  let offset = 0;
  const pump = async () => {
    for (;;) {
      const previous = offset;
      const batch = await rpc('engine.events', { id: agent.id, offset });
      frames.push(...batch.events);
      offset = batch.offset;
      if (!(batch.hasMore ?? batch.events.length === 200) || previous === offset) break;
    }
  };
  const identity = await waitFor(
    async () => {
      const value = await rpc('engine.identity', { id: agent.id });
      return value.sessionId ? value : null;
    },
    'Pending question engine',
    100000,
  );
  const call = async (type, payload, replyType) => {
    const requestId = crypto.randomUUID();
    await rpc('engine.send', {
      id: agent.id,
      message: { type, payload: { ...payload, requestId } },
    });
    const event = await waitFor(
      async () => {
        await pump();
        return frames.find(
          (event) =>
            event.payload?.requestId === requestId &&
            (event.type === replyType || event.type === 'error'),
        );
      },
      type,
      60000,
    );
    assert.notEqual(event.type, 'error');
    assert.notEqual(event.payload.success, false);
    return event.payload;
  };
  await call('prefs.update', { autonomy: 'off', enhanceEnabled: false }, 'key.operation_result');
  const prefs = await call('prefs.get', {}, 'prefs.updated');
  assert.equal(prefs.autonomy, 'off');
  assert.equal(prefs.enhanceEnabled, false);
  await page.locator('.tree-session').filter({ hasText: agent.title }).click();
  await page.locator(`[data-engine-session="${identity.sessionId}"]`).waitFor();
  const pane = page.locator('.native-chat-messages');
  const nav = page.getByRole('navigation', { name: 'Agent workspace views' });
  const chat = nav.getByRole('button', { name: /^Chat\b/ });
  const card = page.getByRole('article', { name: 'Native pending decisions', exact: true });
  const composer = page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  const draftText = 'Keep the native question composer draft.';
  const start = async (content) => {
    await pump();
    const turn = { from: frames.length, id: crypto.randomUUID() };
    await rpc('engine.send', {
      id: agent.id,
      message: {
        type: 'user_message',
        payload: {
          id: turn.id,
          requestId: crypto.randomUUID(),
          timestamp: Date.now(),
          content: `${content}\n[native-composer-reading-finished]`,
        },
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
          .find((event) => event.type === 'run.result' && event.payload?.requestId === turn.id)
          ?.payload;
      },
      'Pending-question turn completes',
      90000,
    );
    assert.equal(result.status, 'done');
    assert.ok(result.iterations > 0);
    await waitFor(
      async () => !(await page.locator('.agent-working').count()),
      'Renderer completion',
      60000,
    );
  };
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
    assert.equal(await pane.count(), 1);
    assert.equal(await pane.isVisible(), false);
  };
  const back = async () => {
    await chat.press('Enter');
    await pane.waitFor();
    await settle(page);
    assert.equal(await chat.evaluate((button) => document.activeElement === button), true);
  };
  const sample = async (viewport, phase) => {
    const value = await page.evaluate(geometry);
    receipt.samples.push({ viewport, phase, ...value });
    assert.equal(value.visible, true, `Question heading must be in view: ${JSON.stringify(value)}`);
    return value;
  };
  const draft = () =>
    page.evaluate(
      async (id) =>
        (
          await window.__TAURI_INTERNALS__.invoke('host_request', {
            method: 'draft.get',
            params: { id },
          })
        ).text,
      agent.id,
    );
  try {
    for (const viewport of [
      { width: 1280, height: 840 },
      { width: 800, height: 600 },
    ]) {
      await page.setViewportSize(viewport);
      await finish(
        await start(
          `[native-composer-long-reply] Populate reading history at ${viewport.width}px.`,
        ),
      );
      await page.waitForFunction(nearEnd);
      assert.ok(
        (await pane.evaluate((view) => view.scrollHeight)) > 10000,
        'Real long reply is rendered',
      );
      if (!(await composer.isVisible()))
        await page.locator('.composer-fold-controls > button').first().click();
      await composer.fill(draftText);
      await waitFor(async () => (await draft()) === draftText, 'Composer draft saved');
      await visit('Files');
      const turn = await start(
        `[native-composer-pending-question] Ask for decisions at ${viewport.width}px.`,
      );
      const requested = await waitFor(
        async () => {
          await pump();
          return frames.slice(turn.from).find((event) => event.type === 'user.input_requested');
        },
        'Real question arrives while Files is open',
        60000,
      );
      assert.equal(requested.payload.request.title, 'Native pending decisions');
      assert.equal(requested.payload.request.tabs[0].questions.length, 8);
      assert.equal(await pane.isVisible(), false);
      await back();
      await card.waitFor();
      await sample(viewport, 'arrival');
      assert.equal(await page.locator('.chat-message').count(), 0);
      const answer = `Keep decision answer at ${viewport.width}px.`;
      const field = card.getByRole('textbox', { name: 'Pending decision 1', exact: true });
      await field.fill(answer);
      for (const tool of ['Files', 'Run activity', 'Files']) {
        await visit(tool);
        await back();
        await sample(viewport, `focused return from ${tool}`);
        assert.equal(await field.inputValue(), answer);
        await page.getByRole('button', { name: 'Review conversation', exact: true }).click();
        await page.locator('.chat-message').first().waitFor();
        await visit(tool);
        await back();
        await page.getByRole('button', { name: 'Focus questions', exact: true }).waitFor();
        assert.ok(
          await page.locator('.chat-message').count(),
          'Conversation review survives tools',
        );
        assert.equal(await field.inputValue(), answer);
        await page.getByRole('button', { name: 'Focus questions', exact: true }).click();
        await settle(page);
        await sample(viewport, `focus after reviewing ${tool}`);
      }
      if (reloadAnswers) {
        await page.reload();
        await page.getByRole('status', { name: 'Local engine connected', exact: true }).waitFor();
        await page.locator(`[data-engine-session="${identity.sessionId}"]`).waitFor();
        await card.waitFor();
        await settle(page);
        await waitFor(() => field.isEnabled(), 'Reloaded question is ready for editing', 60000);
        assert.equal(await draft(), draftText, 'Control: saved composer draft survives reload');
        const actual = await field.inputValue();
        receipt.reloads ??= [];
        receipt.reloads.push({
          viewport,
          requestId: requested.payload.request.id,
          expected: answer,
          actual,
        });
        assert.equal(
          actual,
          answer,
          'A typed pending-question answer must survive renderer reload',
        );
        await sample(viewport, 'renderer reload');
      }
      await page.screenshot({
        path: join(artifactDir, `native-question-focused-${viewport.width}.png`),
        fullPage: true,
      });
      pass(
        `${viewport.width}×${viewport.height}: real question arrival and three Files/Run returns preserve focused heading, review mode, answer and keyboard focus`,
      );
      await card.getByRole('button', { name: 'Submit pending decisions', exact: true }).click();
      await card.waitFor({ state: 'detached' });
      await finish(turn);
      const resolved = frames
        .slice(turn.from)
        .find(
          (event) =>
            event.type === 'user.input_resolved' &&
            event.payload?.requestId === requested.payload.request.id,
        );
      assert.ok(resolved, 'Engine confirms the exact question response');
      assert.ok(JSON.stringify(resolved.payload).includes(answer));
      assert.ok(
        [...replies.values()].some(
          (reply) =>
            JSON.stringify(reply).includes(answer) && JSON.stringify(reply).includes('answered'),
        ),
        'Actual clarify answer reaches the provider',
      );
      await page.waitForFunction(nearEnd);
      assert.equal(await draft(), draftText);
      assert.equal(await page.getByRole('button', { name: /^Jump to latest(?:\s|$)/ }).count(), 0);
      pass(
        `${viewport.width}×${viewport.height}: actual clarify submission resumes the run and following; persisted composer draft remains intact`,
      );
    }
  } finally {
    receipt.results = frames
      .filter((event) => event.type === 'run.result')
      .map((event) => event.payload);
    receipt.questionRequests = frames
      .filter((event) => event.type === 'user.input_requested')
      .map((event) => event.payload);
    receipt.questionResolutions = frames
      .filter((event) => event.type === 'user.input_resolved')
      .map((event) => event.payload);
    receipt.toolReplies = [...replies.entries()];
    await writeFile(
      join(artifactDir, 'pending-question-receipt.json'),
      JSON.stringify(receipt, null, 2),
    );
  }
}
