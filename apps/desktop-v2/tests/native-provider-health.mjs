import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function exerciseNativeProviderHealth({
  page,
  rpc,
  waitFor,
  artifactDir,
  configPath,
  expectWaitingRoom = false,
}) {
  const token = 'native-account-quota-fixture';
  let reads = 0;
  let failGood = false;
  let firstReadAt = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      assert.equal(request.headers.get('authorization'), `Bearer ${token}`);
      reads++;
      firstReadAt ||= Date.now();
      if (new URL(request.url).pathname === '/fail' || failGood)
        return new Response('Fixture unavailable', { status: 503 });
      return Response.json({
        used: 30,
        total: 100,
        reset: Math.floor(Date.now() / 1000) + 3600,
        balance: 12.5,
      });
    },
  });
  let offset = 0;
  const call = async (type, payload = {}) => {
    const requestId = crypto.randomUUID();
    await rpc('profile.send', { message: { type, payload: { ...payload, requestId } } });
    const reply = await waitFor(
      async () => {
        const batch = await rpc('profile.events', { offset });
        offset = batch.offset;
        return batch.events.find((event) => event.payload?.requestId === requestId)?.payload;
      },
      `Native provider health ${type}`,
      60000,
    );
    if (reply.success === false || reply.ok === false || typeof reply.error === 'string')
      throw Error(reply.error ?? reply.message);
    return reply;
  };
  const ids = ['native-quota-good', 'native-quota-failed'];
  const count = (await rpc('snapshot')).sessions.length;
  try {
    for (const id of ids)
      await call('provider.add', {
        id,
        type: 'openai-compatible',
        family: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: token,
        models: ['fixture-model'],
      });
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    // Configure the real supported account-reader contract in this isolated profile.
    for (const [index, id] of ids.entries())
      config.providers[id].quotaEndpoint = {
        url: `http://127.0.0.1:${server.port}/${index ? 'fail' : 'quota'}`,
        used: 'used',
        total: 'total',
        resetAt: 'reset',
        balance: 'balance',
        label: 'Monthly allowance',
        auth: 'bearer',
      };
    await writeFile(configPath, JSON.stringify(config));
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'WrongStack settings', exact: true })
      .click();
    await page
      .getByRole('navigation', { name: 'WrongStack settings sections' })
      .getByRole('button', { name: 'Provider diagnostics', exact: true })
      .click();
    const health = page.getByRole('region', { name: 'Provider diagnostics' });
    await health.getByRole('button', { name: 'Refresh account quotas', exact: true }).click();
    const card = health.getByRole('article', {
      name: 'Quota native-quota-good default',
      exact: true,
    });
    try {
      await card.getByText('30% used', { exact: true }).waitFor({ timeout: 60000 });
    } catch (error) {
      // Preserve only fixture shape metadata, never credentials, if an account read is absent.
      const diagnostic = { reads, providers: [], savedProviderIds: [], quota: null };
      try {
        const current = JSON.parse(await readFile(configPath, 'utf8'));
        diagnostic.providers = ids.map((id, index) => {
          const configured = current.providers?.[id];
          return {
            id,
            configured: !!configured,
            quotaEndpointPresent: !!configured?.quotaEndpoint,
            endpointMatchesFixture:
              configured?.quotaEndpoint?.url ===
              `http://127.0.0.1:${server.port}/${index ? 'fail' : 'quota'}`,
            keyCount: Array.isArray(configured?.apiKeys) ? configured.apiKeys.length : 0,
            directKeyPresent: typeof configured?.apiKey === 'string' && !!configured.apiKey,
          };
        });
        const saved = await call('providers.saved');
        diagnostic.savedProviderIds = (saved.providers ?? []).map((entry) => entry.id);
        const quota = await call('provider.quota.get');
        diagnostic.quota = {
          snapshots: (quota.snapshots ?? []).filter((entry) => ids.includes(entry.providerId)),
          refreshed: quota.refreshed ?? [],
        };
      } catch (failure) {
        diagnostic.diagnosticError = failure instanceof Error ? failure.message : String(failure);
      }
      await writeFile(
        join(artifactDir, 'native-provider-health-diagnostic.json'),
        JSON.stringify(diagnostic, null, 2),
      );
      throw error;
    }
    await card.getByText('$12.50', { exact: true }).waitFor();
    assert.doesNotMatch(await card.innerText(), /Reset: Not reported/);
    assert.equal(reads, 2, 'Both providers use the actual authenticated account-reader path');
    const outcomes = health.getByRole('region', { name: 'Quota refresh results' });
    await outcomes.getByText(/native-quota-failed: Account read failed/).waitFor();
    await health.getByRole('button', { name: 'Refresh account quotas', exact: true }).click();
    await outcomes.getByText(/native-quota-good:.*Recently checked/).waitFor();
    assert.equal(reads, 2, 'Canonical refresh throttle avoids duplicate account HTTP requests');
    await card.getByText('30% used', { exact: true }).waitFor();
    if (expectWaitingRoom) {
      const row = health
        .locator('.provider-health-entries article')
        .filter({ hasText: 'native-health-fixture / blocked-model' });
      await row.getByRole('button', { name: 'Release for next probe', exact: true }).waitFor();
      await row.getByText('Native recorded quota failure', { exact: true }).waitFor();
      await row.getByRole('button', { name: 'Release for next probe', exact: true }).click();
      await health
        .getByRole('status')
        .filter({ hasText: /half-open probe/ })
        .waitFor();
      assert.notEqual(
        (await call('provider.status.get')).statuses.find(
          (entry) => entry.providerId === 'native-health-fixture',
        )?.state,
        'blocked',
      );
      await row.getByRole('button', { name: 'Clear tracked status', exact: true }).click();
      await health.getByRole('button', { name: 'Keep tracked status', exact: true }).click();
      await row.getByRole('button', { name: 'Clear tracked status', exact: true }).click();
      await health
        .getByRole('button', { name: 'Confirm clear tracked status', exact: true })
        .click();
      await health
        .getByRole('status')
        .filter({ hasText: /Cleared tracking/ })
        .waitFor();
      assert.equal(
        (await call('provider.status.get')).statuses.some(
          (entry) => entry.providerId === 'native-health-fixture',
        ),
        false,
      );
    }
    failGood = true;
    // The canonical reader deliberately caches outcomes for 20 seconds.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, firstReadAt + 21000 - Date.now())),
    );
    await health.getByRole('button', { name: 'Refresh account quotas', exact: true }).click();
    await outcomes.getByText(/native-quota-good: Account read failed/).waitFor();
    await card.getByText('30% used', { exact: true }).waitFor();
    assert.equal(
      reads,
      4,
      'A later failed account refresh retains the previously recorded reading',
    );
    await health.getByText(/Recent provider events/).click();
    assert.equal((await health.innerText()).includes('[object Object]'), false);
    await page.screenshot({
      path: join(artifactDir, 'native-provider-health-quota.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 800, height: 640 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: join(artifactDir, 'native-provider-health-compact.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1480, height: 960 });
    assert.equal((await rpc('snapshot')).sessions.length, count);
  } finally {
    try {
      for (const id of ids) {
        const saved = (await call('providers.saved')).providers;
        if (saved.some((item) => item.id === id)) await call('provider.remove', { providerId: id });
      }
    } finally {
      server.stop(true);
    }
  }
  console.log(
    'PASS: native authenticated quota/balance read, reset clock, failed reader, canonical throttle, waiting-room retry/clear and readable audit without conversations',
  );
}
