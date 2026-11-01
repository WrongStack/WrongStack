import assert from 'node:assert/strict';
import { join } from 'node:path';

/**
 * Two project windows run conversations at the same time: each holds a turn at the provider and
 * queues more prompts behind it, one window reloads while its turn is held, and both queues then
 * drain. Every prompt reaches its own project's conversation, in order, and neither transcript
 * shows the other project's work.
 */
export async function exerciseNativeMultiWindow({
  page,
  rpc,
  projects,
  waitFor,
  providerFixture,
  artifactDir,
  sessionIds,
}) {
  const lanes = [
    { project: projects[0], hold: 'alpha', tag: 'stressa', title: 'Stress alpha' },
    { project: projects[1], hold: 'beta', tag: 'stressb', title: 'Stress beta' },
  ];
  const context = page.context();
  for (const lane of lanes) {
    await page.evaluate(
      (id) => window.__TAURI_INTERNALS__.invoke('open_project_window', { id }),
      lane.project.id,
    );
    lane.page = await waitFor(
      () =>
        context
          .pages()
          .find((candidate) => candidate !== page && candidate.url().includes(lane.project.id)),
      `${lane.project.name} window`,
      60000,
    );
    await lane.page
      .getByRole('status', { name: 'Local engine connected', exact: true })
      .waitFor({ timeout: 60000 });
    const session = await rpc('session.open', {
      projectId: lane.project.id,
      kind: 'agent',
      title: lane.title,
    });
    lane.session = session.id;
    sessionIds.push(session.id);
    await waitFor(
      async () => (await rpc('engine.identity', { id: session.id })).sessionId,
      `${lane.title} engine`,
      100000,
    );
    await rpc('engine.send', {
      id: session.id,
      message: {
        type: 'prefs.update',
        payload: { autonomy: 'off', enhanceEnabled: false, requestId: crypto.randomUUID() },
      },
    });
    await lane.page.locator('.tree-session').filter({ hasText: lane.title }).click();
    lane.composer = lane.page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
    await lane.composer.waitFor({ timeout: 100000 });
  }
  const send = async (lane, text, mode) => {
    await lane.page.getByRole('combobox', { name: 'Message delivery mode' }).selectOption(mode);
    await lane.composer.fill(text);
    await lane.page.locator('.composer-send').click();
    // Prompt refinement may review the message first; send it as written.
    const keep = lane.page.getByRole('button', { name: 'Keep original draft', exact: true });
    await waitFor(
      async () => {
        if ((await keep.count()) > 0) await keep.first().click();
        return (await lane.composer.inputValue()) === '';
      },
      `${lane.title} accepted ${text.slice(0, 40)}`,
      30000,
    );
  };
  // Both projects hold a turn at the provider at the same time.
  for (const lane of lanes)
    await send(lane, `[native-composer-hold-${lane.hold}] First ${lane.hold} turn.`, 'btw');
  await waitFor(
    () => lanes.every((lane) => providerFixture.holds.has(lane.hold)),
    'Both projects running at once',
    90000,
  );
  for (const lane of lanes)
    for (const step of ['two', 'three'])
      await send(lane, `[native-composer-${lane.tag}-${step}] ${lane.title} ${step}.`, 'queue');
  await page.screenshot({ path: join(artifactDir, 'native-multi-window-main.png') });
  for (const lane of lanes)
    await lane.page.screenshot({ path: join(artifactDir, `native-multi-window-${lane.hold}.png`) });

  // A model switch in one project while both turns run reaches only that conversation.
  const switchId = crypto.randomUUID();
  await rpc('engine.send', {
    id: lanes[0].session,
    message: {
      type: 'model.switch',
      payload: { provider: 'desktop-local', model: 'alternate-refiner', requestId: switchId },
    },
  });
  let switchOffset = 0;
  await waitFor(
    async () => {
      const batch = await rpc('engine.events', { id: lanes[0].session, offset: switchOffset });
      switchOffset = batch.offset;
      const reply = batch.events.find((event) => event.payload?.requestId === switchId);
      if (reply && (reply.payload.success === false || reply.payload.error))
        throw Error(reply.payload.error ?? reply.payload.message);
      return reply;
    },
    'Model switch in the first project',
    60000,
  );
  // Each window keeps its own unsent draft while both turns run.
  for (const lane of lanes) await lane.composer.fill(`Unsent ${lane.hold} draft.`);
  for (const lane of lanes)
    await waitFor(
      async () =>
        (
          await page.evaluate(
            (id) =>
              window.__TAURI_INTERNALS__.invoke('host_request', {
                method: 'draft.get',
                params: { id },
              }),
            lane.session,
          )
        ).text === `Unsent ${lane.hold} draft.`,
      `${lane.title} draft saved`,
      60000,
    );
  // One window reloads while its turn is held; its queue is still there afterwards.
  const reloaded = lanes[1];
  await reloaded.page.reload();
  await reloaded.page
    .getByRole('status', { name: 'Local engine connected', exact: true })
    .waitFor({ timeout: 60000 });
  await reloaded.page.locator('.tree-session').filter({ hasText: reloaded.title }).click();
  await reloaded.composer.waitFor({ timeout: 100000 });
  // The persistent queue (collapsed after the reload) still holds both prompts.
  await waitFor(
    async () => (await reloaded.page.getByText(`${reloaded.title} three.`).count()) > 0,
    'Queued prompts after the reload',
    60000,
  );
  assert.ok(providerFixture.holds.has(reloaded.hold), 'The reload left the held turn running');
  assert.equal(await reloaded.composer.inputValue(), `Unsent ${reloaded.hold} draft.`);
  assert.equal(await lanes[0].composer.inputValue(), `Unsent ${lanes[0].hold} draft.`);

  const before = providerFixture.calls.length;
  for (const lane of lanes) providerFixture.releaseHold(lane.hold);
  const markers = lanes.flatMap((lane) =>
    ['two', 'three'].map((step) => `[native-composer-${lane.tag}-${step}]`),
  );
  await waitFor(
    () =>
      markers.every((marker) =>
        providerFixture.calls
          .slice(before)
          .some((call) => !call.refiner && call.instructionMarkers.includes(marker)),
      ),
    'Both queues drained',
    180000,
  );
  const order = (marker) =>
    providerFixture.calls.findIndex(
      (call, index) => index >= before && !call.refiner && call.instructionMarkers.includes(marker),
    );
  const modelOf = (marker) => providerFixture.calls[order(marker)].model;
  assert.equal(modelOf('[native-composer-stressa-two]'), 'alternate-refiner');
  assert.equal(modelOf('[native-composer-stressb-two]'), 'desktop-fixture-model');
  for (const lane of lanes) {
    assert.ok(
      order(`[native-composer-${lane.tag}-two]`) < order(`[native-composer-${lane.tag}-three]`),
      `${lane.title} queue drained in order`,
    );
    const transcript = lane.page.locator('.native-chat-messages');
    await transcript.getByText(`${lane.title} three.`).first().waitFor({ timeout: 60000 });
    const other = lanes.find((candidate) => candidate !== lane);
    assert.equal(
      await transcript.getByText(other.title, { exact: false }).count(),
      0,
      `${lane.title} shows none of ${other.title}`,
    );
  }
  // Approvals under the same load: both conversations ask at once, and each window answers
  // only its own conversation's request.
  for (const lane of lanes) {
    await waitFor(
      async () => !(await lane.page.getByRole('button', { name: 'Stop run', exact: true }).count()),
      `${lane.title} idle`,
      90000,
    );
    await rpc('engine.send', {
      id: lane.session,
      message: {
        type: 'prefs.update',
        payload: { yolo: false, yoloPlus: false, requestId: crypto.randomUUID() },
      },
    });
  }
  const decisions = [
    { lane: lanes[0], kind: 'allow', button: 'Allow once' },
    { lane: lanes[1], kind: 'deny', button: 'Deny' },
  ];
  for (const { lane, kind } of decisions)
    await send(lane, `[native-composer-approval-${kind}] Run the isolated fixture command.`, 'btw');
  const card = (lane) => lane.page.getByRole('article', { name: 'Approval for exec', exact: true });
  for (const { lane } of decisions) {
    await card(lane).waitFor({ timeout: 90000 });
    assert.equal(await card(lane).count(), 1, `${lane.title} shows only its own approval`);
  }
  await lanes[0].page.screenshot({ path: join(artifactDir, 'native-multi-window-approval.png') });
  for (const { lane, button } of decisions.toReversed()) {
    await card(lane).getByRole('button', { name: button, exact: true }).click();
    await card(lane).waitFor({ state: 'detached' });
  }
  await waitFor(
    () =>
      decisions.every(({ kind }) =>
        providerFixture.toolResults.some((item) => item.challenge === `approval-${kind}`),
      ),
    'Both approval results reached the provider',
    90000,
  );
  const outcome = (kind) =>
    String(
      providerFixture.toolResults.findLast((item) => item.challenge === `approval-${kind}`).content,
    );
  assert.match(outcome('allow'), /exit_code.?[=:]\s*0|"exitCode"\s*:\s*0/i);
  assert.doesNotMatch(outcome('deny'), /exit_code.?[=:]\s*0|"exitCode"\s*:\s*0/i);
  console.log(
    'PASS: two project windows ask for approval at once; each answers only its own request, one allowed and one denied',
  );
  // A slow refinement in one window while the other window runs a held turn.
  const [refining, running] = lanes;
  await running.composer.fill('');
  await send(running, '[native-composer-hold-gamma] A turn during the other refinement.', 'btw');
  await waitFor(() => providerFixture.holds.has('gamma'), 'Turn held during refinement', 60000);
  await refining.composer.fill('[native-refine-slow] Summarize the stress run.');
  const options = refining.page.locator('.composer-options');
  if (!(await options.evaluate((element) => element.open)))
    await options.getByLabel('Composer options', { exact: true }).click();
  await options.getByRole('button', { name: 'Refine this draft', exact: true }).click();
  const dialog = refining.page.getByRole('dialog', { name: 'Refine your prompt' });
  await waitFor(
    async () => await dialog.getByRole('button', { name: 'Refined', exact: true }).isEnabled(),
    'Refinement finished while the other project ran',
    120000,
  );
  assert.ok(providerFixture.holds.has('gamma'), 'The other project kept its own turn');
  await dialog.getByRole('button', { name: 'Keep original draft', exact: true }).click();
  providerFixture.releaseHold('gamma');
  await waitFor(
    async () =>
      !(await running.page.getByRole('button', { name: 'Stop run', exact: true }).count()),
    'Held turn finished after release',
    90000,
  );
  console.log(
    'PASS: a refinement in one project window completes while another project window runs its own turn',
  );
  for (const lane of lanes) await lane.page.close();
  console.log(
    'PASS: two project windows run held turns at once with queued prompts, separate unsent drafts and a model switch in one project only, survive a reload mid-turn with queue and draft intact, and drain each queue in order into its own conversation',
  );
}
