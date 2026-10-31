import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function exerciseNativeTopicBoundary({
  page,
  rpc,
  agent,
  call,
  idle,
  waitFor,
  artifactDir,
  providerFixture,
}) {
  const input = () => page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  const choose = () =>
    page.getByRole('dialog', { name: 'Start a new topic context?', exact: true });
  const sessions = (await rpc('snapshot')).sessions.map((session) => session.id);
  const humanFrames = async () => {
    let offset = 0;
    const result = [];
    for (;;) {
      const batch = await rpc('engine.events', { id: agent.id, offset });
      result.push(...batch.events.filter((event) => event.type === 'desktop.user_message'));
      if (batch.offset === offset || !batch.events.length) return result;
      offset = batch.offset;
    }
  };
  const send = async (text) => {
    await input().fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
  };
  await page
    .getByRole('combobox', { name: 'Message delivery mode', exact: true })
    .selectOption('btw');
  // Real retained user turns reach the canonical advisor's minimum-history gate.
  for (let index = 0; index < 9; index++) {
    const text = `Continue native desktop composer verification ${index}. [native-topic-seed-${index}]`;
    await send(text);
    await waitFor(async () => (await input().inputValue()) === '', 'Topic seed accepted');
    await idle();
  }
  const before = (await humanFrames()).length;
  const canceled = '[native-composer-topic-cancel] New topic: plan an unrelated bread recipe.';
  await send(canceled);
  await choose().waitFor();
  assert.equal((await humanFrames()).length, before, 'Advice has not submitted the human prompt');
  await choose().getByRole('button', { name: 'Keep draft', exact: true }).click();
  assert.equal(await input().inputValue(), canceled);
  assert.equal((await humanFrames()).length, before, 'Dismissal keeps the unsent prompt');
  const same = '[native-composer-topic-same] New topic: plan an unrelated garden.';
  await send(same);
  await choose().waitFor();
  await choose().getByRole('button', { name: 'Continue in same context', exact: true }).click();
  await waitFor(
    () =>
      providerFixture.calls.some(
        (call) =>
          !call.refiner &&
          !call.topicAdvisor &&
          call.composerPrompt.includes('[native-composer-topic-same]'),
      ),
    'Same-context choice sent',
  );
  await idle();
  assert.equal((await humanFrames()).at(-1).payload.freshContext, undefined);

  const originalPrefs = await call('prefs.get', {}, ['prefs.updated']);
  try {
    await call('prefs.update', { enhanceEnabled: true }, ['key.operation_result']);
    await call('prefs.get', {}, ['prefs.updated']);
    await waitFor(
      async () => await page.getByLabel('Refine before sending', { exact: true }).isChecked(),
      'Topic refinement preference visible in the composer',
    );
    const fresh = '[native-composer-topic-fresh] New topic: build an unrelated astronomy notebook.';
    await send(fresh);
    await choose().waitFor();
    await page.screenshot({
      path: join(artifactDir, 'native-topic-context-choice.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 800, height: 640 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: join(artifactDir, 'native-topic-context-choice-compact.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1480, height: 960 });
    const beforeApproval = (await humanFrames()).length;
    await choose().getByRole('button', { name: 'Use fresh context', exact: true }).click();
    const refine = page.getByRole('dialog', { name: 'Refine your prompt', exact: true });
    await refine.waitFor();
    assert.equal(
      (await humanFrames()).length,
      beforeApproval,
      'Choosing fresh context does not submit before refinement approval',
    );
    await waitFor(
      async () => await refine.getByRole('button', { name: 'Refined', exact: true }).isEnabled(),
      'Topic refinement ready',
      120000,
    );
    await refine.getByRole('button', { name: 'Original', exact: true }).click();
    await refine.getByRole('button', { name: 'Approve & send', exact: true }).click();
    await refine.waitFor({ state: 'hidden' });
    const actual = await waitFor(
      () =>
        providerFixture.calls.findLast(
          (call) =>
            !call.refiner &&
            !call.topicAdvisor &&
            call.composerPrompt.includes('[native-composer-topic-fresh]'),
        ),
      'Fresh-context choice reaches actual model',
    );
    await idle();
    assert.equal((await humanFrames()).at(-1).payload.freshContext, true);
    assert.equal(
      actual.freshTopicContext,
      true,
      'Provider receives the canonical fresh-context boundary',
    );
    assert.equal(
      actual.topicSameMarker,
      false,
      'Prior-topic user text is excluded from the actual request',
    );
    await page
      .locator('.chat-message.user')
      .filter({ hasText: '[native-composer-topic-same]' })
      .waitFor();
    assert.equal(await input().inputValue(), '');
  } finally {
    await call('prefs.update', { enhanceEnabled: originalPrefs.enhanceEnabled ?? false }, [
      'key.operation_result',
    ]);
    await call('prefs.get', {}, ['prefs.updated']);
  }
  assert.deepEqual(
    (await rpc('snapshot')).sessions.map((session) => session.id),
    sessions,
    'Topic choice preserves native session identities',
  );
  console.log(
    'PASS: canonical topic advice, cancel/draft retention, explicit same/fresh context, refinement approval ownership, actual provider context boundary and retained visible history',
  );
}
