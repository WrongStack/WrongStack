import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { planNativeDesignToolCall } from './native-design-handoff.mjs';

const html =
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Interruption control</title><style>body{background:#fff;color:#18202b;font:16px/1.6 Arial;padding:24px}h1{font-size:32px}</style><main><h1>Interruption control</h1><p>A real reference for the native extraction control.</p></main></html>';

/** Real tool, gated reference, acknowledged draft and replacement UI/host/engine identities. */
export async function exerciseNativeDesignInterruption({
  getPage,
  rpc,
  project,
  waitFor,
  restart,
  artifactDir,
  sessionIds,
}) {
  const receipt = { checks: [], tools: [] };
  const pass = (text) => {
    receipt.checks.push(text);
    console.log('PASS: ' + text);
  };
  const waiting = new Set();
  let requests = 0,
    released = false;
  const server = createServer((_request, response) => {
    requests++;
    const send = () => {
      if (!response.destroyed) response.writeHead(200, { 'content-type': 'text/html' }).end(html);
    };
    if (released) send();
    else waiting.add(send);
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const agent = await rpc('session.open', {
    projectId: project.id,
    kind: 'agent',
    title: 'Interrupted design extraction',
  });
  receipt.agent = agent;
  sessionIds.push(agent.id);
  let offset = 0;
  const frames = [];
  const pump = async () => {
    for (;;) {
      const previous = offset,
        batch = await rpc('engine.events', { id: agent.id, offset });
      offset = batch.offset;
      frames.push(...batch.events);
      if (!(batch.hasMore ?? batch.events.length === 200) || previous === offset) break;
    }
  };
  const call = async (type, payload) => {
    const requestId = crypto.randomUUID();
    await rpc('engine.send', {
      id: agent.id,
      message: { type, payload: { ...payload, requestId } },
    });
    return waitFor(
      async () => {
        await pump();
        const event = frames.find((event) => event.payload?.requestId === requestId);
        if (!event) return null;
        assert.notEqual(event.type, 'error');
        assert.notEqual(event.payload.ok, false);
        assert.notEqual(event.payload.success, false);
        return event.payload;
      },
      type,
      60000,
    );
  };
  const cards = () =>
    getPage().locator('.session-activity:not(.session-activity-compact) .design-extraction-card');
  const select = async () => {
    await getPage().locator('.tree-session').filter({ hasText: agent.title }).click();
  };
  const showActivity = async () => {
    await getPage().getByRole('button', { name: 'Tools', exact: true }).click();
    await getPage()
      .getByRole('dialog')
      .getByRole('button', { name: /Run activity/ })
      .click();
  };
  const send = async (tag, input) => {
    const plan = planNativeDesignToolCall(tag, input),
      id = crypto.randomUUID();
    receipt.tools.push({ tag, plan });
    await rpc('engine.send', {
      id: agent.id,
      message: {
        type: 'user_message',
        payload: {
          id,
          requestId: crypto.randomUUID(),
          timestamp: Date.now(),
          content: `[native-design-handoff:${tag}] Execute exactly this design_reference request: ${JSON.stringify(input)}`,
        },
      },
    });
    return { id, plan };
  };
  const finish = async (turn) => {
    const result = await waitFor(
      async () => {
        await pump();
        return frames.find(
          (event) => event.type === 'run.result' && event.payload?.requestId === turn.id,
        )?.payload;
      },
      'Real extraction control finishes',
      150000,
    );
    assert.equal(result.status, 'done');
    assert.equal(turn.plan.calls, 1);
    await waitFor(
      () => typeof turn.plan.output === 'string',
      'Real tool output is returned',
      60000,
    );
    const executed = frames.find(
      (event) =>
        event.type === 'tool.executed' &&
        event.payload?.id ===
          `native-design-${receipt.tools.find((item) => item.plan === turn.plan).tag}`,
    );
    assert.equal(executed?.payload.ok, true);
    return result;
  };
  try {
    const initial = await waitFor(
      async () => {
        const value = await rpc('engine.identity', { id: agent.id });
        return value.sessionId ? value : null;
      },
      'Design engine ready',
      100000,
    );
    receipt.initialIdentity = initial;
    await call('prefs.update', { enhanceEnabled: false, autonomy: 'off' });
    const allowed = await call('browser.policy', { args: `allow ${origin}` });
    assert.equal(allowed.ok, true);
    await writeFile(join(project.root, 'interruption-control.html'), html);
    await select();
    await getPage().locator(`[data-engine-session="${initial.sessionId}"]`).waitFor();
    const draftText = 'Keep the design interruption composer draft.';
    const composer = getPage().getByRole('textbox', { name: 'Message WrongStack', exact: true });
    if (!(await composer.isVisible()))
      await getPage().locator('.composer-fold-controls > button').first().click();
    await composer.fill(draftText);
    const draft = () =>
      getPage().evaluate(
        (id) =>
          window.__TAURI_INTERNALS__.invoke('host_request', {
            method: 'draft.get',
            params: { id },
          }),
        agent.id,
      );
    await waitFor(async () => (await draft()).text === draftText, 'Composer acknowledged');
    const control = await send('interrupt-control', {
      action: 'extract',
      file: 'interruption-control.html',
      name: 'interrupt-control',
      maxPages: 1,
      viewports: [375],
    });
    await finish(control);
    const spec = '.design/references/interrupt-control/DESIGN.md';
    assert.ok((await readFile(join(project.root, spec), 'utf8')).length > 100);
    await showActivity();
    await cards().nth(0).getByRole('button', { name: 'Open DESIGN.md', exact: true }).waitFor();
    pass('A real completed extraction reports its actual DESIGN.md before the interrupted case');
    await send('interrupt-cut', {
      action: 'extract',
      url: origin + '/reference.html',
      name: 'interrupt-cut',
      maxPages: 1,
      viewports: [375],
    });
    await waitFor(() => requests > 0, 'Real extraction reaches the gated reference', 120000);
    await waitFor(
      async () =>
        (await cards().count()) === 2 &&
        (await cards().nth(1).locator('[data-state="running"]').count()) > 0,
      'Live extraction progress is rendered',
      60000,
    );
    assert.equal(
      await cards().nth(1).getByRole('button', { name: 'Open DESIGN.md', exact: true }).count(),
      0,
    );
    receipt.restart = await restart(true);
    receipt.coldSession = (await rpc('snapshot')).sessions.find(
      (session) => session.id === agent.id,
    );
    assert.equal(receipt.coldSession.status, 'interrupted');
    assert.equal((await draft()).text, draftText);
    await select();
    await showActivity();
    await waitFor(
      async () => (await cards().count()) === 2,
      'Interrupted extraction journal is rendered',
      60000,
    );
    receipt.stopped = {
      running: await cards().nth(1).locator('[data-state="running"]').count(),
      text: await cards().nth(1).textContent(),
    };
    await getPage().screenshot({
      path: join(artifactDir, 'native-design-interrupted.png'),
      fullPage: true,
    });
    assert.equal(
      receipt.stopped.running,
      0,
      'A dead engine must not show its interrupted extraction as still running',
    );
    assert.equal(
      await cards().nth(1).getByRole('button', { name: 'Open DESIGN.md', exact: true }).count(),
      0,
    );
    assert.equal(
      await cards().nth(0).getByRole('button', { name: 'Open DESIGN.md', exact: true }).count(),
      1,
    );
    pass(
      'Cold UI/host/engine replacement settles the incomplete extraction and retains the completed artifact and acknowledged draft',
    );
    await getPage()
      .locator('.conversation-reconnect')
      .getByRole('button', { name: 'Reconnect', exact: true })
      .click();
    const resumed = await waitFor(
      async () => {
        const value = await rpc('engine.identity', { id: agent.id }).catch(() => null);
        return value?.sessionId === initial.sessionId && value.eventEpoch !== initial.eventEpoch
          ? value
          : null;
      },
      'Same recorded design conversation reconnects in a new epoch',
      100000,
    );
    receipt.resumedIdentity = resumed;
    await call('browser.policy', { args: `allow ${origin}` });
    const previousRequests = requests;
    const next = await send('interrupt-next', {
      action: 'extract',
      url: origin + '/reference.html',
      name: 'interrupt-next',
      maxPages: 1,
      viewports: [375],
    });
    await waitFor(
      () => requests > previousRequests,
      'New genuine extraction reaches the gate',
      120000,
    );
    await waitFor(
      async () =>
        (await cards().count()) === 3 &&
        (await cards().nth(2).locator('[data-state="running"]').count()) > 0,
      'New extraction is rendered live',
      60000,
    );
    receipt.duringNext = {
      oldRunning: await cards().nth(1).locator('[data-state="running"]').count(),
      newRunning: await cards().nth(2).locator('[data-state="running"]').count(),
    };
    assert.equal(
      receipt.duringNext.oldRunning,
      0,
      'A new live run must not revive the previous process extraction',
    );
    assert.equal(
      await cards().nth(1).getByRole('button', { name: 'Open DESIGN.md', exact: true }).count(),
      0,
    );
    await getPage().screenshot({
      path: join(artifactDir, 'native-design-next-running.png'),
      fullPage: true,
    });
    released = true;
    for (const release of waiting) release();
    waiting.clear();
    await finish(next);
    await cards().nth(2).getByRole('button', { name: 'Open DESIGN.md', exact: true }).waitFor();
    assert.equal((await draft()).text, draftText);
    pass(
      'A fresh real extraction runs and completes after reconnect while the interrupted predecessor stays settled',
    );
  } finally {
    await pump().catch(() => {});
    receipt.events = frames.filter((event) =>
      ['session.start', 'tool.started', 'tool.executed', 'run.result'].includes(event.type),
    );
    await writeFile(
      join(artifactDir, 'design-interruption-receipt.json'),
      JSON.stringify(receipt, null, 2),
    );
    for (const release of waiting) release();
    waiting.clear();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}
