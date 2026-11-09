import assert from 'node:assert/strict';
import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { resolveWstackPaths } from '../../../packages/core/dist/utils/index.js';
import { loadRuntimeDatabaseSync } from '../../../packages/persistence/dist/index.js';

/** Actual watchdog → native journal → WebView2. Each scenario starts a fresh host,
 * preserving the production cooldown. Refusal/expiry are recorded renderer fixtures.
 */
export async function exerciseNativeServiceHealing({
  page,
  rpc,
  waitFor,
  artifactDir,
  wrongstackHome,
  nativeDataDir,
  scenario,
}) {
  assert(['success', 'failure'].includes(scenario));
  let offset = 0;
  const frames = [];
  const pump = async () => {
    const batch = await rpc('profile.events', { offset });
    offset = batch.offset;
    frames.push(...batch.events);
    return batch.events;
  };
  const call = async (type, payload = {}) => {
    const requestId = crypto.randomUUID();
    await rpc('profile.send', { message: { type, payload: { ...payload, requestId } } });
    return waitFor(
      async () => {
        const reply = (await pump()).find((e) => e.payload?.requestId === requestId)?.payload;
        if (reply?.error || reply?.success === false) throw Error(reply.error ?? reply.message);
        return reply;
      },
      'Native service command ' + type,
      30000,
    );
  };
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'WrongStack settings', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: 'WrongStack settings sections' })
    .getByRole('button', { name: 'Provider diagnostics', exact: true })
    .click();
  const region = () => page.getByRole('region', { name: 'Background services', exact: true });
  await region().waitFor();
  const row = (label) =>
    region()
      .locator('li')
      .filter({ has: page.locator('strong', { hasText: label }) });
  const root = resolve(nativeDataDir);
  const owned = (path) => {
    const absolute = resolve(path);
    assert(
      absolute.toLowerCase().startsWith(root.toLowerCase() + sep),
      'Fault injection remains in the owned native fixture',
    );
    return absolute;
  };
  const initial = await call('connections.health');
  const catalog = initial.services.find((s) => s.id === 'session-catalog');
  assert.equal(catalog.status, 'healthy', 'Actual catalog valid control');
  const projectDir = owned(
    resolveWstackPaths({ projectRoot: initial.projectRoot, globalRoot: wrongstackHome }).projectDir,
  );
  const metadataPath = owned(join(projectDir, '.session-catalog-server.json'));
  const databasePath = owned(catalog.storage);
  const original = await readFile(metadataPath, 'utf8');
  const DB = loadRuntimeDatabaseSync();
  let schema,
    rows,
    restoreToken = false;
  const auto = (phase) =>
    frames.filter(
      (e) =>
        e.type === 'connections.auto_heal_status' &&
        e.payload?.serviceId === 'session-catalog' &&
        e.payload?.phase === phase,
    );
  try {
    if (scenario === 'success') {
      const db = new DB(databasePath);
      try {
        db.exec('PRAGMA busy_timeout=5000');
        schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='catalog_meta'").get().sql;
        rows = db.prepare('SELECT key,value FROM catalog_meta').all();
        db.exec('DROP TABLE catalog_meta');
      } finally {
        db.close();
      }
    } else {
      restoreToken = true;
      await writeFile(
        metadataPath,
        JSON.stringify({ ...JSON.parse(original), authToken: 'invalid-native-fixture-token' }),
      );
    }
    const fault = await call('connections.health');
    assert.equal(
      fault.services.find((s) => s.id === 'session-catalog').status,
      'error',
      'Real fixture fault is a watchdog trigger',
    );
    const phase = scenario === 'success' ? 'restarted' : 'failed';
    await waitFor(
      async () => {
        await pump();
        return auto(phase).length > 0;
      },
      'Actual native automatic restart ' + phase,
      90000,
    );
    assert(auto('restarting').length > 0, 'Automatic admission was journaled');
    const label = phase === 'restarted' ? 'Automatically restarted' : 'Automatic restart failed';
    await row('Session Catalog')
      .getByRole('status')
      .filter({ hasText: label })
      .waitFor({ timeout: 30000 });
    assert.equal(
      await row('Session Catalog')
        .getByRole('button', { name: 'Restart', exact: true })
        .isDisabled(),
      false,
      'Terminal event released native manual control',
    );
    if (scenario === 'success') {
      await waitFor(
        async () =>
          (await row('Session Catalog').locator('span').first().textContent())?.includes(
            '· healthy',
          ),
        'Native health row refreshed after automatic repair',
        20000,
      );
    }
    await row('Session Catalog').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(artifactDir, 'native-auto-heal-' + phase + '.png'),
      fullPage: true,
    });
    let manualRecovery = false;
    if (scenario === 'failure') {
      await writeFile(metadataPath, original);
      restoreToken = false;
      await row('Session Catalog').getByRole('button', { name: 'Restart', exact: true }).click();
      await waitFor(
        async () => {
          await pump();
          return frames.some(
            (e) =>
              e.type === 'connections.service_action_result' &&
              e.payload?.serviceId === 'session-catalog' &&
              e.payload?.success === true &&
              typeof e.payload.requestId === 'string',
          );
        },
        'Native manual recovery acknowledgement',
        45000,
      );
      await waitFor(
        async () =>
          !(await row('Session Catalog')
            .getByRole('button', { name: 'Restart', exact: true })
            .isDisabled()),
        'Manual control released',
      );
      manualRecovery = true;
    }
    const report = await call('connections.health');
    const current = report.services.find((s) => s.id === 'session-catalog');
    assert.equal(current.status, 'healthy');
    assert.notEqual(current.ownerPid, catalog.ownerPid, 'Actual daemon PID replaced');
    await waitFor(
      async () =>
        (await row('Session Catalog').locator('span').first().textContent())?.includes('· healthy'),
      'Native health row shows the healthy replacement',
      20000,
    );
    let recordedPolicyRefusal = false,
      recordedExpiry = false;
    if (scenario === 'failure') {
      const marker = frames.findLast((e) => typeof e.payload?.requestId === 'string')?.payload
        .requestId;
      assert.equal(typeof marker, 'string');
      let journal;
      for (const name of await readdir(nativeDataDir, { recursive: true })) {
        if (!name.endsWith('.events.jsonl')) continue;
        const path = owned(join(nativeDataDir, name));
        if ((await readFile(path, 'utf8')).includes(marker)) {
          journal = path;
          break;
        }
      }
      assert(journal, 'Find actual profile journal by correlated response');
      const recorded = (serviceId, phase, message) => ({
        type: 'connections.auto_heal_status',
        at: Date.now(),
        payload: { serviceId, phase, at: Date.now(), attempt: 2, message },
      });
      const refusal = recorded(
        'session-catalog',
        'refused',
        'Recorded host-policy refusal; no actual native denial occurred',
      );
      await appendFile(journal, JSON.stringify(refusal) + '\n');
      await row('Session Catalog')
        .getByRole('status')
        .filter({ hasText: refusal.payload.message })
        .waitFor();
      assert.equal(
        await row('Session Catalog')
          .getByRole('button', { name: 'Restart', exact: true })
          .isDisabled(),
        false,
      );
      recordedPolicyRefusal = true;
      await row('Session Catalog').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(artifactDir, 'native-auto-heal-recorded-refusal.png'),
        fullPage: true,
      });
      const other = initial.services.find((s) => s.id === 'kanban');
      assert(other);
      const pending = recorded(other.id, 'restarting', 'Recorded missing-terminal-event fixture');
      await appendFile(journal, JSON.stringify(pending) + '\n');
      await row(other.label)
        .getByRole('status')
        .filter({ hasText: pending.payload.message })
        .waitFor();
      assert.equal(
        await row(other.label).getByRole('button', { name: 'Restart', exact: true }).isDisabled(),
        true,
      );
      // Advance only this test WebView's clock; real backend watchdog clocks are untouched.
      await page.evaluate(() => {
        window.__nativeHealingDateNow = Date.now;
        Date.now = () => window.__nativeHealingDateNow() + 120001;
      });
      try {
        await region().getByRole('button', { name: 'Check again', exact: true }).click();
        await row(other.label)
          .getByRole('status')
          .filter({ hasText: 'No recent completion event' })
          .waitFor();
        assert.equal(
          await row(other.label).getByRole('button', { name: 'Restart', exact: true }).isDisabled(),
          false,
        );
        recordedExpiry = true;
        await row(other.label).scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(artifactDir, 'native-auto-heal-recorded-expiry.png'),
          fullPage: true,
        });
      } finally {
        await page.evaluate(() => {
          Date.now = window.__nativeHealingDateNow;
          delete window.__nativeHealingDateNow;
        });
      }
    }
    const result = {
      result: 'PASS',
      scenario,
      actualWatchdogPhases: frames
        .filter(
          (e) =>
            e.type === 'connections.auto_heal_status' && e.payload?.serviceId === 'session-catalog',
        )
        .map((e) => e.payload.phase),
      oldPid: catalog.ownerPid,
      newPid: current.ownerPid,
      health: current.status,
      manualRecovery,
      recordedPolicyRefusal,
      recordedExpiry,
      packagedTransport: true,
    };
    await writeFile(
      join(artifactDir, 'native-service-healing-' + scenario + '.json'),
      JSON.stringify(
        { ...result, events: frames.filter((e) => e.type === 'connections.auto_heal_status') },
        null,
        2,
      ),
    );
    return result;
  } finally {
    if (restoreToken) await writeFile(metadataPath, original);
    if (schema) {
      const db = new DB(databasePath);
      try {
        if (!db.prepare("SELECT name FROM sqlite_master WHERE name='catalog_meta'").get()) {
          db.exec(schema);
          const insert = db.prepare('INSERT OR REPLACE INTO catalog_meta (key,value) VALUES (?,?)');
          for (const value of rows) insert.run(value.key, value.value);
        }
      } finally {
        db.close();
      }
    }
  }
}
