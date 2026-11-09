import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureModel } from './local-provider.mjs';
import { openProjectView } from './native-project-navigation.mjs';

/** Actual delegate tools/workers/provider calls, never seeded journal or fleet frames. */
export async function exerciseNativeOfficeStory({
  page,
  rpc,
  project,
  otherProject,
  waitFor,
  artifactDir,
  sessionIds,
  providerFixture,
  configPath,
}) {
  const unpriced = process.env.WRONGSTACK_DESKTOP_WORKER_PRICING_ACCEPTANCE === 'unpriced';
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const provider = config.providers['desktop-local'];
  await writeFile(
    configPath,
    JSON.stringify({
      ...config,
      maxIterations: 3,
      fleet: {
        ...config.fleet,
        memoryCompanion: { enabled: false },
        exploreCompanion: { enabled: false },
        skillCompanion: { enabled: false },
      },
      extensions: {
        ...config.extensions,
        'wstack-chimera': { enabled: false },
        'wstack-auto-review': { enabled: false },
      },
      providers: {
        ...config.providers,
        'desktop-local': {
          ...provider,
          models: [...new Set([...(provider.models ?? []), 'alternate-refiner'])],
          customModels: {
            ...provider.customModels,
            [fixtureModel]: {
              ...provider.customModels?.[fixtureModel],
              modelsDev: {
                name: 'Office leader fixture',
                cost: { input: 2, output: 4, cache_read: 0.2, cache_write: 3 },
              },
            },
            'alternate-refiner': {
              name: 'Office worker fixture',
              modelsDev: {
                name: 'Office worker fixture',
                ...(unpriced
                  ? {}
                  : { cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.5 } }),
              },
            },
          },
        },
      },
    }),
  );
  const owners = [];
  const pump = async (owner) => {
    const batch = await rpc('engine.events', { id: owner.id, offset: owner.offset });
    owner.offset = batch.offset;
    owner.events.push(...batch.events);
    return batch.events;
  };
  const call = async (owner, type, payload = {}) => {
    const requestId = crypto.randomUUID();
    await rpc('engine.send', {
      id: owner.id,
      message: { type, payload: { ...payload, sessionId: owner.coreId, requestId } },
    });
    const reply = await waitFor(
      async () => {
        await pump(owner);
        return owner.events.find((event) => event.payload?.requestId === requestId)?.payload;
      },
      'Office worker ' + type,
      60000,
    );
    if (reply.success === false || reply.error) throw Error(reply.error ?? reply.message);
    return reply;
  };
  const start = async (target, tag) => {
    const owner = {
      ...(await rpc('session.open', {
        projectId: target.id,
        kind: 'agent',
        title: 'Office host ' + tag,
      })),
      tag,
      target,
      offset: 0,
      events: [],
    };
    sessionIds.push(owner.id);
    owners.push(owner);
    owner.coreId = (
      await waitFor(
        async () => {
          const identity = await rpc('engine.identity', { id: owner.id });
          return identity.sessionId ? identity : null;
        },
        'Office owner ' + tag,
        100000,
      )
    ).sessionId;
    await call(owner, 'prefs.update', {
      autonomy: 'off',
      yolo: false,
      yoloPlus: false,
      enhanceEnabled: false,
      subagentsAllowed: true,
      subagentCompanionsAllowed: false,
    });
    const policy = await call(owner, 'prefs.get');
    assert.equal(policy.yolo, false, 'The fixture actually requires native approval');
    await page
      .locator('.tree-session')
      .filter({ hasText: 'Office host ' + tag })
      .click();
    await page.getByRole('textbox', { name: 'Message WrongStack', exact: true }).waitFor();
    await rpc('engine.send', {
      id: owner.id,
      message: {
        type: 'user_message',
        payload: {
          id: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
          content:
            '[native-office-' +
            tag +
            '] Delegate the bounded fixture task to the explicitly named local worker and wait for it.',
          timestamp: Date.now(),
        },
      },
    });
    const allow = page.getByRole('button', { name: 'Allow once', exact: true });
    await allow.waitFor({ timeout: 60000 });
    assert.equal(
      providerFixture.calls.some((entry) => entry.officeWorker === tag),
      false,
      'Worker cannot run before native approval',
    );
    await allow.click();
    await waitFor(
      () => providerFixture.holds.has('office-' + tag),
      'Actual held worker ' + tag,
      90000,
    );
    await waitFor(
      async () => {
        await pump(owner);
        return owner.events.find(
          (event) =>
            event.type === 'subagent.event' &&
            event.payload?.kind === 'spawned' &&
            event.payload?.name === 'Office ' + tag,
        );
      },
      'Actual worker spawn event ' + tag,
      30000,
    );
    const spawned = owner.events.find(
      (event) =>
        event.type === 'subagent.event' &&
        event.payload?.kind === 'spawned' &&
        event.payload?.name === 'Office ' + tag,
    ).payload;
    owner.workerId = spawned.subagentId;
    owner.workerName = spawned.name;
    assert.equal(
      spawned.sessionId,
      owner.coreId,
      'Worker event belongs to its calling conversation',
    );
    assert.equal(owner.workerName, 'Office ' + tag);
    console.log('PASS: actual approved delegate -> provider-backed held worker ' + tag);
    return owner;
  };
  const openOffice = async (target) => {
    await page.locator('.project-item').filter({ hasText: target.name }).click();
    await openProjectView(page, target, 'Agent office');
    await page.locator('#office-map-tab-office').click();
    await page.locator('.agent-office').waitFor();
  };
  const assertOffice = async (target, present, absent) => {
    await openOffice(target);
    const office = page.locator('.agent-office');
    for (const owner of present)
      await office.getByText(owner.workerName, { exact: true }).first().waitFor({ timeout: 30000 });
    for (const owner of absent)
      assert.equal(
        await office.getByText(owner.workerName, { exact: true }).count(),
        0,
        'Office excludes another project worker ' + owner.tag,
      );
  };
  const story = async (owner, absent) => {
    await page
      .locator('.tree-session')
      .filter({ hasText: 'Office host ' + owner.tag })
      .click();
    const existing = page.locator('.session-story-surface');
    if (!(await existing.isVisible().catch(() => false))) {
      await page
        .getByRole('navigation', { name: 'Agent workspace views' })
        .getByRole('button', { name: 'Tools', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: 'Session tools', exact: true })
        .getByRole('button')
        .filter({ hasText: 'Session story' })
        .click();
    }
    await existing.waitFor({ timeout: 60000 });
    await existing.locator('#story-tab-team').click();
    assert.equal(
      await page.locator('.engine-workspace').getAttribute('data-engine-session'),
      owner.coreId,
    );
    await existing.getByText(owner.workerName, { exact: true }).first().waitFor({ timeout: 30000 });
    for (const foreign of absent)
      assert.equal(
        await existing.getByText(foreign.workerName, { exact: true }).count(),
        0,
        'Story excludes another conversation worker ' + foreign.tag,
      );
  };
  try {
    const alpha = await start(project, 'alpha'),
      beta = await start(project, 'beta'),
      gamma = await start(otherProject, 'gamma');
    const scopedCalls = () =>
      providerFixture.calls.filter((entry) => entry.officeLeader || entry.officeWorker).length;
    const beforeBrowse = scopedCalls();
    await assertOffice(project, [alpha, beta], [gamma]);
    await assertOffice(otherProject, [gamma], [alpha, beta]);
    await assertOffice(project, [alpha, beta], [gamma]);
    await page.screenshot({
      path: join(artifactDir, 'native-office-two-live-conversations.png'),
      fullPage: true,
    });
    await page.reload();
    await assertOffice(project, [alpha, beta], [gamma]);
    await story(alpha, [beta, gamma]);
    await story(beta, [alpha, gamma]);
    await story(gamma, [alpha, beta]);
    await page.screenshot({
      path: join(artifactDir, 'native-story-owned-worker.png'),
      fullPage: true,
    });
    assert.equal(
      scopedCalls(),
      beforeBrowse,
      'Browsing Office/Story never resumes these leaders or starts another worker',
    );
    for (const owner of owners) providerFixture.releaseHold('office-' + owner.tag);
    for (const owner of owners) {
      await waitFor(
        async () => {
          await pump(owner);
          return owner.events.some((event) => event.type === 'run.result');
        },
        'Real delegated completion ' + owner.tag,
        90000,
      );
      assert.equal(
        owner.events.findLast((event) => event.type === 'run.result').payload.status,
        'done',
      );
      const completed = owner.events.find((event) => event.type === 'delegate.completed')?.payload;
      assert.equal(completed?.ok, true, 'Actual delegate settles successfully');
      const leaderCalls = providerFixture.calls.filter((entry) => entry.officeLeader === owner.tag);
      const workerCalls = providerFixture.calls.filter((entry) => entry.officeWorker === owner.tag);
      assert.equal(leaderCalls.length, 2, 'One delegate request and one final leader response');
      assert.equal(workerCalls.length, 1, 'One actual worker request');
      const reported = (calls) =>
        calls.reduce(
          (sum, entry) => ({
            input: sum.input + entry.providerUsage.prompt_tokens,
            output: sum.output + entry.providerUsage.completion_tokens,
          }),
          { input: 0, output: 0 },
        );
      const leaderUsage = reported(leaderCalls),
        workerUsage = reported(workerCalls);
      const stats = await call(owner, 'stats.get');
      assert.equal(
        stats.usage.input,
        leaderUsage.input,
        'Worker input is not counted twice in the leader counter',
      );
      assert.equal(
        stats.usage.output,
        leaderUsage.output,
        'Worker output remains on the worker counter',
      );
      owner.parentUsd = (leaderUsage.input * 2 + leaderUsage.output * 4) / 1e6;
      owner.workerUsd = unpriced ? null : (workerUsage.input + workerUsage.output * 2) / 1e6;
      assert(
        Math.abs(stats.pricing.estimateUsd - owner.parentUsd) < 1e-10,
        'Actual parent estimate matches provider counters and saved rates',
      );
      if (unpriced) {
        assert.equal(completed.costUsd, undefined, 'Unknown worker rates are not reported as free');
      } else {
        assert.equal(
          typeof completed.costUsd,
          'number',
          'Known worker rate produces a priced result',
        );
        assert(
          Math.abs(completed.costUsd - owner.workerUsd) < 1e-10,
          'Actual worker estimate matches its own counters',
        );
      }
      assert.equal(completed?.sessionId, owner.coreId, 'Finished cost/result belongs to its owner');
      assert(
        owner.events.some(
          (event) =>
            event.type === 'subagent.event' &&
            event.payload?.kind === 'task_completed' &&
            event.payload.subagentId === owner.workerId,
        ),
      );
    }
    await assertOffice(project, [alpha, beta], [gamma]);
    await assertOffice(otherProject, [gamma], [alpha, beta]);
    await assertOffice(project, [alpha, beta], [gamma]);
    await story(alpha, [beta, gamma]);
    await story(beta, [alpha, gamma]);
    await story(gamma, [alpha, beta]);
    await page.reload();
    await story(gamma, [alpha, beta]);
    await page.screenshot({
      path: join(artifactDir, 'native-story-completed-worker-reload.png'),
      fullPage: true,
    });
    const usage = async (owner) => {
      await page
        .locator('.tree-session')
        .filter({ hasText: 'Office host ' + owner.tag })
        .click();
      const panel = page.getByRole('region', { name: 'Conversation usage and cost', exact: true });
      if (!(await panel.isVisible().catch(() => false))) {
        await page
          .getByRole('navigation', { name: 'Agent workspace views' })
          .getByRole('button', { name: 'Tools', exact: true })
          .click();
        await page
          .getByRole('dialog', { name: 'Session tools', exact: true })
          .getByRole('button')
          .filter({ hasText: 'Usage & cost' })
          .click();
      }
      await panel.waitFor();
      const total = panel.locator('.usage-worker-total');
      if (unpriced) {
        const workers = panel.locator('.session-delegations');
        await workers.waitFor({ timeout: 60000 });
        assert.match(
          (await workers.textContent()) ?? '',
          /1 without a cost estimate/i,
          'Native usage identifies the one worker without a cost estimate',
        );
        assert.equal(
          await workers.locator('ol li').count(),
          1,
          'Only this conversation worker is shown',
        );
        assert(
          !/\$[\d.]+/.test((await workers.locator('ol li span').textContent()) ?? ''),
          'Unknown worker cost is not rendered as USD zero',
        );
        assert.equal(
          await total.count(),
          0,
          'No complete combined estimate is rendered when every worker is unpriced',
        );
        return;
      }
      await total.waitFor({ timeout: 60000 });
      const text = (await total.textContent()) ?? '';
      const amount = text.match(/\$([\d.]+)/)?.[1];
      assert(amount, 'The UI shows the priced combined estimate');
      assert(
        Math.abs(Number(amount) - (owner.parentUsd + owner.workerUsd)) <= 0.0000005,
        'The UI adds this one worker exactly once',
      );
      assert(!text.includes('unpriced'), 'Known worker price is not reported as unavailable');
    };
    await usage(alpha);
    await waitFor(
      async () => JSON.parse((await rpc('snapshot')).layout || '{}').selected === alpha.id,
      'Usage owner saved before reload',
    );
    await page.reload();
    await usage(alpha);
    await page.screenshot({
      path: join(
        artifactDir,
        unpriced
          ? 'native-unpriced-worker-usage-replay.png'
          : 'native-worker-inclusive-usage-replay.png',
      ),
      fullPage: true,
    });
    await rpc('session.kill', { id: alpha.id });
    await assertOffice(otherProject, [gamma], [alpha, beta]);
    assert.equal(
      (await rpc('engine.identity', { id: gamma.id })).sessionId,
      gamma.coreId,
      'Stopping another project never stops this owner',
    );
    await story(gamma, [alpha, beta]);
    assert.equal(
      providerFixture.calls.filter((entry) => entry.officeWorker).length,
      3,
      'Exactly the three explicitly approved workers',
    );
    console.log(
      'PASS: real native Office/Story two-project/three-conversation live and completed worker ownership, renderer reload, stopped foreign owner and no view-induced worker/leader runs',
    );
    return {
      workerPricing: unpriced ? 'unavailable' : 'known',
      realWorkers: 3,
      projects: 2,
      conversations: 3,
      liveAndCompleted: true,
      rendererReload: true,
      foreignStopIsolation: true,
    };
  } finally {
    for (const owner of owners) providerFixture.releaseHold('office-' + owner.tag);
  }
}
