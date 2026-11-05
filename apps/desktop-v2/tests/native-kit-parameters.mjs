import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Unsent kit parameters survive a renderer reload in native project storage,
 * defer to a newer peer window, and are never applied to a changed contract.
 */
export async function exerciseNativeKitParameters({ page, project, open, directory, artifactDir }) {
  const formKey = `kit-parameters:${createHash('sha256').update('native-kit').digest('hex')}`;
  const ipc = (method, params) =>
    page.evaluate(
      ({ method, params }) => window.__TAURI_INTERNALS__.invoke('host_request', { method, params }),
      { method, params },
    );
  const stored = () => ipc('form-draft.get', { projectId: project.id, formKey });
  const workspace = page.getByRole('region', { name: 'Project Kit workspace' });
  const select = async () => {
    await workspace.getByRole('button', { name: /native-kit/ }).click();
    await workspace.getByRole('heading', { name: 'Native guide' }).waitFor();
  };
  const until = async (check, label) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await check();
      if (value) return value;
      await page.waitForTimeout(100);
    }
    throw Error(`Timed out: ${label}`);
  };
  // Handing a request to a conversation draft clears the parameters that produced it.
  await until(async () => (await stored()).value === null, 'Parameters cleared after handoff');

  await open(project);
  await select();
  await workspace.getByRole('button', { name: 'Add Names item', exact: true }).click();
  await workspace.getByRole('textbox', { name: 'Names 1', exact: true }).fill('durable');
  await workspace.getByRole('checkbox', { name: 'Include options', exact: true }).check();
  await workspace.getByRole('spinbutton', { name: 'Options › Limit', exact: true }).fill('');
  const saved = await until(async () => {
    const draft = await stored();
    return draft.value?.input?.names?.[0] === 'durable' && draft.value.special.length
      ? draft
      : null;
  }, 'Unfinished kit parameters acknowledged');
  assert.deepEqual(saved.value.special, [{ path: ['options', 'limit'], value: 'NaN' }]);

  await page.reload();
  await open(project);
  await select();
  await workspace.getByRole('status').filter({ hasText: 'Restored unsent parameters' }).waitFor();
  assert.equal(
    await workspace.getByRole('textbox', { name: 'Names 1', exact: true }).inputValue(),
    'durable',
  );
  assert.equal(
    await workspace.getByRole('spinbutton', { name: 'Options › Limit', exact: true }).inputValue(),
    '',
    'An unfinished number stays unfinished instead of becoming a value',
  );

  // Another window writes a newer revision; this window's next autosave must stop for review.
  const peer = structuredClone(saved.value);
  peer.input.names = ['peer'];
  const current = await stored();
  await ipc('form-draft.save', {
    projectId: project.id,
    formKey,
    value: peer,
    expectedRevision: current.revision,
  });
  await workspace.getByRole('textbox', { name: 'Names 1', exact: true }).fill('local');
  const conflict = workspace.getByRole('region', { name: 'Kit parameter conflict', exact: true });
  await conflict.waitFor();
  await conflict.getByText('Not entered', { exact: true }).first().waitFor();
  assert.deepEqual(
    (await stored()).value.input.names,
    ['peer'],
    'Peer values were not overwritten',
  );
  await page.screenshot({
    path: join(artifactDir, 'native-kit-parameter-conflict.png'),
    fullPage: true,
  });
  await conflict.getByRole('button', { name: 'Use saved values', exact: true }).click();
  await conflict.waitFor({ state: 'hidden' });
  assert.equal(
    await workspace.getByRole('textbox', { name: 'Names 1', exact: true }).inputValue(),
    'peer',
  );

  // A changed input contract never receives old values silently.
  const manifestPath = join(directory, 'kit.json');
  const original = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(original);
  manifest.inputSchema.properties.title = { type: 'string', default: 'Release' };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await workspace.getByRole('button', { name: 'Refresh kits', exact: true }).click();
  await select();
  const stale = workspace.getByRole('region', { name: 'Saved kit parameters', exact: true });
  await stale.waitFor();
  assert.equal(
    await workspace.getByRole('textbox', { name: 'Names 1', exact: true }).count(),
    0,
    'Defaults are shown until the person chooses to use older values',
  );
  await stale.getByRole('button', { name: 'Discard saved parameters', exact: true }).click();
  await until(async () => (await stored()).value === null, 'Stale parameters discarded');
  await writeFile(manifestPath, original);
  console.log(
    'PASS: native kit parameter drafts: cleared after handoff, reload restore with unfinished numbers, peer-window review and changed-contract refusal',
  );
}
