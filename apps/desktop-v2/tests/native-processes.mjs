import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { exerciseNativeSideEffects } from './native-side-effects.mjs';

export async function exerciseNativeProcesses({
  page,
  rpc,
  waitFor,
  project,
  artifactDir,
  configPath,
  sessionIds,
}) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  await writeFile(
    configPath,
    JSON.stringify({
      ...config,
      autonomy: { ...config.autonomy, defaultMode: 'off', enhance: false },
      maxIterations: 3,
      extensions: {
        ...config.extensions,
        'wstack-chimera': { enabled: false },
        'wstack-auto-review': { enabled: false },
      },
    }),
  );
  const offsets = new Map();
  const fixtureRoot = dirname(dirname(dirname(dirname(configPath))));
  const call = async (id, type, payload, replyType) => {
    const requestId = crypto.randomUUID();
    await rpc('engine.send', {
      id,
      message: { type, payload: { ...payload, requestId } },
    });
    return waitFor(
      async () => {
        const batch = await rpc('engine.events', { id, offset: offsets.get(id) ?? 0 });
        offsets.set(id, batch.offset);
        for (const event of batch.events) {
          if (event.type !== 'tool.executed' || event.payload?.name !== 'bash') continue;
          for (const file of event.payload.metadata?.files ?? []) {
            if (
              typeof file !== 'string' ||
              !resolve(file).startsWith(resolve(fixtureRoot) + sep) ||
              !file.endsWith('.log')
            )
              continue;
            try {
              await writeFile(
                join(artifactDir, 'native-process-fixture-output.txt'),
                (await readFile(file, 'utf8')).slice(-65536),
              );
            } catch {
              /* The isolated fixture may not have opened its log yet. */
            }
          }
        }
        const frame = batch.events.find(
          (frame) => frame.type === replyType && frame.payload?.requestId === requestId,
        );
        if (!frame) return null;
        assert.notEqual(frame.payload.success, false, frame.payload.message);
        return frame.payload;
      },
      `Canonical correlated ${type}`,
      15000,
    );
  };
  const list = (id, sessionId) => call(id, 'process.list', { sessionId }, 'process.list');
  const open = async () => {
    await page
      .getByRole('navigation', { name: 'Agent workspace views' })
      .getByRole('button', { name: 'Tools', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Session tools', exact: true })
      .getByRole('button')
      .filter({ hasText: 'Processes' })
      .click();
    await page.getByRole('region', { name: 'Session processes', exact: true }).waitFor();
  };
  const panel = () => page.getByRole('region', { name: 'Session processes', exact: true });
  const owner = await rpc('session.open', {
    projectId: project.id,
    kind: 'agent',
    title: 'Process owner',
  });
  sessionIds.push(owner.id);
  const identity = await waitFor(
    async () => {
      const value = await rpc('engine.identity', { id: owner.id });
      return value.sessionId ? value : null;
    },
    'Process owner engine',
    100000,
  );
  await page.locator('.tree-session').filter({ hasText: 'Process owner' }).click();
  await page.getByRole('textbox', { name: 'Message WrongStack', exact: true }).waitFor();
  await call(
    owner.id,
    'prefs.update',
    { yolo: false, yoloPlus: false, autonomy: 'off' },
    'key.operation_result',
  );
  await open();
  await panel().getByRole('heading', { name: 'No tracked processes.', exact: true }).waitFor();
  assert.equal((await list(owner.id, identity.sessionId)).processes.length, 0);
  await panel().getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Message WrongStack', exact: true })
    .fill(
      '[native-process-start] Start the isolated background process so I can inspect its output and stop it.',
    );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const proc = await waitFor(
    async () => {
      const allow = page
        .locator('.approval-card')
        .getByRole('button', { name: 'Allow once', exact: true })
        .first();
      if ((await allow.count()) && (await allow.isVisible()) && (await allow.isEnabled()))
        await allow.click();
      return (await list(owner.id, identity.sessionId)).processes.find((row) =>
        row.command.includes('native-process-output-ready'),
      );
    },
    'Real approved background tool process reaches its owner registry',
    60000,
  );
  assert.equal(proc.background, true);
  assert.equal(proc.hasOutput, true);
  assert.equal(proc.sessionId, identity.sessionId);
  await open();
  const card = () => panel().locator(`[data-process-pid="${proc.pid}"]`);
  await card().getByRole('button', { name: 'View output', exact: true }).click();
  await waitFor(
    async () => {
      const drawer = panel().getByRole('complementary', {
        name: `Output for PID ${proc.pid}`,
        exact: true,
      });
      if (
        (
          await drawer
            .locator('pre')
            .innerText()
            .catch(() => '')
        ).includes('native-process-output-ready')
      )
        return true;
      const refresh = drawer.getByRole('button', { name: 'Refresh output', exact: true });
      if ((await refresh.count()) && (await refresh.isEnabled())) await refresh.click();
      return false;
    },
    'Explicit log refresh observes the asynchronously started shell output',
    30000,
  );
  await page.screenshot({ path: join(artifactDir, 'native-process-output.png'), fullPage: true });
  const dark = page.getByRole('button', { name: 'Switch to dark mode', exact: true });
  if (await dark.count()) await dark.click();
  await page.screenshot({ path: join(artifactDir, 'native-process-dark.png'), fullPage: true });
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  await panel().getByLabel('Process output line count', { exact: true }).selectOption('200');
  await panel()
    .getByRole('complementary', { name: `Output for PID ${proc.pid}`, exact: true })
    .locator('pre')
    .filter({ hasText: 'native-process-output-ready' })
    .waitFor();
  const other = await rpc('session.open', {
    projectId: project.id,
    kind: 'agent',
    title: 'Other process session',
  });
  sessionIds.push(other.id);
  await waitFor(
    async () => (await rpc('engine.identity', { id: other.id })).sessionId,
    'Other process session ready',
    100000,
  );
  await page.locator('.tree-session').filter({ hasText: 'Other process session' }).click();
  await open();
  await panel().getByRole('heading', { name: 'No tracked processes.', exact: true }).waitFor();
  assert.equal(await panel().locator(`[data-process-pid="${proc.pid}"]`).count(), 0);
  await page.locator('.tree-session').filter({ hasText: 'Process owner' }).click();
  if (!(await panel().count())) await open();
  await card().waitFor();
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(artifactDir, 'native-process-compact.png'), fullPage: true });
  await page.setViewportSize({ width: 1480, height: 960 });
  await card().getByRole('button', { name: 'Terminate process', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Terminate session process', exact: true });
  await review.getByRole('button', { name: 'Keep process running', exact: true }).click();
  assert.equal(
    (await list(owner.id, identity.sessionId)).processes.find((row) => row.pid === proc.pid)
      ?.status,
    'running',
  );
  // The real termination goes through the batch path: select, review the list, confirm.
  const bar = panel().getByRole('toolbar', { name: 'Process selection', exact: true });
  await card().getByLabel(`Select PID ${proc.pid}`, { exact: true }).check();
  await bar.getByText('1 selected', { exact: true }).waitFor();
  await bar.getByRole('button', { name: 'Terminate selected…', exact: true }).click();
  const batch = page.getByRole('dialog', { name: 'Terminate selected processes', exact: true });
  await batch
    .getByRole('list', { name: 'Processes to terminate', exact: true })
    .getByText(`PID ${proc.pid}`, { exact: true })
    .waitFor();
  await batch.getByRole('button', { name: 'Keep processes running', exact: true }).click();
  assert.equal(
    (await list(owner.id, identity.sessionId)).processes.find((row) => row.pid === proc.pid)
      ?.status,
    'running',
  );
  await bar.getByRole('button', { name: 'Terminate selected…', exact: true }).click();
  await batch.getByRole('button', { name: 'Confirm termination of 1', exact: true }).click();
  await batch.waitFor({ state: 'detached' });
  await panel()
    .getByRole('status')
    .filter({ hasText: 'Termination acknowledged for 1 of 1 processes.' })
    .waitFor();
  await waitFor(
    async () =>
      !(await list(owner.id, identity.sessionId)).processes.some((row) => row.pid === proc.pid),
    'Actually terminated fixture disappears from registry',
    30000,
  );
  await waitFor(
    () => {
      try {
        process.kill(proc.pid, 0);
        return false;
      } catch (error) {
        if (error.code === 'ESRCH') return true;
        throw error;
      }
    },
    'Owned fixture OS process actually exited',
    30000,
  );
  await panel().getByRole('heading', { name: 'No tracked processes.', exact: true }).waitFor();
  // The terminated run stays visible as recently ended; no exit status is invented.
  const ended = panel().locator('.process-ended');
  await ended.locator('summary').filter({ hasText: 'Recently ended · 1' }).click();
  await ended
    .getByRole('list', { name: 'Recently ended processes', exact: true })
    .getByText(`PID ${proc.pid}`, { exact: true })
    .waitFor();
  assert.ok((await ended.innerText()).includes('does not report how'));
  assert.equal(page.context().pages().length, 1);
  await exerciseNativeSideEffects({
    page,
    waitFor,
    artifactDir,
    otherTitle: 'Other process session',
    ownerTitle: 'Process owner',
  });
  console.log(
    'PASS: real approved background tool process, registered output tail, session isolation, compact layout, reviewed keep, batch select/review/terminate, actual PID exit and no WebUI frontend',
  );
}
