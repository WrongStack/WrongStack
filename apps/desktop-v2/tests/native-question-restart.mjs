import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Process replacement, acknowledged native data and a real clarify awaiter. */
export async function exerciseNativeQuestionRestart({
  getPage,
  rpc,
  project,
  waitFor,
  restart,
  artifactDir,
  sessionIds,
}) {
  const receipt = { checks: [], restarts: [] };
  const pass = (text) => {
    receipt.checks.push(text);
    console.log('PASS: ' + text);
  };
  const agent = await rpc('session.open', {
    projectId: project.id,
    kind: 'agent',
    title: 'Question restart recovery',
  });
  receipt.agent = agent;
  sessionIds.push(agent.id);
  const initial = await waitFor(
    async () => {
      const value = await rpc('engine.identity', { id: agent.id });
      return value.sessionId ? value : null;
    },
    'Question restart engine',
    100000,
  );
  receipt.initialIdentity = initial;
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
  const select = async () => {
    await getPage().locator('.tree-session').filter({ hasText: agent.title }).click();
    await getPage().locator(`[data-engine-session="${initial.sessionId}"]`).waitFor();
  };
  await select();
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
      'Restart control turn completes',
      90000,
    );
    assert.equal(result.status, 'done');
    assert.ok(result.iterations > 0);
    await waitFor(
      async () => !(await getPage().locator('.agent-working').count()),
      'Control is rendered idle',
      60000,
    );
  };
  const hostRequest = (method, params) =>
    getPage().evaluate(
      ({ method, params }) => window.__TAURI_INTERNALS__.invoke('host_request', { method, params }),
      { method, params },
    );
  const composerDraft = 'Keep my unrelated restart composer draft.';
  const answer = 'Keep my interrupted question answer.';
  const card = () =>
    getPage().getByRole('article', { name: 'Native pending decisions', exact: true });
  const field = () => card().getByRole('textbox', { name: 'Pending decision 1', exact: true });
  const draft = () => hostRequest('draft.get', { id: agent.id });
  let formKey;
  try {
    await finish(
      await start('[native-composer-restart-control] Confirm the running conversation.'),
    );
    const composer = getPage().getByRole('textbox', { name: 'Message WrongStack', exact: true });
    if (!(await composer.isVisible()))
      await getPage().locator('.composer-fold-controls > button').first().click();
    await composer.fill(composerDraft);
    await waitFor(async () => (await draft()).text === composerDraft, 'Composer is acknowledged');
    const turn = await start('[native-composer-pending-question] Ask for restart decisions.');
    const requested = await waitFor(
      async () => {
        await pump();
        return frames.slice(turn.from).find((event) => event.type === 'user.input_requested');
      },
      'Actual pending question',
      60000,
    );
    receipt.request = requested.payload.request;
    formKey =
      'input-answers:' +
      createHash('sha256')
        .update(JSON.stringify([project.id, agent.id, receipt.request.id]))
        .digest('hex');
    const saved = () => hostRequest('form-draft.get', { projectId: project.id, formKey });
    await field().fill(answer);
    await waitFor(
      async () => (await saved()).value?.answers?.decision_0?.text === answer,
      'Question answer acknowledged in SQLite',
    );
    receipt.savedBefore = await saved();
    const warm = await restart(false);
    receipt.restarts.push(warm);
    await select();
    await card().waitFor();
    await waitFor(() => field().isEnabled(), 'Warm-restored live question is editable', 60000);
    assert.equal(await field().inputValue(), answer);
    assert.deepEqual(await saved(), receipt.savedBefore);
    assert.equal((await draft()).text, composerDraft);
    assert.equal((await rpc('engine.identity', { id: agent.id })).sessionId, initial.sessionId);
    pass(
      'New Tauri and WebView processes retain the live question, exact acknowledged answer and composer while the host stays alive',
    );
    const cold = await restart(true);
    receipt.restarts.push(cold);
    const snapshot = await rpc('snapshot');
    const restored = snapshot.sessions.find((session) => session.id === agent.id);
    receipt.coldSession = restored;
    assert.ok(restored);
    assert.equal(restored.status, 'interrupted');
    assert.deepEqual(
      await saved(),
      receipt.savedBefore,
      'Cold host restart preserves the exact acknowledged answer snapshot',
    );
    assert.equal((await draft()).text, composerDraft);
    pass(
      'Fresh UI/host/WebView identities retain both acknowledged drafts; the stopped engine is explicitly interrupted',
    );
    await getPage().locator('.tree-session').filter({ hasText: agent.title }).click();
    await getPage()
      .locator('.conversation-reconnect')
      .getByRole('button', { name: 'Reconnect', exact: true })
      .waitFor();
    receipt.beforeReconnect = {
      card: await card().count(),
      enabled: await getPage()
        .getByRole('button', { name: 'Submit pending decisions', exact: true })
        .isEnabled()
        .catch(() => false),
    };
    assert.equal(
      receipt.beforeReconnect.enabled,
      false,
      'A known interrupted engine must not accept an obsolete question submission',
    );
    await getPage()
      .locator('.conversation-reconnect')
      .getByRole('button', { name: 'Reconnect', exact: true })
      .click();
    const resumed = await waitFor(
      async () => {
        const value = await rpc('engine.identity', { id: agent.id }).catch(() => null);
        return value?.sessionId === initial.sessionId ? value : null;
      },
      'Recorded conversation reconnects',
      100000,
    );
    receipt.resumedIdentity = resumed;
    await finish(
      await start('[native-composer-restart-after] Confirm the reconnected conversation.'),
    );
    assert.equal((await draft()).text, composerDraft);
    assert.deepEqual(await saved(), receipt.savedBefore);
    assert.equal(
      await getPage()
        .getByRole('button', { name: 'Submit pending decisions', exact: true })
        .count(),
      0,
      'The replacement engine must not present the previous awaiter as an active question',
    );
    const recovery = getPage().getByRole('button', { name: /Review saved answers/ });
    if (await recovery.count()) await recovery.click();
    const readableCard =
      (await card().count()) &&
      (await card().isVisible()) &&
      (await field().inputValue()) === answer;
    receipt.afterReconnect = {
      card: await card().count(),
      readableCard: !!readableCard,
      body: ((await getPage().locator('main').textContent()) ?? '').slice(-10000),
      saved: await saved(),
    };
    assert.ok(readableCard, 'The expired question keeps a readable saved-answer recovery path');
    await getPage().screenshot({
      path: join(artifactDir, 'native-question-after-cold-reconnect.png'),
      fullPage: true,
    });
    await card().getByRole('button', { name: 'Copy saved answers', exact: true }).click();
    await card().getByRole('button', { name: 'Copied', exact: true }).waitFor();
    await getPage().keyboard.press('Escape');
    const recoveredComposer = getPage().getByRole('textbox', {
      name: 'Message WrongStack',
      exact: true,
    });
    if (!(await recoveredComposer.isVisible()))
      await getPage().locator('.composer-fold-controls > button').first().click();
    await recoveredComposer.focus();
    await getPage().keyboard.press('Control+End');
    await getPage().keyboard.press('Control+v');
    await waitFor(
      async () => (await recoveredComposer.inputValue()).includes(answer),
      'Recovered answers paste into the same conversation',
    );
    const pasted = await recoveredComposer.inputValue();
    assert.ok(pasted.startsWith(composerDraft), 'Recovery copying preserves the unrelated draft');
    receipt.copiedAnswers = pasted.slice(composerDraft.length);
    await waitFor(
      async () => (await draft()).text === pasted,
      'Pasted recovery text is acknowledged',
    );
    await recoveredComposer.fill(composerDraft);
    await waitFor(
      async () => (await draft()).text === composerDraft,
      'Control draft restored after clipboard verification',
    );
    pass(
      'Recorded conversation reconnects and completes a real control; the acknowledged answer snapshot remains independently retained',
    );
  } finally {
    receipt.formKey = formKey;
    receipt.results = frames
      .filter((event) => event.type === 'run.result')
      .map((event) => event.payload);
    await writeFile(
      join(artifactDir, 'question-restart-receipt.json'),
      JSON.stringify(receipt, null, 2),
    );
  }
}
