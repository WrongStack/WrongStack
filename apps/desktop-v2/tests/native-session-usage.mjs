import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureModel } from './local-provider.mjs';

export async function exerciseNativeSessionUsage({
  page,
  rpc,
  project,
  waitFor,
  artifactDir,
  configPath,
  providerFixture,
  sessionIds,
}) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const provider = config.providers['desktop-local'];
  await writeFile(
    configPath,
    JSON.stringify({
      ...config,
      autonomy: { ...config.autonomy, defaultMode: 'off', enhance: false },
      maxIterations: 2,
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
          models: [...new Set([...provider.models, 'alternate-refiner'])],
          customModels: {
            ...provider.customModels,
            [fixtureModel]: {
              ...provider.customModels?.[fixtureModel],
              name: 'Priced usage fixture',
              modelsDev: {
                name: 'Priced usage fixture',
                cost: { input: 2, output: 4, cache_read: 0.2, cache_write: 3 },
              },
            },
            'alternate-refiner': { name: 'Unpriced usage fixture' },
          },
        },
      },
    }),
  );
  const offsets = new Map();
  const call = async (owner, type, payload = {}, expected = type) => {
    const requestId = crypto.randomUUID();
    await rpc('engine.send', { id: owner, message: { type, payload: { ...payload, requestId } } });
    return waitFor(
      async () => {
        const batch = await rpc('engine.events', { id: owner, offset: offsets.get(owner) ?? 0 });
        offsets.set(owner, batch.offset);
        const frame = batch.events.find(
          (event) =>
            event.payload?.requestId === requestId &&
            (event.type === expected ||
              event.type === 'error' ||
              event.payload?.success === false ||
              event.payload?.error),
        );
        if (!frame) return null;
        if (frame.type === 'error' || frame.payload?.success === false || frame.payload?.error)
          throw Error(frame.payload.error ?? frame.payload.message);
        assert.equal(frame.type, expected);
        return frame.payload;
      },
      'Native usage ' + type,
      45000,
    );
  };
  const openSession = async (title) => {
    const owner = await rpc('session.open', { projectId: project.id, kind: 'agent', title });
    sessionIds.push(owner.id);
    const identity = await waitFor(
      async () => {
        const next = await rpc('engine.identity', { id: owner.id });
        return next.sessionId ? next : null;
      },
      'Usage session engine',
      100000,
    );
    await page.locator('.tree-session').filter({ hasText: title }).click();
    await page.getByRole('textbox', { name: 'Message WrongStack', exact: true }).waitFor();
    await call(
      owner.id,
      'prefs.update',
      { autonomy: 'off', enhanceEnabled: false },
      'key.operation_result',
    );
    return { owner, identity };
  };
  const openUsage = async () => {
    if (
      await page
        .getByRole('region', { name: 'Conversation usage and cost', exact: true })
        .isVisible()
        .catch(() => false)
    )
      return;
    await page
      .getByRole('navigation', { name: 'Agent workspace views' })
      .getByRole('button', { name: 'Tools', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Session tools', exact: true })
      .getByRole('button')
      .filter({ hasText: 'Usage & cost' })
      .click();
    await page.getByRole('region', { name: 'Conversation usage and cost', exact: true }).waitFor();
  };
  const panel = () =>
    page.getByRole('region', { name: 'Conversation usage and cost', exact: true });
  const { owner, identity } = await openSession('Usage owner');
  const send = async (marker, expectedOutput) => {
    await page
      .getByRole('textbox', { name: 'Message WrongStack', exact: true })
      .fill(marker + ' Return only a brief response.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await waitFor(
      async () => {
        const stats = await call(owner.id, 'stats.get', { sessionId: identity.sessionId });
        return stats.usage.output === expectedOutput ? stats : null;
      },
      'Accounted provider usage',
      90000,
    );
  };
  await send('[native-usage-cold]', 5);
  await send('[native-usage-warm]', 25);
  const stats = await call(owner.id, 'stats.get', { sessionId: identity.sessionId });
  assert.equal(stats.usage.input, 220);
  assert.equal(stats.usage.cacheRead, 480);
  assert.equal(stats.cache.last.hitRatio, 0.8);
  assert.ok(Math.abs(stats.cache.hitRatio - 480 / 700) < 1e-8);
  assert.ok(Math.abs(stats.pricing.estimateUsd - 0.000636) < 1e-10);
  assert.equal(stats.pricing.coverage, 'complete');
  await page
    .getByRole('textbox', { name: 'Message WrongStack', exact: true })
    .fill('Preserve this usage-screen draft.');
  await openUsage();
  await panel()
    .getByRole('region', { name: 'Session token totals', exact: true })
    .getByText('725 tokens', { exact: true })
    .waitFor();
  const last = panel().getByRole('article', {
    name: 'Last provider-reported request',
    exact: true,
  });
  await last.getByText('80%', { exact: true }).waitFor();
  assert.match(
    await panel().getByRole('region', { name: 'Session cache behavior', exact: true }).innerText(),
    /68[.,]6%/,
  );
  await panel()
    .getByRole('region', { name: 'Usage estimate', exact: true })
    .getByText('$0.000636', { exact: true })
    .first()
    .waitFor();
  await panel().getByLabel('Live usage updates', { exact: true }).uncheck();
  await panel().getByRole('button', { name: 'Refresh usage', exact: true }).click();
  await panel()
    .getByRole('heading', { name: 'Usage & cost', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifactDir, 'native-session-usage.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await last.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifactDir, 'native-session-usage-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await panel().getByRole('button', { name: 'Back to conversation', exact: true }).click();
  assert.equal(
    await page.getByRole('textbox', { name: 'Message WrongStack', exact: true }).inputValue(),
    'Preserve this usage-screen draft.',
  );
  const other = await openSession('Usage isolated');
  await call(
    other.owner.id,
    'model.switch',
    { provider: 'desktop-local', model: 'alternate-refiner' },
    'model.switch_result',
  );
  await openUsage();
  await panel()
    .getByRole('region', { name: 'Session token totals', exact: true })
    .getByText('0 tokens', { exact: true })
    .waitFor();
  await panel()
    .getByText('No provider-reported request has been recorded.', { exact: true })
    .waitFor();
  const estimate = panel().getByRole('region', { name: 'Usage estimate', exact: true });
  await estimate.getByText('No catalog pricing is available.', { exact: true }).waitFor();
  assert.equal(await estimate.getByText('$0.0000', { exact: true }).count(), 0);
  assert.equal(
    (await call(other.owner.id, 'stats.get', { sessionId: other.identity.sessionId })).pricing
      .estimateUsd,
    null,
  );
  await page.screenshot({
    path: join(artifactDir, 'native-session-usage-unpriced.png'),
    fullPage: true,
  });
  await page.locator('.tree-session').filter({ hasText: 'Usage owner' }).click();
  await openUsage();
  await panel()
    .getByRole('region', { name: 'Session token totals', exact: true })
    .getByText('725 tokens', { exact: true })
    .waitFor();
  assert.equal(
    providerFixture.calls.filter((entry) => entry.usageCase === 'cold' && entry.stream).length,
    1,
  );
  assert.equal(
    providerFixture.calls.filter((entry) => entry.usageCase === 'warm' && entry.stream).length,
    1,
  );
  console.log(
    'PASS: native session usage from real cold/warm provider responses, last-vs-cumulative cache, current-rate estimate, unpriced model distinction, live/manual refresh, draft preservation and two-session isolation',
  );
}
